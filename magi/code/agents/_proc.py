"""Run a CLI and stream its stdout lines into asyncio, cancellably.

Why a thread and not asyncio.create_subprocess_exec: on Windows, uvicorn can
run a SelectorEventLoop, and that loop does not support subprocesses at all --
create_subprocess_exec raises NotImplementedError. Reading in a thread and
handing lines across with call_soon_threadsafe works on either loop.

Goes through magi/proc.py's popen, so nothing opens a console window.
"""

from __future__ import annotations

import asyncio
import collections
import queue
import subprocess
import threading
import time
from pathlib import Path

from ... import agent_guard, proc

_EOF = object()
# What `lines(wake=...)` yields when the wake event fires: not a line.
WAKE = object()

# The stall watchdog (from Claude Queue). A CLI that goes SILENT is stuck;
# one that is merely slow is not. Measuring total time instead killed long,
# healthy tasks mid-work (a big refactor, a slow test run), so the clock is
# reset by every line on stdout OR stderr and only a quiet stretch trips it.
# A run that talks forever (a spinner, a loop) never goes quiet, so a
# generous absolute ceiling backs it up. Nothing else ended a hung agent, and
# one hung task holds the whole queue behind it.
STALL_S = 30 * 60
ABSOLUTE_S = 4 * 60 * 60


class Stream:
    """A running CLI whose stdout arrives one line at a time."""

    def __init__(self, argv: list[str], *, cwd: Path, env: dict,
                 stdin_text: str | None = None, keep_stdin: bool = False,
                 stall_s: float | None = None, absolute_s: float | None = None):
        """`keep_stdin`: stdin stays open after `stdin_text`, for more lines
        (`write_line`) until `close_stdin` -- a CLI that is steered while it
        runs. Otherwise stdin closes once `stdin_text` is written."""
        self._loop = asyncio.get_running_loop()
        self._q: asyncio.Queue = asyncio.Queue()
        self.stderr_tail: collections.deque[str] = collections.deque(maxlen=40)
        # Read at call time, so a test can shorten the module constants.
        self.stall_s = STALL_S if stall_s is None else stall_s
        self.absolute_s = ABSOLUTE_S if absolute_s is None else absolute_s
        self._started = time.monotonic()
        # Last sign of life on either pipe. Written from the pump threads; a
        # float assignment is atomic, and a stale read only delays the trip.
        self._alive_at = self._started
        # Why the watchdog ended it ("" = it did not). Callers check this
        # after lines() returns and hand the task on as UNAVAILABLE.
        self.stalled = ""
        self.p = proc.popen(
            argv, cwd=str(cwd), env=env,
            stdin=subprocess.PIPE if (stdin_text is not None or keep_stdin) else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        # Into the agents' job at once, before the shim has started anything:
        # nothing it or its children start may drive the engine (agent_guard).
        agent_guard.adopt(self.p)
        # Everything for stdin goes through one writer thread, in order, so a
        # large prompt cannot block the event loop on a full pipe while the
        # child is not yet reading. None closes it.
        self._wq: queue.Queue = queue.Queue()
        if stdin_text is not None or keep_stdin:
            def feed():
                try:
                    while True:
                        item = self._wq.get()
                        if item is None:
                            break
                        self.p.stdin.write(item)
                        self.p.stdin.flush()
                except (OSError, ValueError):
                    pass
                try:
                    self.p.stdin.close()
                except (OSError, ValueError):
                    pass
            if stdin_text:
                self._wq.put(stdin_text)
            if not keep_stdin:
                self._wq.put(None)
            threading.Thread(target=feed, daemon=True).start()
        threading.Thread(target=self._pump_out, daemon=True).start()
        # stderr is drained too, not only for the error detail it carries: a
        # pipe nobody reads fills up and blocks the child mid-run.
        threading.Thread(target=self._pump_err, daemon=True).start()

    def _pump_out(self):
        try:
            for line in self.p.stdout:
                self._alive_at = time.monotonic()
                self._loop.call_soon_threadsafe(self._q.put_nowait, line)
        except (OSError, ValueError):
            pass
        finally:
            self._loop.call_soon_threadsafe(self._q.put_nowait, _EOF)

    def _pump_err(self):
        try:
            for line in self.p.stderr:
                self._alive_at = time.monotonic()
                self.stderr_tail.append(line.rstrip())
        except (OSError, ValueError):
            pass

    def _overdue(self) -> str:
        """Why the watchdog should end this run now, or ""."""
        now = time.monotonic()
        if now - self._started >= self.absolute_s:
            return f"stalled: still running after {_span(self.absolute_s)}"
        if now - self._alive_at >= self.stall_s:
            return f"stalled: no output for {_span(self.stall_s)}"
        return ""

    def write_line(self, text: str) -> None:
        """One more line on stdin (keep_stdin). Never blocks; a line for a
        child that has gone is dropped."""
        self._wq.put(text if text.endswith("\n") else text + "\n")

    def close_stdin(self) -> None:
        """No more input: a stream-json CLI ends its run when stdin closes."""
        self._wq.put(None)

    async def lines(self, cancel: asyncio.Event, wake: asyncio.Event | None = None):
        """Yield stdout lines until EOF. Returns early (with no error) if
        cancel is set, after killing the process tree -- and likewise when
        the watchdog trips, with `self.stalled` saying why. With `wake`, its
        firing yields WAKE (and clears it) so the caller can act between
        lines."""
        while True:
            if wake is not None and wake.is_set():
                wake.clear()
                yield WAKE
                continue
            get = asyncio.ensure_future(self._q.get())
            stop = asyncio.ensure_future(cancel.wait())
            woke = asyncio.ensure_future(wake.wait()) if wake is not None else None
            # Wake at the soonest moment either clock could run out. stderr
            # moves _alive_at without putting anything on the queue, so a
            # wake-up is re-checked rather than taken as the trip itself.
            now = time.monotonic()
            left = min(self._alive_at + self.stall_s, self._started + self.absolute_s) - now
            done, _ = await asyncio.wait({get, stop} | ({woke} if woke else set()),
                                         timeout=max(0.05, left),
                                         return_when=asyncio.FIRST_COMPLETED)
            if woke is not None:
                woke.cancel()
            if stop in done:
                get.cancel()
                self.kill()
                return
            if woke is not None and woke in done and get not in done:
                stop.cancel()
                get.cancel()
                continue
            if not done:
                stop.cancel()
                get.cancel()
                why = self._overdue()
                if why:
                    self.stalled = why
                    self.kill()
                    return
                continue
            stop.cancel()
            item = get.result()
            if item is _EOF:
                return
            yield item

    def kill(self):
        """The whole tree. A .cmd shim spawns node, and killing only the shim
        leaves the real agent running with nobody listening."""
        try:
            proc.run(["taskkill", "/PID", str(self.p.pid), "/T", "/F"],
                     capture_output=True, timeout=10)
        except Exception:
            try:
                self.p.kill()
            except Exception:
                pass

    async def wait(self) -> int:
        return await self._loop.run_in_executor(None, self.p.wait)


def _span(s: float) -> str:
    """30*60 -> "30 minutes", 4*3600 -> "4 hours"."""
    if s >= 3600 and s % 3600 == 0:
        h = int(s // 3600)
        return f"{h} hour{'' if h == 1 else 's'}"
    if s >= 60:
        m = round(s / 60)
        return f"{m} minute{'' if m == 1 else 's'}"
    n = round(s)
    return f"{n} second{'' if n == 1 else 's'}"
