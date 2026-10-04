"""Codex runs only in its ELEVATED Windows sandbox -- or not at all.

Found 2026-10-04 (Track V), on MAGI's own settings: in the `unelevated`
sandbox a command can DELETE files anywhere the user can -- a scratch file on
the Desktop went, from read-only AND workspace-write -- while writes and
renames outside are denied. A prompt-injected task could delete your files.
In the `elevated` sandbox (Codex's own sandbox users + ACLs + firewall rules)
the same delete is "Access is denied", reads still work everywhere (Codex
reads through its shell, and "Also read" folders by path), and writes still
land in the task's copy. Its firewall rules also keep the sandbox off
127.0.0.1, under the engine's own agent guard.

`elevated` needs a one-time setup per PC, done by Codex itself the first time
it is used, behind ONE Windows admin prompt (UAC) -- Windows lets nothing
create its accounts and firewall rules without that Yes. Nobody has to run
anything for it (Tony, 2026-10-04: "make it so she doesn't"): the check below
IS the setup. Opening Code Mode asks /agents, which starts `ready()` in the
background; on a PC that is not set up, Codex's setup raises the prompt then,
while the person is at the screen, and the check waits up to PROBE_TIMEOUT_S
for the Yes. One sandboxed `echo`, remembered per Codex version (an update
may need the setup again); a No is asked again only after RETRY_FAILED_S.

Nothing ever waits on it: a task that finds a check in progress does not
queue behind it -- Codex is "not ready yet" for that task and the chain hands
on. MAGI never falls back to the unelevated sandbox.
"""

from __future__ import annotations

import subprocess
import tempfile
import threading
import time
from pathlib import Path

from ... import proc

IMPL = "elevated"
PROBE_TIMEOUT_S = 300           # time to answer the Windows prompt
RETRY_FAILED_S = 6 * 3600       # a No (or no answer) is asked again after this
_MARK = "magi-sandbox-ok"
SETUP_COMMAND = "codex sandbox -c windows.sandbox=elevated -- cmd /c echo ready"
SETUP_FILE = r"magi\Codex sandbox setup.cmd"
SETUP_HINT = ("Codex's protected sandbox is not set up on this PC yet. To do it now, "
              f"double-click {SETUP_FILE} in A1 and click Yes on the Windows prompt "
              "(MAGI also asks Windows again by itself in a few hours).")
CHECKING = ("Checking Codex's protected sandbox -- if Windows asks to let Codex make "
            "changes, choose Yes.")

_lock = threading.Lock()
_cache: dict[str, tuple[bool, str, float]] = {}      # version -> (ok, why, at)
# Codex writes this when its setup completes. Newer than a remembered "not
# set up" = it was just done (the double-click file, a Yes): ask again now,
# not in RETRY_FAILED_S.
MARKER = Path.home() / ".codex" / ".sandbox" / "setup_marker.json"


def _marker_at() -> float:
    try:
        return MARKER.stat().st_mtime
    except OSError:
        return 0.0


def _valid(hit) -> bool:
    """A remembered answer still stands: a pass always; a failure until it
    is RETRY_FAILED_S old or the setup has been done since."""
    if not hit:
        return False
    return bool(hit[0]) or (time.time() - hit[2] < RETRY_FAILED_S and _marker_at() <= hit[2])


def probe_argv(exe: str) -> list[str]:
    return [exe, "sandbox", "-c", "sandbox_mode=read-only", "-c", f"windows.sandbox={IMPL}",
            "--", "cmd.exe", "/d", "/c", f"echo {_MARK}"]


def _probe(exe: str, env: dict, timeout: float | None = None) -> tuple[bool, str]:
    """Never longer than the timeout plus a few seconds. Not a plain run():
    on a timeout it kills only the .cmd shim, and then waits for ever on a
    pipe the grandchild (node, codex.exe) still holds. Here the whole tree
    is killed and every wait after that is bounded."""
    limit = PROBE_TIMEOUT_S if timeout is None else timeout
    try:
        p = proc.popen(probe_argv(exe), cwd=tempfile.gettempdir(), env=env,
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    except OSError as e:
        return False, f"Codex's sandbox could not start: {e}"
    try:
        out, _ = p.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        try:
            proc.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            p.kill()
        try:
            p.communicate(timeout=5)
        except (subprocess.TimeoutExpired, ValueError, OSError):
            pass
        return False, SETUP_HINT + " (Nobody answered the Windows prompt.)"
    if _MARK in (out or ""):
        return True, ""
    tail = (out or "").strip().splitlines()[-1:] or [""]
    return False, SETUP_HINT + (f" (Codex said: {tail[0][:200]})" if tail[0] else "")


def ready(exe: str, env: dict, version: str, wait: bool = False) -> tuple[bool, str]:
    """(usable, why not). Cached: a pass for this Codex version for good, a
    failure for RETRY_FAILED_S. One check at a time, and -- unless `wait` --
    a caller that finds one running gets CHECKING at once instead of
    queueing behind a prompt nobody may answer for minutes."""
    hit = _cache.get(version)
    if _valid(hit):
        return hit[0], hit[1]
    if not _lock.acquire(blocking=wait):
        return False, CHECKING
    try:
        hit = _cache.get(version)
        if _valid(hit):
            return hit[0], hit[1]
        ok, why = _probe(exe, env)
        _cache[version] = (ok, why, time.time())
        return ok, why
    finally:
        _lock.release()


def state(version: str) -> dict | None:
    """What is known for this Codex version, without checking: {"ok", "why"}
    or None (not checked yet). For the console, which must never wait."""
    hit = _cache.get(version)
    if hit:
        return {"ok": hit[0], "why": hit[1]}
    return {"ok": None, "why": CHECKING} if _lock.locked() else None


def check_soon(exe: str, env: dict, version: str) -> None:
    """Check in the background if nothing is known yet; the next /agents
    shows the answer. At most one such check at a time."""
    hit = _cache.get(version)
    if _valid(hit) or _lock.locked():
        return
    threading.Thread(target=ready, args=(exe, env, version), daemon=True).start()


TASK_WAIT_S = 10.0


def ready_for_task(exe: str, env: dict, version: str,
                   within: float = TASK_WAIT_S) -> tuple[bool, str]:
    """What a task asks: the known answer, or a check started in the
    background and at most `within` seconds of waiting for it -- a set-up PC
    answers in about half a second; one waiting on its Windows prompt does
    not hold the task, which hands on to the next agent."""
    hit = _cache.get(version)
    if _valid(hit):
        return hit[0], hit[1]
    check_soon(exe, env, version)
    t0 = time.monotonic()
    while time.monotonic() - t0 < within:
        hit = _cache.get(version)
        if _valid(hit):
            return hit[0], hit[1]
        time.sleep(0.2)
    return False, CHECKING


def forget() -> None:
    with _lock:
        _cache.clear()
