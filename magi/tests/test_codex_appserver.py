"""Codex on `codex app-server`: steered mid-run (code/agents/codex_appserver.py).

A fake server answers what the runner writes, the way codex 0.162 did live
(2026-10-09): thread/start -> turn/start -> item/started (a command) ->
item/completed (the answer) -> turn/completed. What is checked is the
runner's side: a message typed mid-run goes in as `turn/steer` at the next
tool call, never by stopping the process; a refused steer becomes the next
turn; Interrupt now is `turn/interrupt`; an approval is declined; anything
that fails before the first turn falls back to `codex exec`.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from magi.code import followup as F
from magi.code.agents import codex_appserver as AS, codex_cli as CX, limits, models, slots
from magi.code.agents.base import Mode, Outcome, Task


# ── pure parts ──────────────────────────────────────────────────────────────

def test_the_server_runs_with_execs_containment_and_trusts_nothing():
    t = Task("t", "q", Path("C:/p"), Mode.READ)
    argv = AS.build_argv("codex", t)
    assert argv[:2] == ["codex", "app-server"]
    for f in CX.DISABLED_FEATURES:
        assert argv[argv.index(f) - 1] == "--disable"
    assert "windows.sandbox=elevated" in argv
    assert argv[-2:] == ["-c", "projects={}"]
    w = Task("t", "q", Path("C:/p"), Mode.WRITE, writes=[("lib", Path("C:/copy/lib"))])
    wa = AS.build_argv("codex", w)
    assert "sandbox_workspace_write.network_access=false" in wa
    assert AS.sandbox_policy(t) == {"type": "readOnly", "networkAccess": False}
    pol = AS.sandbox_policy(w)
    assert pol["type"] == "workspaceWrite" and pol["writableRoots"] == ["C:\\p", "C:\\copy\\lib"]
    assert pol["excludeTmpdirEnvVar"] and pol["excludeSlashTmp"] and not pol["networkAccess"]
    assert AS.thread_params(t, "gpt-x") == {"cwd": "C:\\p", "approvalPolicy": "never",
                                           "sandbox": "read-only", "model": "gpt-x"}


def test_usable_only_with_a_codex_home_that_sets_nothing_but_projects(tmp_path, monkeypatch):
    monkeypatch.delenv("MAGI_CODEX_EXEC", raising=False)
    assert AS.usable(tmp_path, "9.9")[0]
    (tmp_path / "config.toml").write_text("[projects.'c:\\\\x']\ntrust_level = \"trusted\"\n")
    assert AS.usable(tmp_path, "9.9")[0], "trust entries are neutralised by projects={}"
    (tmp_path / "config.toml").write_text('model = "o3"\n')
    ok, why = AS.usable(tmp_path, "9.9")
    assert not ok and "model" in why
    (tmp_path / "config.toml").unlink()
    (tmp_path / "rules").mkdir()
    (tmp_path / "rules" / "x.rules").write_text("prefix_rule()")
    assert not AS.usable(tmp_path, "9.9")[0]
    assert not AS.usable(None, "9.9")[0]
    monkeypatch.setenv("MAGI_CODEX_EXEC", "1")
    assert not AS.usable(Path("."), "9.9")[0]


def test_every_request_from_the_server_is_refused():
    d = json.loads(AS.answer_server({"id": 7, "method": "item/commandExecution/requestApproval"}))
    assert d == {"jsonrpc": "2.0", "id": 7, "result": {"decision": "decline"}}
    assert json.loads(AS.answer_server({"id": 8, "method": "execCommandApproval"}))["result"] == {
        "decision": "denied"}
    other = json.loads(AS.answer_server({"id": 9, "method": "item/tool/requestUserInput"}))
    assert "error" in other and "result" not in other


def test_parse_maps_the_servers_events_onto_execs():
    def n(method, **params):
        return json.dumps({"jsonrpc": "2.0", "method": method, "params": params})
    assert AS.parse(n("thread/started", thread={"id": "th"})) == {"k": "init", "session_id": "th"}
    cmd = AS.parse(n("item/started", item={"type": "commandExecution", "command": "dir"}))
    assert cmd == {"k": "tool", "name": "Bash", "target": "dir", "step": True}
    assert AS.parse(n("item/completed", item={"type": "agentMessage", "text": "hi"})) == {
        "k": "text", "text": "hi"}
    assert AS.parse(n("item/completed", item={"type": "agentMessage", "text": ""})) is None
    fc = AS.parse(n("item/completed", item={"type": "fileChange", "changes": [{"path": "a.py"}]}))
    assert fc == {"k": "tool", "name": "Edit", "target": "a.py"}
    done = AS.parse(n("turn/completed", turn={"status": "failed", "error": {"message": "boom"}}))
    assert done == {"k": "done", "status": "failed", "text": "boom"}
    rl = AS.parse(n("account/rateLimits/updated", rateLimits={
        "primary": {"usedPercent": 15, "windowDurationMins": 300, "resetsAt": 5}}))
    assert rl == {"k": "limits", "windows": {"5h": {"utilization": 0.15, "resets_at": 5}}}
    assert AS.parse(json.dumps({"id": 3, "result": {"ok": 1}}))["k"] == "resp"
    assert AS.parse(json.dumps({"id": 3, "method": "x"}))["k"] == "server"


# ── the runner, against a fake server ───────────────────────────────────────

class FakeServer:
    """`codex app-server` as the runner sees it. `script` options:
    steer_error: answer turn/steer with an error; thread_error: refuse
    thread/start; approval: ask for one approval mid-turn."""
    made: list["FakeServer"] = []
    script: dict = {}

    def __init__(self, argv, *, cwd, env, stdin_text=None, keep_stdin=False):
        FakeServer.made.append(self)
        self.argv, self.sent = argv, []
        self.q: asyncio.Queue = asyncio.Queue()
        self.stderr_tail, self.stalled = [], ""
        self.turns = 0
        self.exec = argv[1] == "exec"
        if self.exec:
            for d in ({"type": "thread.started", "thread_id": "ex"},
                      {"type": "item.completed", "item": {"type": "agent_message", "text": "from exec"}},
                      {"type": "turn.completed", "usage": {}}):
                self.q.put_nowait(json.dumps(d))
            self.q.put_nowait(None)

    def _out(self, **d):
        self.q.put_nowait(json.dumps({"jsonrpc": "2.0", **d}))

    def write_line(self, text):
        d = json.loads(text)
        self.sent.append(d)
        m, rid = d.get("method"), d.get("id")
        if m == "initialize":
            self._out(id=rid, result={"userAgent": "fake"})
        elif m in ("thread/start", "thread/resume"):
            if FakeServer.script.get("thread_error"):
                self._out(id=rid, error={"code": -1, "message": "no such thing"})
            else:
                self._out(id=rid, result={"thread": {"id": "th1"}})
                self._out(method="thread/started", params={"thread": {"id": "th1"}})
        elif m == "turn/start":
            self.turns += 1
            tid = f"tu{self.turns}"
            self._out(id=rid, result={"turn": {"id": tid}})
            asyncio.get_running_loop().create_task(self._play(tid, d["params"]))
        elif m == "turn/steer":
            if FakeServer.script.get("steer_error"):
                self._out(id=rid, error={"code": -32601, "message": "unknown method turn/steer"})
            else:
                self._out(id=rid, result={"turnId": d["params"]["expectedTurnId"]})
        elif m == "turn/interrupt":
            self._out(id=rid, result={})
            self.interrupted = True

    async def _play(self, tid, params):
        self.interrupted = False
        self._out(method="turn/started", params={"turn": {"id": tid}})
        await asyncio.sleep(0.05)
        self._out(method="item/started", params={"item": {"type": "commandExecution",
                                                           "command": f"cmd {tid}"}})
        if FakeServer.script.get("approval") and tid == "tu1":
            self._out(id=99, method="item/commandExecution/requestApproval", params={})
        for _ in range(int(FakeServer.script.get("hold", 0.3) / 0.05)):
            await asyncio.sleep(0.05)
            if self.interrupted:
                self._out(method="turn/completed", params={"turn": {"id": tid, "status": "interrupted"}})
                return
        said = " ".join(i["text"] for i in params["input"] if i["type"] == "text")
        self._out(method="item/completed", params={"item": {"type": "agentMessage",
                                                            "text": f"answer {tid}: {said[-40:]}"}})
        self._out(method="turn/completed", params={"turn": {"id": tid, "status": "completed"}})

    def close_stdin(self):
        self.q.put_nowait(None)

    async def lines(self, cancel, wake=None):
        from magi.code.agents._proc import WAKE
        while True:
            if wake is not None and wake.is_set():
                wake.clear()
                yield WAKE
                continue
            get = asyncio.ensure_future(self.q.get())
            waits = {get} | ({asyncio.ensure_future(wake.wait())} if wake is not None else set())
            done, rest = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
            for w in rest:
                w.cancel()
            if get not in done:
                continue
            item = get.result()
            if item is None:
                return
            yield item

    def kill(self):
        self.q.put_nowait(None)

    async def wait(self):
        return 0


@pytest.fixture
def server(tmp_path, monkeypatch):
    for mod in (limits, models):
        monkeypatch.setattr(mod, "data_dir", lambda: tmp_path)
    FakeServer.made, FakeServer.script = [], {}
    monkeypatch.setattr(CX, "Stream", FakeServer)
    monkeypatch.setattr(slots, "cli_path", lambda a: "codex")
    monkeypatch.setattr(slots, "env_for", lambda a, s: {})
    monkeypatch.setattr(slots, "slot_dir", lambda a, s: tmp_path / "home")
    monkeypatch.setattr(models, "codex_cli_version", lambda: "0.162.0")
    monkeypatch.setattr(CX, "gave_up", lambda text, tools: False)
    monkeypatch.delenv("MAGI_CODEX_EXEC", raising=False)
    AS._broken.clear()

    async def no_watch(*a, **k):
        await asyncio.sleep(3600)
    monkeypatch.setattr(models, "cap_watch", no_watch)
    return FakeServer


def _go(task, act=None, at=0.02):
    events = []

    async def emit(e):
        events.append(e)

    async def main():
        job = asyncio.ensure_future(CX.CodexCLIAgent("c1", model="gpt-x").run(
            task, emit=emit, cancel=asyncio.Event()))
        if act:
            await asyncio.sleep(at)
            act()
        return await job
    return asyncio.run(main()), events


def _steered(text="look"):
    t = Task("t", text, Path("."), Mode.READ)
    t.steer = F.Steer()
    t.steer.running("cli")
    return t


def test_a_message_goes_into_the_running_turn_as_turn_steer(server):
    t = _steered()
    sent = []
    t.steer.on_deliver = lambda ids, how: sent.append(how)
    res, events = _go(t, lambda: t.steer.add("ZEBRA: count the lines"))
    assert res.outcome == Outcome.OK, res
    assert len(server.made) == 1 and not server.made[0].exec, "one app server, no exec"
    s = server.made[0]
    steer = [d for d in s.sent if d.get("method") == "turn/steer"]
    assert len(steer) == 1 and steer[0]["params"]["expectedTurnId"] == "tu1"
    assert "ZEBRA" in steer[0]["params"]["input"][0]["text"]
    assert s.turns == 1, "taken into the same turn"
    assert sent == ["live"] and t.added == ["ZEBRA: count the lines"]
    start = next(d for d in s.sent if d.get("method") == "thread/start")
    assert start["params"]["approvalPolicy"] == "never" and start["params"]["sandbox"] == "read-only"


def test_a_refused_steer_becomes_the_next_turn(server):
    server.script = {"steer_error": True}
    t = _steered()
    res, _ = _go(t, lambda: t.steer.add("ZEBRA: and the tests"))
    assert res.outcome == Outcome.OK
    s = server.made[0]
    starts = [d for d in s.sent if d.get("method") == "turn/start"]
    assert len(starts) == 2 and "ZEBRA" in starts[1]["params"]["input"][0]["text"]
    assert "answer tu2" in res.text


def test_interrupt_now_is_turn_interrupt_then_the_message(server):
    server.script = {"hold": 2.0}
    t = _steered()

    def act():
        t.steer.add("ZEBRA: stop, do this instead")
        assert t.steer.interrupt_now() == "live"
    res, events = _go(t, act, at=0.2)
    assert res.outcome == Outcome.OK, res
    s = server.made[0]
    assert any(d.get("method") == "turn/interrupt" for d in s.sent)
    starts = [d for d in s.sent if d.get("method") == "turn/start"]
    assert len(starts) == 2 and "stopped your last step" in starts[1]["params"]["input"][0]["text"]
    assert len(server.made) == 1


def test_an_approval_request_is_declined(server):
    server.script = {"approval": True}
    res, _ = _go(_steered())
    assert res.outcome == Outcome.OK
    reply = next(d for d in server.made[0].sent if d.get("id") == 99)
    assert reply["result"] == {"decision": "decline"}


def test_a_server_that_cannot_start_a_thread_hands_the_run_to_exec(server):
    server.script = {"thread_error": True}
    res, events = _go(_steered())
    assert res.outcome == Outcome.OK and res.text == "from exec"
    assert [m.exec for m in server.made] == [False, True]
    assert not any(d.get("method") == "turn/start" for d in server.made[0].sent), \
        "nothing reached the model before the fall-back"
    # ...and the next run goes straight to exec.
    server.script = {}
    _go(_steered())
    assert [m.exec for m in server.made] == [False, True, True]


def test_a_resume_that_misses_is_a_resume_miss(server):
    server.script = {"thread_error": True}
    t = _steered()
    t.resume = {"agent": "codex:c1", "sid": "gone", "why": "followup"}
    res, _ = _go(t)
    assert res.outcome == Outcome.RESUME_MISS
    resume = next(d for d in server.made[0].sent if d.get("method") == "thread/resume")
    assert resume["params"]["threadId"] == "gone"
