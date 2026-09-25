"""Start the engine again once the old one has let go.

Run detached by POST /api/restart, which then exits. Nothing here kills
anything: the engine ends itself, and this waits for that to finish before
starting the replacement. A killer would have to be a child of the process it
kills, and `taskkill /t` on the engine would take it down mid-restart.

Two waits, both necessary:
  * the old PID has to be gone, or two engines briefly share one database;
  * the engine's port has to be free, because Windows holds a listening socket for a
    moment after the process owning it exits, and uvicorn cannot bind it until
    then -- the replacement would die on startup with "address in use".
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from . import proc
from .watchdog import task_engine

# Windows: no console, and not part of the caller's process tree.
_DETACHED = 0x00000008 | 0x00000200      # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
_BREAKAWAY = 0x01000000                  # CREATE_BREAKAWAY_FROM_JOB


def _alive(pid: int) -> bool:
    try:
        out = proc.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except Exception:
        return False
    return str(pid) in out


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def main(argv: list[str]) -> int:
    pid = int(argv[0])
    port = int(argv[1]) if len(argv) > 1 else 8000
    cwd = Path(argv[2]) if len(argv) > 2 else Path(__file__).resolve().parents[1]
    # Whose engine. Without it this restarted Tony's -- his task name, and a
    # bare `magi cloud` -- on any machine, Veda's included.
    from .settings import DEFAULT_PROFILE, set_active_profile
    profile = set_active_profile(argv[3] if len(argv) > 3 else DEFAULT_PROFILE)

    deadline = time.monotonic() + 45
    while time.monotonic() < deadline and (_alive(pid) or not _port_free(port)):
        time.sleep(0.5)

    # Still held by something else: starting now would put two engines on one
    # database, and the loser would sit there as a ghost opening its own
    # tunnel. Better to leave the one that IS serving alone.
    if not _port_free(port) and not _alive(pid):
        return 1

    # The console's "Restart engine" picks up everything, not just the code
    # already on disk: pull what has been pushed and install any new package
    # first. Best effort -- a failed pull still restarts on the code we have.
    try:
        from . import selfupdate
        selfupdate.update_checkout()
    except Exception:  # noqa: BLE001
        pass

    # Hand it back to Task Scheduler where possible: the engine runs as the
    # "MAGI Engine" task, and a task's leftover children are killed when the
    # task ends -- so a replacement started as a plain child of this process
    # can be killed with it. Starting the task gives the engine its own life.
    if os.name == "nt":
        try:
            r = proc.run(["schtasks", "/run", "/tn", task_engine()],
                         capture_output=True, text=True, timeout=20)
            if r.returncode == 0:
                return 0
        except Exception:  # noqa: BLE001 — fall through to the direct start
            pass

    # The VENV's pythonw: no console window, nothing on the taskbar, and the
    # interpreter that actually has MAGI's dependencies. sys.executable alone
    # was wrong -- the venv's pythonw re-execs the base interpreter, so a
    # restart started the SYSTEM Python and every later restart inherited it.
    exe = cwd / "magi" / ".venv" / "Scripts" / "pythonw.exe"
    if not exe.exists():
        fallback = Path(sys.executable)
        exe = fallback.with_name("pythonw.exe")
        if not exe.exists():
            exe = fallback
    extra = [] if profile == DEFAULT_PROFILE else ["--profile", profile]
    proc.popen(
        [str(exe), "-m", "magi", "cloud", "--port", str(port), *extra],
        cwd=str(cwd),
        creationflags=_DETACHED | _BREAKAWAY | proc.NO_WINDOW,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
