"""Start the engine again once the old one has let go.

Run detached by POST /api/restart, which then exits. Nothing here kills
anything: the engine ends itself, and this waits for that to finish before
starting the replacement. A killer would have to be a child of the process it
kills, and `taskkill /t` on the engine would take it down mid-restart.

Two waits, both necessary:
  * the old PID has to be gone, or two engines briefly share one database;
  * port 8000 has to be free, because Windows holds a listening socket for a
    moment after the process owning it exits, and uvicorn cannot bind it until
    then -- the replacement would die on startup with "address in use".
"""

from __future__ import annotations

import socket
import subprocess
import sys
import time
from pathlib import Path

from . import proc

# Windows: no console, and not part of the caller's process tree.
_DETACHED = 0x00000008 | 0x00000200      # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP


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

    deadline = time.monotonic() + 45
    while time.monotonic() < deadline and (_alive(pid) or not _port_free(port)):
        time.sleep(0.5)

    # pythonw so the engine comes back the way the Startup shortcut runs it:
    # no console window, nothing on the taskbar.
    exe = Path(sys.executable)
    windowless = exe.with_name("pythonw.exe")
    if windowless.exists():
        exe = windowless
    proc.popen(
        [str(exe), "-m", "magi", "cloud"],
        cwd=str(cwd),
        creationflags=_DETACHED | proc.NO_WINDOW,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
