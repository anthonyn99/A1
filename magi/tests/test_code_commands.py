"""Track V6: named commands agents may run.

Set on the engine PC only; an agent names one, never writes a command line;
an argument only where allowed and only a plain relative path or word.
"""

from __future__ import annotations

import asyncio
import inspect
import sys

import pytest

from magi.code import commands as CM
from magi.code import routes as R
from magi.code import ws_mcp as W
from magi.code.agents import browser
from magi.code.agents import claude_cli as CC
from magi.code.agents.base import Mode, Outcome, Task
from tests.test_code_agents import _Ans, _ScriptedUnit

PY = f'"{sys.executable}"'


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(CM, "_store", lambda: tmp_path / "commands.json")


def test_the_list_is_validated_and_stored(store):
    got = CM.put("p", [{"name": "Lint", "command": "npm run lint"},
                       {"name": "test-file", "command": "pytest {arg}", "arg": True, "timeout_min": 99}])
    assert [c["name"] for c in got] == ["lint", "test-file"] and got[1]["timeout_min"] == 60
    assert got[0]["arg"] is False and CM.get("p") == got
    for bad in ([{"name": "1x", "command": "a"}], [{"name": "a", "command": ""}],
                [{"name": "a", "command": "x\ny"}], [{"name": "a", "command": "x"}] * 2,
                [{"name": f"c{i}", "command": "x"} for i in range(CM.MAX_COMMANDS + 1)], "lint"):
        with pytest.raises(CM.CommandError):
            CM.put("p", bad)
    assert CM.put("p", []) == [] and CM.get("p") == []


def test_an_argument_only_where_allowed_and_only_a_plain_path():
    plain = {"name": "build", "command": "npm run build", "arg": False, "timeout_min": 5}
    one = {"name": "t", "command": "pytest {arg} -q", "arg": True, "timeout_min": 5}
    tail = {"name": "u", "command": "node test.js", "arg": True, "timeout_min": 5}
    assert CM.render(plain) == "npm run build"
    assert CM.render(one, "tests/test_x.py") == 'pytest "tests/test_x.py" -q'
    assert CM.render(tail, "a\\b.js") == 'node test.js "a/b.js"'
    with pytest.raises(CM.CommandError):
        CM.render(plain, "x")                       # takes none
    with pytest.raises(CM.CommandError):
        CM.render(one)                               # needs one
    for evil in ("x & del /q *", "x;rm -rf /", "$(id)", "`id`", "--config=evil", "-x",
                 "../secret", "a/../../b", "/etc/passwd", "C:/Windows", 'x" & calc "', "x y",
                 "%PATH%", "x|y", "x>y", "a" * 201):
        with pytest.raises(CM.CommandError):
            CM.render(tail, evil)


def test_the_mcp_server_restates_the_same_argument_rule():
    assert W._CMD_ARG.pattern == CM.ARG.pattern


def test_setting_them_is_local_only():
    src = inspect.getsource(R.set_commands)
    assert "_local_only(request)" in src.split('"""', 2)[-1][:200]


# ── Claude: run_command ───────────────────────────────────────────────────

def test_claude_runs_a_named_command_and_nothing_else(tmp_path):
    (tmp_path / "hello.py").write_text("import sys\nprint('hello', sys.argv[1:])\n")
    cmds = [{"name": "hello", "command": f"{PY} hello.py", "arg": True, "timeout_min": 1}]
    s = W.Server(tmp_path, commands=cmds)
    assert "run_command" in [t["name"] for t in s.tools()]
    txt, err = s.call("run_command", {"name": "hello", "arg": "src/a.py"})
    assert not err and "PASSED" in txt and "hello ['src/a.py']" in txt
    for args in ({"name": "nope"}, {"name": "hello", "arg": "x & calc"},
                 {"name": "hello", "arg": "-rf"}, {"name": "hello", "arg": "../x"}):
        assert s.call("run_command", args)[1], args
    assert "run_command" not in [t["name"] for t in W.Server(tmp_path).tools()]
    assert W.Server(tmp_path).call("run_command", {"name": "hello"})[1]


def test_claude_is_told_which_commands_exist():
    t = Task("t", "q", tmp := __import__("pathlib").Path("."), Mode.WRITE,
             mcp_servers=(CC.WS_SERVER,),
             agent_commands=[{"name": "lint", "command": "x", "arg": False}])
    f = CC.write_frame(t)
    assert "run_command" in f and "lint" in f and "not part of this mode" not in f


# ── browser units: RUN: ───────────────────────────────────────────────────

def _run(monkeypatch, tmp_path, root, replies, cmds):
    from magi.providers import registry
    unit = _ScriptedUnit(replies)
    monkeypatch.setattr(registry, "build_provider", lambda s, u: unit)
    monkeypatch.setattr(browser, "_staging_root", lambda: tmp_path / "stage")
    events = []

    async def emit(e):
        events.append(e)

    task = Task("t1", "Is the build green?", root, Mode.WRITE, agent_commands=cmds)
    res = asyncio.run(browser.BrowserUnitAgent("deepseek", "DeepSeek", settings=None)
                      .run(task, emit=emit, cancel=asyncio.Event()))
    return res, unit, events, task


def test_a_unit_asks_to_run_a_command_and_gets_the_output(tmp_path, monkeypatch):
    root = tmp_path / "copy"
    root.mkdir()
    (root / "build.py").write_text("print('BUILD OK 42')\n")
    cmds = [{"name": "build", "command": f"{PY} build.py", "arg": False, "timeout_min": 1}]
    res, unit, events, task = _run(monkeypatch, tmp_path, root, [
        _Ans("RUN: build\nRUN: nope", ok=False),
        _Ans("The build prints BUILD OK 42, so it is green."),
    ], cmds)
    assert res.outcome == Outcome.OK and len(unit.asks) == 2
    assert "RUN: build" in unit.asks[0]["prompt"].split("TASK:")[0] or "`RUN: name`" in unit.asks[0]["prompt"]
    second = unit.asks[1]["prompt"]
    assert "RESULTS OF THE COMMANDS" in second and "BUILD OK 42" in second
    assert "refused: There is no command called nope" in second
    assert {"k": "tool", "name": "Run", "target": "build"} in events
    assert "Run" in res.tools_used and task.run_results == ""


def test_run_lines_are_ignored_without_commands_or_in_read_mode(tmp_path, monkeypatch):
    root = tmp_path / "copy"
    root.mkdir()
    res, unit, events, _ = _run(monkeypatch, tmp_path, root, [_Ans("RUN: build")], [])
    assert len(unit.asks) == 1 and not [e for e in events if e.get("name") == "Run"]


def test_an_answer_that_mentions_run_is_still_an_answer():
    long = "Here is the plan.\n" + "Some explanation. " * 40 + "\nRUN: build"
    rest = browser._RUN.sub("", long)
    assert browser._parse_runs(long) == [("build", "")] and not browser._is_request(rest)
    assert browser._parse_runs("RUN: test tests/a.py\nRUN: test tests/a.py") == [("test", "tests/a.py")]


def test_claude_s_run_command_reads_as_the_command_name_in_the_transcript():
    assert CC._target({"name": "build"}) == "build"
    assert CC._target({"name": "test", "arg": "tests/a.py"}) == "test tests/a.py"
    assert CC._target({"path": "x.py"}) == "x.py"
