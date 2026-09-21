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
import subprocess
import threading
from pathlib import Path

from ... import proc

_EOF = object()


class Stream:
    """A running CLI whose stdout arrives one line at a time."""

    def __init__(self, argv: list[str], *, cwd: Path, env: dict,
                 stdin_text: str | None = None):
        self._loop = asyncio.get_running_loop()
        self._q: asyncio.Queue = asyncio.Queue()
        self.stderr_tail: collections.deque[str] = collections.deque(maxlen=40)
        self.p = proc.popen(
            argv, cwd=str(cwd), env=env,
            stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        if stdin_text is not None:
            # Written from a thread so a large prompt cannot block the event
            # loop on a full pipe while the child is not yet reading.
            def feed():
                try:
                    self.p.stdin.write(stdin_text)
                    self.p.stdin.close()
                except (OSError, ValueError):
                    pass
            threading.Thread(target=feed, daemon=True).start()
        threading.Thread(target=self._pump_out, daemon=True).start()
        # stderr is drained too, not only for the error detail it carries: a
        # pipe nobody reads fills up and blocks the child mid-run.
        threading.Thread(target=self._pump_err, daemon=True).start()

    def _pump_out(self):
        try:
            for line in self.p.stdout:
                self._loop.call_soon_threadsafe(self._q.put_nowait, line)
        except (OSError, ValueError):
            pass
        finally:
            self._loop.call_soon_threadsafe(self._q.put_nowait, _EOF)

    def _pump_err(self):
        try:
            for line in self.p.stderr:
                self.stderr_tail.append(line.rstrip())
        except (OSError, ValueError):
            pass

    async def lines(self, cancel: asyncio.Event):
        """Yield stdout lines until EOF. Returns early (with no error) if
        cancel is set, after killing the process tree."""
        while True:
            get = asyncio.ensure_future(self._q.get())
            stop = asyncio.ensure_future(cancel.wait())
            done, _ = await asyncio.wait({get, stop}, return_when=asyncio.FIRST_COMPLETED)
            if stop in done:
                get.cancel()
                self.kill()
                return
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
