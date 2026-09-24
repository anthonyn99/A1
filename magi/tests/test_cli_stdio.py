"""The engine must start whatever its stdout is.

`magi serve` prints "MAGI → http://…". With stdout piped or sent to NUL,
Python on Windows encodes it as cp1252, and the arrow raised
UnicodeEncodeError before the engine started -- which is how the veda engine
in magi-models.live.js (spawned with stdio 'ignore') never came up.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

A1 = Path(__file__).resolve().parents[2]
CODE = "from magi.__main__ import _safe_stdio; _safe_stdio(); print('MAGI \\u2192 up'); print('ok')"


def _run(code: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"}
    return subprocess.run([sys.executable, "-c", code], cwd=A1, env=env,
                          capture_output=True, timeout=60)


def test_a_cp1252_stdout_does_not_kill_the_engine():
    r = _run(CODE)
    assert r.returncode == 0, r.stderr.decode(errors="replace")[-400:]
    assert b"ok" in r.stdout


def test_without_it_the_same_print_does_fail():
    """Proves the environment above really reproduces the crash."""
    r = _run(CODE.replace("_safe_stdio(); ", ""))
    assert r.returncode != 0 and b"UnicodeEncodeError" in r.stderr
