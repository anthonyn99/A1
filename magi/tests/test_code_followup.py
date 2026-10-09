"""Track F, F3: Code Mode follow-ups -- session memory, native resume,
interrupt & continue, revise at the card (magi/code/followup.py, chain.py,
tasks.py, the two CLI agents)."""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import pytest

from magi.code import followup as F
from magi.code import sandbox as SB
from magi.code import tasks as T
from magi.code.agents import chain, limits, slots
from magi.code.agents import claude_cli as CC
from magi.code.agents import codex_cli as CX
from magi.code.agents import models as M
from magi.code.agents.base import CodingAgent, Mode, Outcome, Result, Task


def J(**d):
    return json.dumps(d)


# ── the session field ──────────────────────────────────────────────────────

def _sess(**over):
    s = {"id": "abc123", "turn": 2,
         "turns": [{"prompt": "what does app.py do?", "text": "It prints x.",
                    "outcome": "ok", "by": "Claude"}],
         "native": {"agent": "claude:system", "sid": "3cded8e3-57d8-4d71-8883-d270784f4e7a"}}
    s.update(over)
    return s


def test_no_session_is_a_fresh_task():
    for raw in (None, "", {}):
        assert F.parse_session(raw) is None


def test_a_session_parses_with_its_turns_and_native_resume():
    s = F.parse_session(_sess())
    assert s.id == "abc123" and s.turn == 2
    assert s.turns[0]["prompt"] == "what does app.py do?" and s.turns[0]["mode"] == "read"
    assert s.native == {"agent": "claude:system", "sid": "3cded8e3-57d8-4d71-8883-d270784f4e7a"}


@pytest.mark.parametrize("bad", [
    {"id": "no spaces allowed"}, {"id": ""}, {"turn": 0}, {"turn": "2"}, {"turn": True},
    {"turns": "x"}, {"turns": [1]}, {"turns": [{"prompt": 5}]},
    {"turns": [{"prompt": "q"}] * (F.MAX_TURNS + 1)},
    {"turns": [{"prompt": "q", "text": "x" * (F.MAX_INPUT_CHARS + 1)}]},
    {"native": {"agent": "browser:gemini", "sid": "3cded8e3-57d8"}},
    {"native": {"agent": "claude:system", "sid": "../../etc"}},
    {"native": {"agent": "claude:system"}},
    {"native": "x"},
])
def test_a_bad_session_is_refused(bad):
    with pytest.raises(ValueError):
        F.parse_session(_sess(**bad))


def test_applied_files_come_in_either_shape():
    s = F.parse_session(_sess(turns=[{"prompt": "fix", "write": "applied",
                                      "files": ["a.py", {"path": "b.py"}, {"x": 1}, 7]}]))
    assert s.turns[0]["files"] == ["a.py", "b.py"] and s.turns[0]["mode"] == "write"


# ── ground truth about the folder ─────────────────────────────────────────

def _w(write, files=()):
    return {"prompt": "edit", "text": "done", "mode": "write", "write": write,
            "files": list(files)}


def test_state_note_says_an_applied_diff_is_in_the_project():
    n = F.state_note([_w("applied", ["app.py", "lib/x.py"])])
    assert "Turn 1" in n and "APPLIED" in n and "app.py, lib/x.py" in n
    assert "NOT in the project" not in n


@pytest.mark.parametrize("how", ["denied", "timeout", "halted", "refused", "conflict",
                                 "discarded", "something-new"])
def test_state_note_says_every_unapplied_diff_is_NOT_in_the_project(how):
    n = F.state_note([_w(how, ["app.py"])])
    assert "NOT" in n, how
    assert "APPLIED" not in n


def test_state_note_numbers_turns_and_skips_read_turns():
    read = {"prompt": "look", "text": "ok", "mode": "read"}
    n = F.state_note([read, _w("denied"), read, _w("applied", ["a.py"])])
    assert "Turn 2: your diff was DENIED" in n and "Turn 4: your diff was APPLIED" in n
    assert "Turn 1" not in n and "Turn 3" not in n
    assert F.state_note([read]) == ""


def test_state_note_names_a_turn_with_no_changes():
    assert "no changes" in F.state_note([_w("none")])


# ── the SESSION SO FAR block ──────────────────────────────────────────────

def test_history_is_the_F1_block_with_its_own_header_and_turn_kinds():
    turns = F.parse_session(_sess(turns=[
        {"prompt": "look at app.py", "text": "It prints x."},
        {"prompt": "make it print y", "text": "Changed it.", "write": "denied",
         "by": "Codex (codex1)"}])).turns
    h = F.history(turns, 24_000)
    assert h.startswith(F.HEADER)
    assert "PERSON: look at app.py\n[read-only turn]" in h
    assert "[write turn by Codex (codex1); diff denied]" in h
    assert "ANSWER:\nChanged it." in h


def test_history_fits_its_budget():
    turns = [{"prompt": f"q{i}", "text": "a" * 5000, "mode": "read"} for i in range(20)]
    h = F.history(turns, 6000)
    assert len(h) <= 6000 and h.startswith(F.HEADER)
    assert "q19" in h, "the newest turn is kept"


# ── prompts ───────────────────────────────────────────────────────────────

def _task(**kw):
    t = Task("t", "and the tests for it?", Path("."), **kw)
    return t


def test_a_task_with_no_session_prompts_exactly_as_before():
    assert Task("t", "q", Path("."), Mode.READ).full_prompt() == "q"


def test_a_fresh_follow_up_carries_ground_truth_history_and_new_message():
    t = _task(mode=Mode.WRITE)
    t.session_turns = [_w("denied", ["app.py"])]
    t.state_note = F.state_note(t.session_turns)
    p = t.full_prompt()
    assert p.index("private copy") < p.index("WHAT IS ACTUALLY") < p.index(F.HEADER) \
        < p.index("NEW MESSAGE:\nand the tests for it?")


def test_resuming_leaves_the_history_out_but_keeps_the_ground_truth():
    t = _task(mode=Mode.WRITE)
    t.session_turns = [_w("denied", ["app.py"])]
    t.state_note = F.state_note(t.session_turns)
    t.resume = {"agent": "claude:system", "sid": "s1", "why": "followup"}
    p = t.prompt_for("claude:system")
    assert F.HEADER not in p, "it remembers; saying it twice wastes its context"
    assert "DENIED" in p and "NEW MESSAGE:\nand the tests for it?" in p


def test_only_the_matching_agent_resumes():
    t = _task()
    t.session_turns = [{"prompt": "a", "text": "b", "mode": "read"}]
    t.resume = {"agent": "claude:system", "sid": "s1", "why": "followup"}
    assert t.resume_for("claude:system") == "s1"
    assert t.resume_for("codex:codex1") == "" and t.resume_for("claude:work") == ""
    assert F.HEADER in t.prompt_for("codex:codex1"), "anyone else gets the transcript"


def test_an_interrupt_resume_sends_only_the_message():
    t = _task(mode=Mode.WRITE)
    t.resume = {"agent": "codex:c1", "sid": "s1", "why": "interrupt"}
    t.interrupt_msgs = ["use pytest, not unittest"]
    p = t.prompt_for("codex:c1")
    assert "interrupted you" in p and "- use pytest, not unittest" in p
    assert "still in this working copy" in p
    assert "and the tests for it?" not in p


def test_a_revise_resume_says_nothing_was_applied():
    t = _task(mode=Mode.WRITE)
    t.resume = {"agent": "codex:c1", "sid": "s1", "why": "revise"}
    t.interrupt_msgs = ["keep the old name"]
    p = t.prompt_for("codex:c1")
    assert "asked for a revision" in p and "Nothing was applied" in p


def test_added_messages_ride_every_fresh_prompt():
    t = _task()
    t.added = ["also check utils.py"]
    assert "ADDED BY THE PERSON" in t.full_prompt()
    assert "also check utils.py" in t.full_prompt()


def test_gather_text_includes_recent_session_prompts():
    t = _task()
    t.session_turns = [{"prompt": "p1"}, {"prompt": "p2"},
                       {"prompt": "look at magi/app.py"}, {"prompt": "p4"}]
    t.added = ["and chain.py"]
    g = t.gather_text()
    assert "look at magi/app.py" in g and "p4" in g and "and chain.py" in g
    # The first turn is what the session is about; the middle ones are not.
    assert "p1" in g and "p2" not in g


def test_a_browser_unit_gets_the_history_and_ground_truth(monkeypatch):
    from magi.code.agents.browser import BrowserUnitAgent
    a = BrowserUnitAgent.__new__(BrowserUnitAgent)
    a.unit_id = "gemini"
    t = _task(mode=Mode.WRITE)
    t.session_turns = [_w("refused", ["x.py"])]
    t.state_note = F.state_note(t.session_turns)
    t.added = ["and add a docstring"]
    p = a.build_prompt(t, "ctx")
    assert "REFUSED" in p and F.HEADER in p and "NEW MESSAGE:\nand the tests" in p
    assert "and add a docstring" in p


# ── argv ──────────────────────────────────────────────────────────────────

def test_claude_resume_appends_resume():
    argv = CC.build_argv("claude", Task("t", "q", Path("."), Mode.WRITE), resume="s-1")
    assert argv[-2:] == ["--resume", "s-1"]
    assert "--restricted" in argv and "acceptEdits" in argv
    assert "--resume" not in CC.build_argv("claude", Task("t", "q", Path("."), Mode.READ))


def test_codex_never_runs_ephemeral_and_resumes_after_its_flags():
    fresh = CX.build_argv("codex", Task("t", "q", Path("C:/p"), Mode.READ))
    assert "--ephemeral" not in fresh, "a thread with no rollout cannot be resumed"
    assert fresh[-1] == "-"
    res = CX.build_argv("codex", Task("t", "q", Path("C:/p"), Mode.WRITE), resume="th-1")
    assert res[-3:] == ["resume", "th-1", "-"]
    i = res.index("resume")
    # Verified live: `codex exec resume --sandbox …` is refused.
    for flag in ("--sandbox", "-C", "--ignore-user-config", "--json"):
        assert res.index(flag) < i, flag


# ── the CLI agents: resume, and a miss ────────────────────────────────────

class FakeStream:
    scripts: list[tuple[list[str], list[str]]] = []
    argvs: list[list[str]] = []
    prompts: list[str] = []

    def __init__(self, argv, *, cwd, env, stdin_text=None, keep_stdin=False):
        FakeStream.argvs.append(argv)
        FakeStream.prompts.append(stdin_text)
        self._lines, self.stderr_tail = FakeStream.scripts.pop(0)
        self.stalled = ""

    async def lines(self, cancel, wake=None):
        for ln in self._lines:
            yield ln
            await asyncio.sleep(0)

    def write_line(self, text):
        pass

    def close_stdin(self):
        pass

    def kill(self):
        pass

    async def wait(self):
        return 0


@pytest.fixture
def fake_cli(tmp_path, monkeypatch):
    for mod in (M, limits):
        monkeypatch.setattr(mod, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(slots, "cli_root", lambda: tmp_path / "cli")
    (tmp_path / "cli").mkdir(exist_ok=True)
    FakeStream.scripts, FakeStream.argvs, FakeStream.prompts = [], [], []
    monkeypatch.setattr(CC, "Stream", FakeStream)
    monkeypatch.setattr(CX, "Stream", FakeStream)
    # These script `codex exec`; the app server has its own tests.
    monkeypatch.setattr(CX.AS, "usable", lambda home, ver: (False, "test"))
    monkeypatch.setattr(slots, "cli_path", lambda a: a)
    return FakeStream


def _agent_run(agent, task):
    events = []

    async def emit(ev):
        events.append(ev)
    return asyncio.run(agent.run(task, emit=emit, cancel=asyncio.Event())), events


CLAUDE_MISS = ([J(type="result", subtype="error_during_execution", is_error=True, num_turns=0,
                  session_id="gone", errors=["No conversation found with session ID: gone"])],
               ["No conversation found with session ID: gone"])
CLAUDE_OK = ([J(type="system", subtype="init", model="haiku", session_id="s-1"),
              J(type="assistant", message={"content": [{"type": "text", "text": "kiwi"}]}),
              J(type="result", is_error=False, result="kiwi", num_turns=1, session_id="s-1")], [])


def test_claude_resumes_the_session_it_is_given(fake_cli):
    fake_cli.scripts = [CLAUDE_OK]
    t = Task("t", "what fruit?", Path("."))
    t.resume = {"agent": "claude:system", "sid": "s-1", "why": "followup"}
    res, _ = _agent_run(CC.ClaudeCLIAgent("system", model="haiku"), t)
    assert res.outcome == Outcome.OK and res.session_id == "s-1"
    assert fake_cli.argvs[0][-2:] == ["--resume", "s-1"]
    first = json.loads(fake_cli.prompts[0])["message"]["content"][0]["text"]
    assert first.startswith("NEW MESSAGE:")


def test_claude_reports_a_resume_miss(fake_cli):
    fake_cli.scripts = [CLAUDE_MISS]
    t = Task("t", "q", Path("."))
    t.resume = {"agent": "claude:system", "sid": "gone", "why": "followup"}
    res, _ = _agent_run(CC.ClaudeCLIAgent("system", model="haiku"), t)
    assert res.outcome == Outcome.RESUME_MISS


def test_a_claude_failure_that_is_not_a_miss_is_not_called_one(fake_cli):
    fake_cli.scripts = [CLAUDE_MISS]
    res, _ = _agent_run(CC.ClaudeCLIAgent("system", model="haiku"), Task("t", "q", Path(".")))
    assert res.outcome != Outcome.RESUME_MISS, "only a RESUMED run can miss"


def test_codex_reports_a_resume_miss(fake_cli):
    fake_cli.scripts = [([], ["Error: thread/resume: thread/resume failed: no rollout found "
                              "for thread id 1111 (code -32600)"])]
    t = Task("t", "q", Path("."))
    t.resume = {"agent": "codex:c1", "sid": "1111", "why": "followup"}
    res, _ = _agent_run(CX.CodexCLIAgent("c1", model="m"), t)
    assert res.outcome == Outcome.RESUME_MISS
    assert fake_cli.argvs[0][-3:] == ["resume", "1111", "-"]


# ── the chain: interrupt, resume miss, hand-off ───────────────────────────

class Worker(CodingAgent):
    """A CLI-like agent. Scripted per run: "wait" runs until stopped (and has
    a session by then), anything else returns that Outcome at once."""
    kind = "cli"

    def __init__(self, aid, script, sid="sess-1"):
        self.id = self.label = aid
        self.script = list(script)
        self.sid = sid
        self.prompts: list[str] = []
        self.resumed: list[str] = []
        self.started = asyncio.Event()

    async def run(self, task, *, emit, cancel):
        self.prompts.append(task.prompt_for(self.id))
        self.resumed.append(task.resume_for(self.id))
        step = self.script.pop(0)
        self.started.set()
        if step == "wait":
            await cancel.wait()
            return Result(Outcome.CANCELLED, text="halfway", session_id=self.sid)
        return Result(step, text=f"{self.id} says {step}", session_id=self.sid,
                      detail=str(step))


@pytest.fixture
def fast_batch(monkeypatch):
    monkeypatch.setattr(F, "BATCH_S", 0.02)


async def _chain(task, agents, steer, cancel=None):
    events = []

    async def emit(ev):
        events.append(ev)
    res = await chain.run_chain(task, agents, emit=emit, cancel=cancel or asyncio.Event(),
                                steer=steer)
    return res, events


def test_a_message_interrupts_a_cli_agent_which_resumes_its_own_session(fast_batch):
    async def go():
        a = Worker("claude:system", ["wait", Outcome.OK])
        b = Worker("codex:c1", [Outcome.OK])
        steer = F.Steer()
        task = Task("t", "refactor it", Path("."))
        job = asyncio.ensure_future(_chain(task, [a, b], steer))
        await a.started.wait()
        assert steer.add("use a dataclass") == "interrupt"
        res, ev = await job
        return a, b, res, ev, steer
    a, b, res, ev, steer = asyncio.run(go())
    assert res.outcome == Outcome.OK and res.by == "claude:system"
    assert b.prompts == [], "an interrupt is not a hand-off"
    assert a.resumed == ["", "sess-1"], "the second run resumes its own session"
    assert "interrupted you" in a.prompts[1] and "- use a dataclass" in a.prompts[1]
    assert [x.outcome for x in res.attempts] == ["interrupted", "ok"]
    assert any(e["k"] == "interrupt" and e["resumed"] for e in ev)
    assert res.native == {"agent": "claude:system", "sid": "sess-1"}
    assert not steer.open, "a finished chain turns later messages into follow-ups"


def test_messages_close_together_are_one_interrupt(monkeypatch):
    monkeypatch.setattr(F, "BATCH_S", 0.2)

    async def go():
        a = Worker("claude:system", ["wait", Outcome.OK])
        steer = F.Steer()
        job = asyncio.ensure_future(_chain(Task("t", "x", Path(".")), [a], steer))
        await a.started.wait()
        steer.add("one")
        await asyncio.sleep(0.05)
        steer.add("two")
        await job
        return a
    a = asyncio.run(go())
    assert len(a.prompts) == 2
    assert "- one\n- two" in a.prompts[1]


def test_a_cli_without_a_session_continues_from_a_note(fast_batch):
    async def go():
        a = Worker("claude:system", ["wait", Outcome.OK], sid="")
        steer = F.Steer()
        job = asyncio.ensure_future(_chain(Task("t", "refactor", Path(".")), [a], steer))
        await a.started.wait()
        steer.add("skip the tests folder")
        await job
        return a
    a = asyncio.run(go())
    assert a.resumed == ["", ""]
    assert "Carry on from where you were" in a.prompts[1] and "halfway" in a.prompts[1]
    assert "skip the tests folder" in a.prompts[1]


def test_halt_wins_over_an_interrupt(fast_batch):
    async def go():
        a = Worker("claude:system", ["wait", Outcome.OK])
        steer = F.Steer()
        cancel = asyncio.Event()
        job = asyncio.ensure_future(_chain(Task("t", "x", Path(".")), [a], steer, cancel))
        await a.started.wait()
        steer.add("more")
        cancel.set()
        return await job, a
    (res, _), a = asyncio.run(go())
    assert res.outcome == Outcome.CANCELLED and len(a.prompts) == 1


def test_a_message_before_the_agent_starts_joins_its_prompt():
    steer = F.Steer()
    assert steer.add("also the README") == "prompt"
    a = Worker("claude:system", [Outcome.OK])
    asyncio.run(_chain(Task("t", "x", Path(".")), [a], steer))
    assert "ADDED BY THE PERSON" in a.prompts[0] and "also the README" in a.prompts[0]


def test_a_browser_unit_is_not_interrupted_but_continues_after_its_reply(fast_batch):
    class Unit(Worker):
        kind = "browser"

    async def go():
        u = Unit("browser:gemini", ["slow", Outcome.OK], sid="")
        u.script[0] = Outcome.OK
        steer = F.Steer()
        orig = u.run

        async def run(task, *, emit, cancel):
            if not u.prompts:
                u.started.set()
                assert steer.add("and explain why") == "after_reply"
                await asyncio.sleep(0.1)   # past the batch window: no interrupt
                assert not cancel.is_set(), "a browser reply is never cut off"
            return await orig(task, emit=emit, cancel=cancel)
        u.run = run
        res, _ = await _chain(Task("t", "x", Path(".")), [u], steer)
        return u, res
    u, res = asyncio.run(go())
    assert res.outcome == Outcome.OK and len(u.prompts) == 2
    assert "and explain why" in u.prompts[1] and "Carry on" in u.prompts[1]


def test_a_resume_miss_retries_the_same_agent_from_the_transcript():
    a = Worker("claude:system", [Outcome.RESUME_MISS, Outcome.OK])
    b = Worker("codex:c1", [Outcome.OK])
    task = Task("t", "next step", Path("."))
    task.session_turns = [{"prompt": "earlier", "text": "answer", "mode": "read"}]
    task.resume = {"agent": "claude:system", "sid": "gone", "why": "followup"}
    res, ev = asyncio.run(_chain(task, [a, b], F.Steer()))
    assert res.by == "claude:system" and b.prompts == []
    assert a.resumed == ["gone", ""]
    assert F.HEADER in a.prompts[1], "the retry carries the transcript"
    assert any("could not resume" in e.get("text", "") for e in ev)


def test_a_second_resume_miss_hands_off():
    a = Worker("claude:system", [Outcome.RESUME_MISS, Outcome.RESUME_MISS])
    b = Worker("codex:c1", [Outcome.OK])
    task = Task("t", "x", Path("."))
    task.resume = {"agent": "claude:system", "sid": "gone", "why": "followup"}
    res, _ = asyncio.run(_chain(task, [a, b], F.Steer()))
    assert res.by == "codex:c1"


def test_a_hand_off_after_an_interrupt_keeps_the_message(fast_batch):
    async def go():
        a = Worker("claude:system", ["wait", Outcome.LIMITED])
        b = Worker("codex:c1", [Outcome.OK])
        steer = F.Steer()
        job = asyncio.ensure_future(_chain(Task("t", "x", Path(".")), [a, b], steer))
        await a.started.wait()
        steer.add("name it Parser")
        await job
        return b
    b = asyncio.run(go())
    assert "name it Parser" in b.prompts[0] and "ADDED BY THE PERSON" in b.prompts[0]
    assert b.resumed == [""], "another agent never resumes Claude's session"


def test_the_steer_caps_messages():
    s = F.Steer()
    for i in range(F.MAX_MESSAGES):
        s.hold(f"m{i}")
    with pytest.raises(OverflowError):
        s.add("one too many")
    with pytest.raises(ValueError):
        F.Steer().add("   ")
    with pytest.raises(ValueError):
        F.Steer().add("x" * (F.MAX_MESSAGE_CHARS + 1))


# ── tasks: revise at the card, follow-up after, sessions ──────────────────

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
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "init")
    return r


class Editor(CodingAgent):
    """Writes each run's files into the sandbox it is given."""
    kind = "cli"

    def __init__(self, runs: list[dict[str, str]], aid="claude:system"):
        self.id = self.label = aid
        self.runs = list(runs)
        self.roots: list[Path] = []
        self.prompts: list[str] = []
        self.resumed: list[str] = []

    async def run(self, task, *, emit, cancel):
        self.roots.append(task.root)
        self.prompts.append(task.prompt_for(self.id))
        self.resumed.append(task.resume_for(self.id))
        for rel, text in self.runs.pop(0).items():
            (task.root / rel).write_text(text)
        return Result(Outcome.OK, text="done", session_id="sess-9")


async def _task_run(repo, agents, on_event, *, session=None, mode="write"):
    orig = chain.expand
    chain.expand = lambda order, settings: agents
    try:
        t = await T.start(project_id="p", root=repo, prompt="edit", order=[],
                          settings=None, mode=mode, session=session)
        seen = []
        async for ev in T.stream(t):
            seen.append(ev)
            await on_event(t, ev, seen)
        return t, seen
    finally:
        chain.expand = orig


def test_a_message_at_the_card_revises_in_the_same_copy_and_asks_again(repo):
    a = Editor([{"app.py": "x = 2\n"}, {"app.py": "x = 3\n"}])
    cards = []

    async def on(t, ev, seen):
        if ev["k"] == "approval":
            cards.append(ev)
            if len(cards) == 1:
                r = await T.message(t, "make it 3, not 2")
                assert r == {"ok": True, "accepted": "revise", "id": "m1"}
                assert T.decide(t, True) == (False, "Already answered.")
            else:
                assert T.decide(t, True) == (True, "")
    t, seen = asyncio.run(_task_run(repo, [a], on))
    assert len(cards) == 2, "a new card for the revised diff"
    assert a.roots[0] == a.roots[1], "the same copy: its edits are still there"
    assert a.resumed == ["", "sess-9"] and "asked for a revision" in a.prompts[1]
    decisions = [e for e in seen if e["k"] == "decision"]
    assert decisions[0]["why"] == "revised" and decisions[1]["why"] == "approved"
    assert (repo / "app.py").read_text() == "x = 3\n", "only the revised diff is applied"
    assert t.result["write"] == "applied"
    assert [e["how"] for e in seen if e["k"] == "user"] == ["revise"]


def test_a_revision_applies_nothing_until_approved(repo):
    a = Editor([{"app.py": "x = 2\n"}, {"app.py": "x = 3\n"}])

    async def on(t, ev, seen):
        if ev["k"] == "approval":
            assert (repo / "app.py").read_text() == "x = 1\n"
            if sum(e["k"] == "approval" for e in seen) == 1:
                await T.message(t, "again")
            else:
                T.decide(t, False)
    t, _ = asyncio.run(_task_run(repo, [a], on))
    assert (repo / "app.py").read_text() == "x = 1\n"
    assert t.result["write"] == "denied"


def test_a_message_after_the_decision_is_a_followup(repo):
    a = Editor([{"app.py": "x = 2\n"}])
    got = []

    async def on(t, ev, seen):
        if ev["k"] == "approval":
            T.decide(t, False)
        if ev["k"] == "decision":
            got.append(await T.message(t, "then try 4"))
    t, _ = asyncio.run(_task_run(repo, [a], on))
    assert got == [{"ok": True, "accepted": "followup"}]
    got2 = asyncio.run(T.message(t, "and 5"))
    assert got2["accepted"] == "followup" and t.done


def test_a_message_during_the_pull_that_never_reaches_an_agent_comes_back(repo, monkeypatch):
    async def failing_pull(t, root):
        await T.message(t, "please hurry")
        from magi.code import git as G
        return G.Pull(False, text="could not pull")
    monkeypatch.setattr(T, "_pull_first", failing_pull)

    async def on(t, ev, seen):
        pass
    t, seen = asyncio.run(_task_run(repo, [Editor([{}])], on))
    assert t.result["unsent_messages"] == ["please hurry"]
    assert [e["how"] for e in seen if e["k"] == "user"] == ["prompt"]


def test_a_follow_up_task_carries_its_session(repo):
    a = Editor([{"app.py": "x = 5\n"}])
    session = F.parse_session({
        "id": "first-task", "turn": 3,
        "turns": [{"prompt": "set x to 2", "text": "done", "write": "denied", "mode": "write"},
                  {"prompt": "why is x 1?", "text": "it was never changed"}],
        "native": {"agent": "claude:system", "sid": "sess-0007"}})

    async def on(t, ev, seen):
        if ev["k"] == "approval":
            T.decide(t, True)
    t, seen = asyncio.run(_task_run(repo, [a], on, session=session))
    start = next(e for e in seen if e["k"] == "start")
    assert start["session_id"] == "first-task" and start["turn"] == 3
    assert t.summary()["session_id"] == "first-task" and t.summary()["turn"] == 3
    assert a.resumed == ["sess-0007"]
    assert "Turn 1: your diff was DENIED" in a.prompts[0]
    assert F.HEADER not in a.prompts[0]
    assert t.result["native"] == {"agent": "claude:system", "sid": "sess-9"}


def test_a_first_turn_is_its_own_session(repo):
    async def on(t, ev, seen):
        pass
    t, _ = asyncio.run(_task_run(repo, [Editor([{}])], on, mode="read"))
    assert t.summary()["session_id"] == t.id and t.turn == 1


def test_native_resume_is_skipped_when_that_agent_is_not_in_the_chain(repo):
    a = Editor([{}], aid="codex:c1")
    session = F.parse_session({"id": "s1", "turn": 2, "turns": [{"prompt": "hi", "text": "yo"}],
                               "native": {"agent": "claude:system", "sid": "sess-0007"}})

    async def on(t, ev, seen):
        pass
    t, seen = asyncio.run(_task_run(repo, [a], on, session=session, mode="read"))
    assert a.resumed == [""] and F.HEADER in a.prompts[0]
    assert not any("continues its own session" in e.get("text", "") for e in seen)


# ── routes ────────────────────────────────────────────────────────────────

def test_state_advertises_followup_and_steer():
    import inspect
    from magi.code import routes
    src = inspect.getsource(routes.code_state)
    assert '"followup", "steer"' in src


def test_message_route_answers_for_an_unknown_task():
    from magi.code import routes
    r = asyncio.run(routes.message_task("nope", {"text": "hi"}))
    assert r["ok"] is False and r["error"] == "no_task"


def test_a_bad_message_is_refused_not_published():
    t = T.TaskState(id="x", project_id="p", prompt="q", mode="read")
    r = asyncio.run(T.message(t, ""))
    assert r["ok"] is False and r["error"] == "bad_message" and t.events == []
    r = asyncio.run(T.message(t, 42))
    assert r["error"] == "bad_message"
