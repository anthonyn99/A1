"""Track V5: a browser unit's edits are checked, and a failure goes back.

A scripted unit (no browser, no account) edits a scratch folder; the check
is a real command -- Python running check.py -- through check.py's runner.
"""

from __future__ import annotations

import asyncio
import sys

from magi.code.agents import browser
from magi.code.agents.base import Mode, Outcome, Task
from tests.test_code_agents import _Ans, _ScriptedUnit

CHECK = f'"{sys.executable}" check.py'


def _folder(tmp_path):
    root = tmp_path / "copy"
    root.mkdir()
    (root / "calc.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8")
    (root / "check.py").write_text(
        "from calc import add\n"
        "got = add(2, 3)\n"
        "print('add(2, 3) =', got)\n"
        "raise SystemExit(0 if got == 5 else 1)\n", encoding="utf-8")
    return root


def _edit(search, replace):
    return f"```\nFILE: calc.py\n<<<<<<< SEARCH\n{search}\n=======\n{replace}\n>>>>>>> REPLACE\n```\nDone."


def _run(monkeypatch, tmp_path, root, replies, *, check=CHECK, mode=Mode.WRITE):
    from magi.providers import registry
    unit = _ScriptedUnit(replies)
    monkeypatch.setattr(registry, "build_provider", lambda s, u: unit)
    monkeypatch.setattr(browser, "_staging_root", lambda: tmp_path / "stage")
    events = []

    async def emit(e):
        events.append(e)

    task = Task("t1", "Fix add.", root, mode, agent_check=check, agent_check_min=1,
                progress=lambda: ["M calc.py"])
    agent = browser.BrowserUnitAgent("deepseek", "DeepSeek", settings=None)
    res = asyncio.run(agent.run(task, emit=emit, cancel=asyncio.Event()))
    return res, unit, events, task


def test_a_failing_check_goes_back_and_the_fix_passes(tmp_path, monkeypatch):
    root = _folder(tmp_path)
    res, unit, events, task = _run(monkeypatch, tmp_path, root, [
        _Ans(_edit("def add(a, b):", "def add(a, b):  # adds")),          # still wrong
        _Ans(_edit("    return a - b", "    return a + b")),               # the fix
    ])
    assert res.outcome == Outcome.OK and len(unit.asks) == 2
    fix = unit.asks[1]
    assert "THE PROJECT'S CHECK FAILED" in fix["prompt"] and "add(2, 3) = -1" in fix["prompt"]
    assert "exit code 1" in fix["prompt"]
    assert any("return a - b" in body for body in fix["files"].values()), \
        "the file it changed goes back as it is now"
    assert (root / "calc.py").read_text() == "def add(a, b):  # adds\n    return a + b\n"
    notes = [e["text"] for e in events if e["k"] == "note"]
    assert any(n.startswith("Check FAILED (exit 1)") for n in notes)
    assert any(n.startswith("Check passed") for n in notes)
    assert [e for e in events if e["k"] == "tool" and e["name"] == "Run check"]
    assert "Check" in res.tools_used and "Edit" in res.tools_used
    assert task.check_feedback == "", "the feedback is not left on the task"


def test_the_loop_stops_after_two_fixes(tmp_path, monkeypatch):
    root = _folder(tmp_path)
    replies = [_Ans(_edit("def add(a, b):", "def add(a, b):  # 1")),
               _Ans(_edit("def add(a, b):  # 1", "def add(a, b):  # 2")),
               _Ans(_edit("def add(a, b):  # 2", "def add(a, b):  # 3"))]
    res, unit, events, _ = _run(monkeypatch, tmp_path, root, replies)
    assert len(unit.asks) == 1 + browser.CHECK_FIXES and res.outcome == Outcome.OK
    assert any("still fails after 2 rounds" in e.get("text", "") for e in events)


def test_no_check_no_loop_and_read_mode_never_runs_one(tmp_path, monkeypatch):
    root = _folder(tmp_path)
    res, unit, events, _ = _run(monkeypatch, tmp_path, root,
                                [_Ans(_edit("def add(a, b):", "def add(a, b):  # x"))], check="")
    assert len(unit.asks) == 1 and not [e for e in events if e.get("name") == "Run check"]
    res, unit, events, _ = _run(monkeypatch, tmp_path, root, [_Ans("It subtracts.")],
                                mode=Mode.READ)
    assert len(unit.asks) == 1 and not [e for e in events if e.get("name") == "Run check"]


def test_an_answer_without_edits_is_not_checked(tmp_path, monkeypatch):
    root = _folder(tmp_path)
    res, unit, events, _ = _run(monkeypatch, tmp_path, root, [_Ans("Nothing to change.")])
    assert len(unit.asks) == 1 and not [e for e in events if e.get("name") == "Run check"]


def test_the_unit_is_told_up_front_that_its_edits_are_checked(tmp_path, monkeypatch):
    root = _folder(tmp_path)
    _, unit, _, _ = _run(monkeypatch, tmp_path, root, [
        _Ans(_edit("    return a - b", "    return a + b"))])
    assert "MAGI runs the project's check" in unit.asks[0]["prompt"] and CHECK in unit.asks[0]["prompt"]
