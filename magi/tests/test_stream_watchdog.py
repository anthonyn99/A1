"""The coding agents' stall watchdog (_proc.Stream), against real processes.

From Claude Queue: a CLI that goes SILENT is stuck, one that is merely slow
is not -- so the clock resets on every line (stdout or stderr) and only a
quiet stretch trips it, with an absolute ceiling behind it for a run that
talks forever. Short limits here; the real ones are 30 minutes and 4 hours.
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

from magi.code.agents import _proc
from magi.code.agents._proc import Stream

PY = sys.executable


def _run(code: str, **kw) -> tuple[list[str], Stream, float]:
    async def go():
        s = Stream([PY, "-u", "-c", code], cwd=Path("."), env=None, **kw)
        got = [ln.rstrip() async for ln in s.lines(asyncio.Event())]
        await s.wait()
        return got, s
    t0 = time.monotonic()
    got, s = asyncio.run(go())
    return got, s, time.monotonic() - t0


def test_the_real_limits_are_thirty_minutes_and_four_hours():
    assert _proc.STALL_S == 30 * 60 and _proc.ABSOLUTE_S == 4 * 60 * 60
    assert _proc._span(_proc.STALL_S) == "30 minutes"
    assert _proc._span(_proc.ABSOLUTE_S) == "4 hours"
    assert _proc._span(1) == "1 second"


def test_a_silent_process_is_ended_and_says_why():
    got, s, took = _run("import time; print('hello'); time.sleep(60)", stall_s=5.0)
    assert got == ["hello"], "what it said before going quiet still arrives"
    assert s.stalled == "stalled: no output for 5 seconds"
    assert s.p.poll() is not None, "the process tree is killed"
    assert took < 25


def test_a_slow_but_talking_process_is_left_alone():
    code = "import time\nfor i in range(5):\n    print(i); time.sleep(1.0)"
    got, s, _ = _run(code, stall_s=3.0)
    assert got == [str(i) for i in range(5)]
    assert s.stalled == "", "5s of work at 1s a line is never quiet for 3s"


def test_stderr_counts_as_a_sign_of_life():
    # Progress on stderr only (a build, a test runner): not a stall.
    code = ("import sys, time\nfor i in range(5):\n"
            "    sys.stderr.write(f'progress {i}\\n'); sys.stderr.flush(); time.sleep(1.0)\n"
            "print('done')")
    got, s, _ = _run(code, stall_s=3.0)
    assert got == ["done"] and s.stalled == ""
    assert "progress 4" in s.stderr_tail


def test_a_process_that_never_stops_talking_meets_the_ceiling():
    code = "import time\nwhile True:\n    print('.'); time.sleep(0.1)"
    got, s, took = _run(code, stall_s=20.0, absolute_s=6.0)
    assert s.stalled == "stalled: still running after 6 seconds"
    assert len(got) > 3 and took < 25
    assert s.p.poll() is not None


def test_cancel_still_wins_and_is_not_a_stall():
    async def go():
        s = Stream([PY, "-u", "-c", "import time; time.sleep(60)"], cwd=Path("."), env=None,
                   stall_s=30.0)
        cancel = asyncio.Event()
        asyncio.get_running_loop().call_later(0.3, cancel.set)
        got = [ln async for ln in s.lines(cancel)]
        await s.wait()
        return got, s
    got, s = asyncio.run(go())
    assert got == [] and s.stalled == ""
    assert s.p.poll() is not None
