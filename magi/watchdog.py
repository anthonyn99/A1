"""Start the engine if it is not running. Run every couple of minutes.

The Startup shortcut fired once at logon and that was the whole story: if the
engine died -- a crash, a bad import after an edit, a reboot that raced the
network -- MAGI stayed down until someone noticed. That is exactly what
happened on 2026-09-19: the laptop was restarted, the engine never came up,
and nothing tried again.

So "is it up?" is asked on a timer instead. The check is one loopback request,
and starting is the same detached pythonw the logon task uses.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from . import proc
from .settings import ROOT

LOG = ROOT / "data" / "watchdog.log"
# Detached and in its own group, so the engine does not die with this process.
_DETACHED = 0x00000008 | 0x00000200


def _say(line: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().isoformat(timespec="seconds")
    # Kept small: this runs forever, and a log nobody trims is a log nobody
    # reads. Only the last ~200 lines are of any use.
    try:
        old = LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-200:]
    except OSError:
        old = []
    LOG.write_text("\n".join(old + [f"{stamp}  {line}"]) + "\n", encoding="utf-8")


def healthy(port: int = 8000, timeout: float = 4) -> bool:
    """Is a MAGI engine answering on this port?

    A 401 counts: a token-gated engine is a healthy engine.
    """
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=timeout
        ) as r:
            json.loads(r.read().decode("utf-8", "replace"))
        return True
    except urllib.error.HTTPError:
        return True
    except (OSError, ValueError):
        return False


def engine_exe() -> Path:
    """The venv's pythonw -- the interpreter with MAGI's dependencies, and no
    console window."""
    pyw = ROOT / ".venv" / "Scripts" / "pythonw.exe"
    if pyw.exists():
        return pyw
    return Path(sys.executable)


def start() -> None:
    proc.popen(
        [str(engine_exe()), "-m", "magi", "cloud"],
        cwd=str(ROOT.parent),
        creationflags=_DETACHED | proc.NO_WINDOW,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def main(port: int = 8000) -> int:
    if healthy(port):
        return 0
    # Checked twice, a few seconds apart: an engine in the middle of starting
    # (or restarting itself) is not a dead one, and starting a second engine
    # would leave two on one database.
    time.sleep(5)
    if healthy(port):
        return 0
    _say("engine not answering — starting it")
    start()
    for _ in range(40):
        time.sleep(1.5)
        if healthy(port):
            _say("engine is up")
            return 0
    _say("engine still not answering 60s after starting it")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
