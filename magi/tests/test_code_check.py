"""The project check command (code/check.py) and its place on the approval card.

From Claude Queue: a real exit code beside the diff. These pin what it may
do (run in the private copy, never the folder; bounded; its own job; no
secrets), who may set it (this PC only, never synced), and how it sits with
the approval (Run check holds the clock, then hands a full window back).
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from magi.code import check as C
from magi.code import sandbox as SB
from magi.code import tasks as T
from magi.code.agents import chain
from magi.code.agents.base import CodingAgent, Mode, Outcome, Result

PY = f'"{sys.executable}"'


# ── the setting ─────────────────────────────────────────────────────────────

@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(C, "_store", lambda: tmp_path / "checks.json")
    return tmp_path / "checks.json"


def test_a_command_is_stored_validated_and_removed(store):
    assert C.get("p1") == {"command": "", "auto": False, "timeout_min": 10, "agents": False}
    c = C.put("p1", "  npm test  ", True, 999)
    assert c == {"command": "npm test", "auto": True, "timeout_min": C.MAX_TIMEOUT_MIN,
                 "agents": False}
    assert C.get("p1") == c
    assert C.put("p1", "npm test", True, 0)["timeout_min"] == 1
    assert C.put("p1", "npm test", "yes", "x")["timeout_min"] == C.DEFAULT_TIMEOUT_MIN
    C.put("p1", "")                                   # empty = off
    assert C.get("p1")["command"] == "" and "p1" not in json.loads(store.read_text())


@pytest.mark.parametrize("bad", ["a\nb", "a\rb", "x\x00", "y" * (C.MAX_COMMAND + 1)])
def test_a_bad_command_is_refused_in_words(store, bad):
    with pytest.raises(C.CheckError):
        C.put("p1", bad)


def test_auto_without_a_command_is_off(store):
    assert C.clean("", True, 10)["auto"] is False


def test_letting_agents_run_it_is_stored_and_needs_a_real_true(store):
    """Track V: `agents` lets the coding agents run the check themselves.
    Only a JSON true switches it on -- "yes", 1 and "false" do not -- and
    never without a command."""
    assert C.put("p1", "npm test", False, 10, True)["agents"] is True
    assert C.get("p1")["agents"] is True
    for v in ("yes", 1, "false", None):
        assert C.put("p1", "npm test", False, 10, v)["agents"] is False
    assert C.clean("", False, 10, agents=True)["agents"] is False
    assert C.put("p1", "npm test")["agents"] is False      # the default


def test_a_hand_edited_bad_store_reads_as_no_check(store):
    store.write_text(json.dumps({"p1": {"command": "a\nb", "auto": True, "agents": True}}),
                     encoding="utf-8")
    assert C.get("p1") == {"command": "", "auto": False, "timeout_min": 10, "agents": False}
    store.write_text("not json", encoding="utf-8")
    assert C.get("p1")["command"] == ""


def test_forget(store):
    C.put("p1", "npm test")
    C.forget("p1")
    assert C.get("p1")["command"] == ""


def test_it_never_syncs():
    from magi.code import sync
    assert not any("check" in k.lower() for k in sync._PREF_TYPES)


# ── suggestions ─────────────────────────────────────────────────────────────

def test_suggestions_come_from_the_folder(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {
        "test": "vitest run", "build": "vite build",
        "lint": "echo \"Error: no test specified\" && exit 1"}}), encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    (tmp_path / ".venv" / ("Scripts" if os.name == "nt" else "bin")).mkdir(parents=True)
    got = [s["command"] for s in C.suggest(tmp_path)]
    assert got[0] == "npm test" and "npm run build" in got
    assert not any("lint" in g for g in got), "a placeholder script is not a check"
    assert any("-m pytest -q" in g and ".venv" in g for g in got)
    assert all(s["why"] for s in C.suggest(tmp_path))
    assert C.suggest(tmp_path / "missing") == []


def test_a_javascript_tests_folder_is_not_offered_pytest(tmp_path):
    # A1's tests/ is JavaScript: pytest there is a command that fails.
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "run-all.js").write_text("", encoding="utf-8")
    assert not any("pytest" in s["command"] for s in C.suggest(tmp_path))
    (tmp_path / "tests" / "test_x.py").write_text("", encoding="utf-8")
    assert any("pytest" in s["command"] for s in C.suggest(tmp_path))


# ── running it ──────────────────────────────────────────────────────────────

def _run(cmd, cwd, timeout_s=60, stop=None):
    return asyncio.run(C.run(cmd, cwd, timeout_s, stop=stop))


def test_a_passing_and_a_failing_command(tmp_path):
    ok = _run(f'{PY} -c "print(123)"', tmp_path)
    assert ok["ok"] and ok["code"] == 0 and "123" in ok["output"]
    bad = _run(f'{PY} -c "import sys; print(\'boom\'); sys.exit(3)"', tmp_path)
    assert not bad["ok"] and bad["code"] == 3 and "boom" in bad["output"]
    assert C.describe(bad) == "check failed (exit 3)" and C.describe(ok) == "check passed"


def test_stderr_is_kept_and_colour_is_stripped(tmp_path):
    r = _run(f'{PY} -c "import sys; sys.stderr.write(\'\\x1b[31mRED\\x1b[0m err\\n\')"', tmp_path)
    assert "RED err" in r["output"] and "\x1b" not in r["output"]


def test_it_runs_where_it_is_told(tmp_path):
    (tmp_path / "marker.txt").write_text("here", encoding="utf-8")
    r = _run(f'{PY} -c "print(open(\'marker.txt\').read())"', tmp_path)
    assert r["ok"] and "here" in r["output"]


def test_quotes_and_chaining_survive_the_shell(tmp_path):
    r = _run(f'{PY} -c "print(\'a b\')" && {PY} -c "print(\'c\')"', tmp_path)
    assert r["ok"] and "a b" in r["output"] and "c" in r["output"]


def test_a_command_that_runs_too_long_is_killed_tree_and_all(tmp_path):
    # A child that outlives its shell -- the case where a plain kill hangs.
    t0 = time.monotonic()
    r = _run(f'{PY} -c "import subprocess,sys,time; '
             f'subprocess.Popen([sys.executable, \'-c\', \'import time; time.sleep(60)\']); time.sleep(60)"',
             tmp_path, timeout_s=2)
    assert r["timed_out"] and not r["ok"] and r["code"] is None
    assert time.monotonic() - t0 < 30
    assert "still running after" in r["output"]


def test_stop_ends_it(tmp_path):
    async def go():
        stop = asyncio.Event()
        asyncio.get_running_loop().call_later(0.5, stop.set)
        return await C.run(f'{PY} -c "import time; time.sleep(60)"', tmp_path, 60, stop=stop)
    r = asyncio.run(go())
    assert r["stopped"] and not r["timed_out"] and not r["ok"]


def test_secrets_are_not_handed_to_the_check(tmp_path, monkeypatch):
    monkeypatch.setenv("MAGI_API_TOKEN", "tok")
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setenv("SOME_SECRET", "s")
    monkeypatch.setenv("CLAUDE_CODE_X", "1")
    monkeypatch.setenv("HARMLESS", "yes")
    r = _run(f'{PY} -c "import os; print(sorted(k for k in os.environ if k in '
             f'(\'MAGI_API_TOKEN\',\'OPENAI_API_KEY\',\'SOME_SECRET\',\'CLAUDE_CODE_X\',\'HARMLESS\',\'CI\')))"',
             tmp_path)
    assert "['CI', 'HARMLESS']" in r["output"], r["output"]


def test_a_command_that_cannot_start_is_a_failed_check(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise OSError("nope")
    monkeypatch.setattr(C.proc, "popen", boom)
    r = _run("anything", tmp_path)
    assert not r["ok"] and "Could not start the check" in r["output"]


def test_the_output_keeps_its_end(tmp_path):
    r = _run(f'{PY} -c "print(\'x\' * 50000); print(\'THE END\')"', tmp_path)
    assert r["output"].endswith("THE END") and len(r["output"]) <= C.OUTPUT_TAIL + 100


def test_it_runs_in_the_agents_job(monkeypatch, tmp_path):
    adopted = []
    monkeypatch.setattr(C.agent_guard, "adopt", lambda p: adopted.append(p.pid))
    _run(f'{PY} -c "print(1)"', tmp_path)
    assert adopted, "agent-written code must not be able to drive the engine"


# ── dependency links ────────────────────────────────────────────────────────

def test_dependencies_are_linked_in_and_only_the_links_removed(tmp_path):
    real, copy = tmp_path / "real", tmp_path / "copy"
    (real / "node_modules" / "pkg").mkdir(parents=True)
    (real / "node_modules" / "pkg" / "index.js").write_text("1", encoding="utf-8")
    (real / "other").mkdir()
    copy.mkdir()
    links = C.link_deps(real, copy)
    assert [p.name for p in links] == ["node_modules"]
    assert (copy / "node_modules" / "pkg" / "index.js").read_text() == "1"
    assert not (copy / "other").exists(), "only dependency folders"
    C.unlink_deps(links)
    assert not os.path.lexists(copy / "node_modules")
    assert (real / "node_modules" / "pkg" / "index.js").exists(), "the real folder is untouched"


def test_an_existing_folder_in_the_copy_is_not_replaced(tmp_path):
    real, copy = tmp_path / "real", tmp_path / "copy"
    (real / ".venv").mkdir(parents=True)
    (copy / ".venv").mkdir(parents=True)
    assert C.link_deps(real, copy) == []
    assert C.link_deps(real, real) == [], "the real folder never links to itself"


# ── with a task: the approval card ─────────────────────────────────────────

def _git(cwd, *a):
    r = subprocess.run(["git", "-C", str(cwd), *a], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.setattr(SB, "BASE", tmp_path / "sandboxes")
    monkeypatch.setattr(SB, "patch_dir", lambda d: tmp_path / "patches")
    monkeypatch.setattr(T, "_profile", lambda: "test")
    r = tmp_path / "proj"
    r.mkdir()
    _git(r, "init", "-q")
    _git(r, "config", "user.name", "t")
    _git(r, "config", "user.email", "t@t")
    _git(r, "config", "core.autocrlf", "false")
    (r / "app.py").write_text("x = 1\n")
    (r / ".gitignore").write_text("node_modules/\n")
    (r / "node_modules").mkdir()
    (r / "node_modules" / "dep.txt").write_text("dep")
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "init")
    return r


class Editor(CodingAgent):
    kind = "cli"

    def __init__(self, writes):
        self.id = self.label = "fake"
        self.writes = writes
        self.roots = []

    async def run(self, task, *, emit, cancel):
        self.roots.append(task.root)
        for rel, text in self.writes.items():
            (task.root / rel).write_text(text)
        return Result(Outcome.OK, text="done")


async def _task(repo, agents, check, on_event):
    real = chain.expand
    chain.expand = lambda order, settings: agents
    try:
        t = await T.start(project_id="p", root=repo, prompt="edit", order=[],
                          settings=None, mode="write", check=check)
        seen = []
        async for ev in T.stream(t):
            seen.append(ev)
            await on_event(t, ev, seen)
        return t, seen
    finally:
        chain.expand = real


# The check reads the edited file in the COPY and the linked dependency.
CHECK = (f'{PY} -c "import sys; s = open(\'app.py\').read(); d = open(\'node_modules/dep.txt\').read(); '
         f'print(s.strip(), d); sys.exit(0 if \'x = 2\' in s else 5)"')


def test_an_automatic_check_runs_in_the_copy_before_the_card(repo):
    async def on(t, ev, seen):
        if ev["k"] == "approval":
            assert "check" in ev and ev["check"]["auto"] is True
            done = [e for e in seen if e["k"] == "check" and e["state"] == "done"]
            assert done and done[-1]["ok"], "the result is on the card when it opens"
            assert "x = 2 dep" in done[-1]["output"], "the agent's edit, with the folder's deps"
            assert done[-1]["linked"] == ["node_modules"]
            assert (repo / "app.py").read_text() == "x = 1\n", "never the real folder"
            T.decide(t, True)
    t, seen = asyncio.run(_task(repo, [Editor({"app.py": "x = 2\n"})],
                                {"command": CHECK, "auto": True, "timeout_min": 1}, on))
    kinds = [e["k"] for e in seen]
    assert kinds.index("check") < kinds.index("approval")
    assert t.result["write"] == "applied"
    assert (repo / "app.py").read_text() == "x = 2\n"
    assert not (repo / "node_modules" / "dep.txt").read_text() == "", "deps survive the sandbox removal"
    assert (repo / "node_modules" / "dep.txt").read_text() == "dep"
    assert "node_modules" not in json.dumps(next(e for e in seen if e["k"] == "approval")["files"]), \
        "the link never becomes part of the diff"


def test_a_manual_check_holds_the_clock_then_gives_a_full_window(repo, monkeypatch):
    monkeypatch.setattr(T, "APPROVAL_TIMEOUT", 1.5)
    slow = f'{PY} -c "import time; time.sleep(2.5); print(\'slow ok\')"'
    state = {}

    async def on(t, ev, seen):
        if ev["k"] == "approval":
            assert not any(e["k"] == "check" for e in seen), "manual: nothing runs by itself"
            assert T.start_check(t) == (True, "")
            assert T.start_check(t)[0] is False, "one at a time"
        if ev["k"] == "deadline" and ev["held"]:
            state["held_until"] = ev["expires_at"]
        if ev["k"] == "check" and ev["state"] == "done":
            state["done_at"] = time.time()
            T.decide(t, True)
    # The check (2.5s) outlasts the whole window (1.5s): it only succeeds
    # because the clock is held while it runs.
    t, seen = asyncio.run(_task(repo, [Editor({"app.py": "x = 2\n"})],
                                {"command": slow, "auto": False, "timeout_min": 1}, on))
    assert t.result["write"] == "applied", [e for e in seen if e["k"] in ("decision", "check")]
    assert state["held_until"] - time.time() > 30, "held past the check's own timeout"
    released = [e for e in seen if e["k"] == "deadline" and not e["held"]]
    assert released and released[-1]["expires_at"] >= state["done_at"] + 1.4


def test_a_check_still_running_is_stopped_by_the_answer(repo):
    slow = f'{PY} -c "import time; time.sleep(60)"'

    async def on(t, ev, seen):
        if ev["k"] == "approval":
            T.start_check(t)
        if ev["k"] == "check" and ev["state"] == "running":
            await asyncio.sleep(0.5)
            T.decide(t, False)
    t0 = time.monotonic()
    t, seen = asyncio.run(_task(repo, [Editor({"app.py": "x = 2\n"})],
                                {"command": slow, "auto": False, "timeout_min": 5}, on))
    assert time.monotonic() - t0 < 40
    done = [e for e in seen if e["k"] == "check" and e["state"] == "done"]
    assert done and done[-1]["stopped"]
    assert t.result["write"] == "denied"
    assert not any(p.exists() for p in (repo.parent / "sandboxes").rglob("node_modules")), \
        "the dependency link is gone before the copy is removed"
    assert (repo / "node_modules" / "dep.txt").read_text() == "dep"


def test_a_failing_automatic_check_still_asks(repo):
    async def on(t, ev, seen):
        if ev["k"] == "approval":
            T.decide(t, False)
    t, seen = asyncio.run(_task(repo, [Editor({"app.py": "x = 3\n"})],
                                {"command": CHECK, "auto": True, "timeout_min": 1}, on))
    done = [e for e in seen if e["k"] == "check" and e["state"] == "done"]
    assert done and not done[-1]["ok"] and done[-1]["code"] == 5
    assert "approval" in [e["k"] for e in seen], "it informs; it does not decide"


def test_read_mode_and_no_command_never_check(repo):
    async def on(t, ev, seen):
        if ev["k"] == "approval":
            assert "check" not in ev
            assert T.start_check(t)[0] is False
            T.decide(t, False)
    t, seen = asyncio.run(_task(repo, [Editor({"app.py": "x = 2\n"})], {}, on))
    assert not any(e["k"] == "check" for e in seen)
    t2 = T.TaskState(id="r", project_id="p", prompt="q", mode="read",
                     check_cfg={})
    assert T.start_check(t2)[0] is False


# ── who may set it ──────────────────────────────────────────────────────────

def test_setting_or_trying_it_is_local_only():
    import inspect
    from magi.code import routes as R
    for fn in (R.set_check, R.try_check):
        src = inspect.getsource(fn)
        assert "_local_only(request)" in src.split('"""', 2)[-1][:200], fn.__name__
    assert "_arrived_over_the_tunnel" in inspect.getsource(R._local_only)
    assert "HTTPException(404" in inspect.getsource(R._local_only)
    # The card's Run check runs only the command already set on this PC.
    assert "start_check" in inspect.getsource(R.check_task)
