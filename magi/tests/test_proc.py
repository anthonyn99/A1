"""Nothing may spawn a process that can flash a console window.

Hitting Convene strobed the desktop with black windows for several seconds:
launching a provider shelled out to PowerShell twice (find a Chrome holding
the profile, read Chrome's version), and a run launches four providers.

That is not cosmetic. MAGI's premise is that runs are INVISIBLE -- the four
browsers are headless precisely so a run does not take over the machine -- and
the plumbing around them undid it.

This guards the fix structurally: the package may not call subprocess
directly, so a new call site cannot reintroduce the flashing by forgetting a
flag.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi import proc  # noqa: E402

PKG = Path(__file__).resolve().parents[1]
DIRECT_CALL = re.compile(r"\bsubprocess\.(run|Popen|call|check_output|check_call)\b")


def _sources():
    for path in PKG.rglob("*.py"):
        parts = set(path.parts)
        if ".venv" in parts or "tests" in parts or path.name == "proc.py":
            continue
        yield path


def test_no_module_calls_subprocess_directly():
    offenders = []
    for path in _sources():
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if DIRECT_CALL.search(line):
                offenders.append(f"{path.relative_to(PKG)}:{i}: {line.strip()}")
    assert not offenders, (
        "these must go through magi.proc, which sets CREATE_NO_WINDOW:\n  "
        + "\n  ".join(offenders)
    )


def test_helpers_suppress_the_console_window():
    """On Windows the flag must be real; elsewhere it is 0 and harmless."""
    if sys.platform == "win32":
        assert proc.NO_WINDOW == subprocess.CREATE_NO_WINDOW
        assert proc.NO_WINDOW != 0
    else:
        assert proc.NO_WINDOW == 0


def test_an_explicit_creationflags_still_wins():
    """setdefault, not overwrite -- a caller with its own flags keeps them."""
    r = proc.run([sys.executable, "-c", "pass"], creationflags=0, capture_output=True)
    assert r.returncode == 0
