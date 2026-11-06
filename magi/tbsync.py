"""Keep TradeBoard's Webull sync on the code on disk, with no restart by hand.

Veda's PC runs V1/TradeBoard's Webull sync (wb_boot.py, or the older
wb_server.py launcher) for days at a time. It loads wb_sync.py once, so a
pushed change to it (2026-11-06: orders, history and cash activity for the
Portfolio) did nothing until someone restarted it. Tony's own programs update
themselves; this makes hers do the same.

The watchdog calls tick() every couple of minutes, right after its own pull:
when a running sync started before its folder's wb_*.py last changed, it is
stopped and wb_boot.py (the same headless sync, no window, no browser) is
started from that folder. Nothing happens on a PC that doesn't run the sync,
and nothing while the code is still changing (a pull in progress).
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

from . import proc

SETTLE_S = 60          # the newest wb_*.py must be this old before a restart
_PS = (
    "$p = Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | "
    "Where-Object { $_.CommandLine -match 'wb_(boot|server)\\.py' } | "
    "ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; cmd = $_.CommandLine; exe = $_.ExecutablePath; "
    "start = ([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds() } }; "
    "if ($p) { @($p) | ConvertTo-Json -Compress }"
)


def _procs() -> list[dict]:
    """Running syncs: [{pid, cmd, exe, start}] (start = unix seconds)."""
    out = (proc.powershell(_PS, timeout=20) or "").strip()
    if not out:
        return []
    data = json.loads(out)
    return data if isinstance(data, list) else [data]


def _script_dir(cmd: str) -> Path | None:
    """The folder of the wb_*.py a command line runs."""
    for part in (cmd or "").replace('"', " ").split():
        if part.lower().endswith(("wb_boot.py", "wb_server.py")):
            p = Path(part)
            if p.is_file():
                return p.parent
    return None


def _code_mtime(folder: Path) -> float:
    return max((f.stat().st_mtime for f in folder.glob("wb_*.py")), default=0.0)


def _pythonw(exe: str | None) -> str:
    """pythonw beside the interpreter it was running under (no console window)."""
    if exe:
        w = Path(exe).with_name("pythonw.exe")
        if w.is_file():
            return str(w)
        if Path(exe).is_file():
            return exe
    return "pythonw"


def _kill(pid: int) -> None:
    proc.run(["taskkill", "/PID", str(int(pid)), "/F", "/T"], capture_output=True, timeout=20)


def _start(folder: Path, exe: str | None) -> None:
    detached = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
    breakaway = getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)
    subprocess.Popen([_pythonw(exe), str(folder / "wb_boot.py")], cwd=str(folder),
                     creationflags=detached | breakaway | proc.NO_WINDOW,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def tick(now: float | None = None, procs=None, kill=None, start=None) -> str:
    """One watchdog pass. '' when there was nothing to do, else a short note."""
    if os.name != "nt" and procs is None:
        return ""
    now = time.time() if now is None else now
    try:
        running = _procs() if procs is None else procs
    except Exception:  # noqa: BLE001 — the watchdog must never die of this
        return ""
    kill = kill or _kill
    start = start or _start
    stale: dict[Path, list[dict]] = {}
    for p in running:
        folder = _script_dir(p.get("cmd", ""))
        if not folder:
            continue
        newest = _code_mtime(folder)
        if newest and float(p.get("start") or 0) < newest - 5 and now - newest >= SETTLE_S:
            stale.setdefault(folder, []).append(p)
    notes = []
    for folder, ps in stale.items():
        for p in ps:
            kill(p["pid"])
        start(folder, ps[0].get("exe"))
        notes.append(f"restarted TradeBoard's Webull sync for new code ({folder})")
    return "; ".join(notes)
