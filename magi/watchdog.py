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
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from . import proc
from .settings import ROOT, data_dir, resolve_profile, set_active_profile

# This module is its own entrypoint (`-m magi.watchdog`), so it never passes
# through __main__.py and has to choose its profile itself -- BEFORE any path
# below is derived, or it would watch one profile's engine while logging to
# another's directory.
_CLI_PROFILE = None
for _i, _a in enumerate(sys.argv[1:]):
    if _a == "--profile" and _i + 2 <= len(sys.argv[1:]):
        _CLI_PROFILE = sys.argv[_i + 2]
    elif _a.startswith("--profile="):
        _CLI_PROFILE = _a.split("=", 1)[1]
set_active_profile(resolve_profile(_CLI_PROFILE))

# Looked up when used, never at import: the module is imported before
# --profile is applied, so an import-time path was TONY's for every engine
# -- a veda engine wrote its tunnel record over his (found 2026-09-24).
def _log() -> Path:
    return data_dir() / "watchdog.log"
# The scheduled task that owns the engine (see cli/serve.py autostart).
# Per profile, and Tony keeps the original names: he already has these two
# tasks registered, and renaming them would leave an orphan running the old
# command line while a new one registered beside it.
def _suffix() -> str:
    from .settings import DEFAULT_PROFILE, active_profile

    p = active_profile()
    return "" if p == DEFAULT_PROFILE else f" ({p})"


def task_engine() -> str:
    return "MAGI Engine" + _suffix()


def task_watchdog() -> str:
    return "MAGI Watchdog" + _suffix()


def _configured_port(default: int = 8000) -> int:
    try:
        rec = json.loads((data_dir() / "engine.json").read_text(encoding="utf-8"))
        return int(rec.get("port") or default)
    except Exception:
        return default
# Detached and in its own group, so the engine does not die with this process.
_DETACHED = 0x00000008 | 0x00000200
_BREAKAWAY = 0x01000000          # CREATE_BREAKAWAY_FROM_JOB


def _say(line: str) -> None:
    _log().parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().isoformat(timespec="seconds")
    # Kept small: this runs forever, and a log nobody trims is a log nobody
    # reads. Only the last ~200 lines are of any use.
    try:
        old = _log().read_text(encoding="utf-8", errors="replace").splitlines()[-200:]
    except OSError:
        old = []
    _log().write_text("\n".join(old + [f"{stamp}  {line}"]) + "\n", encoding="utf-8")


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


def engine_args(port: int | None = None) -> list[str]:
    """The ONE command line that starts this profile's engine.

    Every place that starts an engine without Task Scheduler uses this: a
    bare `magi cloud` is Tony's profile on port 8000 on ANY machine, which on
    Veda's PC would have started his engine instead of hers (found checking
    her autostart, 2026-09-24).
    """
    from .settings import DEFAULT_PROFILE, active_profile

    p = active_profile()
    args = ["-m", "magi", "cloud", "--port", str(port or _configured_port())]
    return args if p == DEFAULT_PROFILE else [*args, "--profile", p]


def start() -> None:
    """Ask Task Scheduler to run the engine task; spawn it directly only if
    that is not possible.

    NOT a plain child process. Task Scheduler puts every task in a job object
    and kills what is left of that job when the task's action exits -- so an
    engine started as a child of this watchdog was killed the moment the
    watchdog finished. Observed exactly that: "engine is up", then nothing
    listening seconds later. Starting the engine's OWN task hands it to the
    scheduler as a task in its own right, and IgnoreNew means asking twice is
    harmless.
    """
    if os.name == "nt":
        try:
            r = proc.run(["schtasks", "/run", "/tn", task_engine()],
                         capture_output=True, text=True, timeout=20)
            if r.returncode == 0:
                return
        except Exception:  # noqa: BLE001 — fall through to the direct start
            pass
    proc.popen(
        [str(engine_exe()), *engine_args()],
        cwd=str(ROOT.parent),
        # BREAKAWAY_FROM_JOB so a direct start is not killed with this process
        # either, where the job allows it.
        creationflags=_DETACHED | _BREAKAWAY | proc.NO_WINDOW,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def main(port: int | None = None) -> int:
    # Each profile's engine has its own port, recorded when it was onboarded.
    if port is None:
        port = _configured_port()
    if healthy(port):
        # Up. Keep it current: pull what has been pushed and restart it when
        # its code is stale -- only ever while it is idle (selfupdate.tick).
        try:
            from . import selfupdate
            note = selfupdate.tick(port)
            if note not in ("current", "settling"):
                _say(f"update: {note}")
        except Exception as e:  # noqa: BLE001 — the watchdog must never die of this
            _say(f"update check failed: {e}")
        return 0
    # Checked twice, a few seconds apart: an engine in the middle of starting
    # (or restarting itself) is not a dead one, and starting a second engine
    # would leave two on one database.
    time.sleep(5)
    if healthy(port):
        return 0
    _say("engine not answering -- starting it")
    # A crashed engine may be one a pushed fix would cure.
    try:
        from . import selfupdate
        selfupdate.update_checkout()
    except Exception:  # noqa: BLE001
        pass
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
