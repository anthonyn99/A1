"""The REAL Claude Code CLI, on MAGI's exact argv, against a fake Messages API.

No account and no real request: a throwaway CLAUDE_CONFIG_DIR, a dummy key,
ANTHROPIC_BASE_URL on loopback. The fake API scripts the model's turns (which
tool to call), so what is tested is everything around the model: the flags,
the MCP config, which tools the CLI offers, which run without a prompt in
write mode, and what comes back. MAGI updates the CLI by itself
(agents/updates.py); a release that changes any of this fails here, not in a
task.

Found this way (Track V, 2026-10-04, Claude Code 2.1.289): both MAGI servers
allowed by `--allowedTools mcp__a,mcp__b` run with no permission refusal under
acceptEdits; Bash is not offered and a call to it is refused.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from magi.code import followup as F, tasks as T
from magi.code.agents import claude_cli as CC, slots
from magi.code.agents.base import Mode, Outcome, Task

EXE = slots.cli_path("claude")
pytestmark = pytest.mark.skipif(not EXE, reason="Claude Code CLI not installed")


class FakeAPI:
    """Answers /v1/messages: one scripted tool call per turn, then text."""

    def __init__(self, plan):
        self.plan, self.log = list(plan), []
        api = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_HEAD(self):
                self.send_response(200)
                self.end_headers()

            def do_GET(self):
                self.send_response(404)
                self.end_headers()

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
                if not self.path.split("?")[0].endswith("/v1/messages"):
                    self._json({"input_tokens": 1})
                    return
                api._answer(self, body)

            def _json(self, d):
                data = json.dumps(d).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(data)

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def _answer(self, h, body):
        tools = [t.get("name") for t in body.get("tools") or []]
        results = [b for m in body.get("messages") or [] if isinstance(m.get("content"), list)
                   for b in m["content"] if b.get("type") == "tool_result"]
        main = "Read" in tools or any(t.startswith("mcp__") for t in tools)
        if main:
            self.log.append({"tools": tools, "results": results,
                             "first": json.dumps(body["messages"][0].get("content"))})
        k = len(results)
        if main and k < len(self.plan):
            name, inp = self.plan[k]
            block = {"type": "tool_use", "id": "toolu_" + uuid.uuid4().hex[:20], "name": name}
            delta = {"type": "input_json_delta", "partial_json": json.dumps(inp)}
            start, stop = {**block, "input": {}}, "tool_use"
        else:
            start = {"type": "text", "text": ""}
            delta = {"type": "text_delta", "text": "All done." if main else "ok"}
            stop = "end_turn"
        model = body.get("model") or "claude-haiku-4-5"
        ev = [("message_start", {"type": "message_start", "message": {
                  "id": "msg_" + uuid.uuid4().hex[:12], "type": "message", "role": "assistant",
                  "model": model, "content": [], "stop_reason": None, "stop_sequence": None,
                  "usage": {"input_tokens": 1, "output_tokens": 1}}}),
              ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": start}),
              ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": delta}),
              ("content_block_stop", {"type": "content_block_stop", "index": 0}),
              ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop,
                                 "stop_sequence": None}, "usage": {"output_tokens": 1}}),
              ("message_stop", {"type": "message_stop"})]
        h.send_response(200)
        h.send_header("content-type", "text/event-stream")
        h.end_headers()
        for name, data in ev:
            h.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())
        h.wfile.flush()

    def result_texts(self) -> list[tuple[bool, str]]:
        out = []
        for r in (self.log[-1]["results"] if self.log else []):
            c = r.get("content")
            if isinstance(c, list):
                c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
            out.append((bool(r.get("is_error")), str(c)))
        return out


def _env(api: FakeAPI, cfgdir: Path) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC_", "CLAUDE_"))}
    env.update({"CLAUDE_CONFIG_DIR": str(cfgdir), "ANTHROPIC_API_KEY": "sk-ant-offline-test",
                "ANTHROPIC_BASE_URL": api.url, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "DISABLE_AUTOUPDATER": "1"})
    return env


def _run(task: Task, api: FakeAPI, cfgdir: Path):
    # (the prompt goes in exactly as ClaudeCLIAgent sends it)
    env = _env(api, cfgdir)
    argv = CC.build_argv(EXE, task, model="claude-haiku-4-5")
    r = subprocess.run(argv, cwd=str(task.root), env=env, capture_output=True, text=True,
                       input=CC.stdin_for(task.prompt_for("claude:system", frame=CC.write_frame(task),
                                                          refs_how=CC.refs_how(task))),
                       encoding="utf-8", errors="replace", timeout=240)
    evs = [e for e in (CC.parse_line(ln) for ln in r.stdout.splitlines()) if e]
    return r, evs


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(T, "_mcp_path", lambda tid: tmp_path / "mcp" / f"{tid}.json")
    ws = tmp_path / "ws"
    (ws / "old").mkdir(parents=True)
    (ws / "notes.txt").write_text("notes\n")
    (ws / "dead.txt").write_text("dead\n")
    (ws / "old" / "a.txt").write_text("a\n")
    (ws / "check.py").write_text(
        "import os, sys\nok = os.path.exists('docs/notes.md') and not os.path.exists('dead.txt')\n"
        "print('CHECK SAYS', 'GOOD' if ok else 'BAD')\nsys.exit(0 if ok else 1)\n")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep\n")
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    return ws, outside, cfg


def test_claude_moves_deletes_and_runs_the_check_through_magis_server(setup):
    ws, outside, cfg = setup
    check = f'"{sys.executable}" check.py'
    f = T.write_mcp_config("t1", "p", ws, "", workspace={
        "root": str(ws), "real": None, "check": {"command": check, "timeout_min": 2}})
    task = Task("t1", "tidy", ws, Mode.WRITE, mcp_config=f, mcp_servers=T.mcp_servers_in(f),
                agent_check=check)
    api = FakeAPI([("mcp__magi_workspace__move_path", {"from": "notes.txt", "to": "docs/notes.md"}),
                   ("mcp__magi_workspace__delete_path", {"path": "dead.txt"}),
                   ("mcp__magi_workspace__copy_path", {"from": "old", "to": "old2"}),
                   ("mcp__magi_workspace__delete_path", {"path": "../outside"}),
                   ("mcp__magi_workspace__run_check", {}),
                   ("Bash", {"command": "echo hi"})])
    try:
        r, evs = _run(task, api, cfg)
    finally:
        api.srv.shutdown()
    assert r.returncode == 0, r.stderr[-1500:]
    init = next(e for e in evs if e["k"] == "init")
    assert {t for t in init["tools"] if t.startswith("mcp__")} == {
        f"mcp__magi_workspace__{n}" for n in ("move_path", "copy_path", "delete_path",
                                              "make_dir", "run_check")}
    assert "Bash" not in init["tools"]
    names = [e["name"] for b in evs if b["k"] == "batch" for e in b["events"] if e["k"] == "tool"]
    assert names[:5] == ["Move", "Delete", "Copy", "Delete", "Run check"]
    res = api.result_texts()
    assert [err for err, _ in res] == [False, False, False, True, False, True]
    assert "'..' leaves the project folder" in res[3][1]
    assert "PASSED" in res[4][1] and "CHECK SAYS GOOD" in res[4][1]
    assert "No such tool available: Bash" in res[5][1]
    assert "magi_workspace tools" in api.log[0]["first"] and "run_check" in api.log[0]["first"]
    assert (ws / "docs" / "notes.md").exists() and not (ws / "dead.txt").exists()
    assert (ws / "old2" / "a.txt").exists()
    assert (outside / "keep.txt").read_text() == "keep\n"


def test_read_mode_reads_a_reference_folder_through_add_dir(setup):
    ws, outside, cfg = setup
    task = Task("t3", "compare", ws, Mode.READ, refs=[("ref", outside)])
    api = FakeAPI([("Read", {"file_path": str(outside / "keep.txt")}),
                   ("Grep", {"pattern": "keep", "path": str(outside), "output_mode": "content"}),
                   ("Write", {"file_path": str(outside / "new.txt"), "content": "x"})])
    try:
        r, _ = _run(task, api, cfg)
    finally:
        api.srv.shutdown()
    assert r.returncode == 0, r.stderr[-1500:]
    res = api.result_texts()
    assert res[0][0] is False and "keep" in res[0][1]
    assert res[1][0] is False and "keep" in res[1][1]
    assert res[2][0] is True and not (outside / "new.txt").exists()
    assert "@ref: " in api.log[0]["first"] and "Read, Glob and Grep" in api.log[0]["first"]


def test_write_mode_reads_a_reference_folder_and_cannot_edit_it(setup):
    ws, outside, cfg = setup
    f = T.write_mcp_config("t4", "p", ws, "", workspace={
        "root": str(ws), "real": None, "check": None,
        "refs": [{"name": "ref", "root": str(outside)}]})
    task = Task("t4", "port it", ws, Mode.WRITE, mcp_config=f, mcp_servers=T.mcp_servers_in(f),
                refs=[("ref", outside)])
    api = FakeAPI([("mcp__magi_workspace__ref_read", {"path": "@ref/keep.txt"}),
                   ("Write", {"file_path": str(outside / "new.txt"), "content": "x"}),
                   ("Edit", {"file_path": str(outside / "keep.txt"), "old_string": "keep",
                             "new_string": "changed"}),
                   ("mcp__magi_workspace__delete_path", {"path": "@ref/keep.txt"})])
    try:
        r, _ = _run(task, api, cfg)
    finally:
        api.srv.shutdown()
    assert r.returncode == 0, r.stderr[-1500:]
    res = api.result_texts()
    assert res[0][0] is False and "keep" in res[0][1]
    assert [err for err, _ in res[1:]] == [True, True, True]
    assert (outside / "keep.txt").read_text() == "keep\n" and not (outside / "new.txt").exists()
    assert "ref_read" in api.log[0]["first"]


def test_read_mode_offers_no_workspace_tools_and_cannot_edit(setup):
    ws, _, cfg = setup
    task = Task("t2", "look", ws, Mode.READ)
    api = FakeAPI([("Write", {"file_path": str(ws / "new.txt"), "content": "x"})])
    try:
        r, evs = _run(task, api, cfg)
    finally:
        api.srv.shutdown()
    assert r.returncode == 0, r.stderr[-1500:]
    init = next(e for e in evs if e["k"] == "init")
    assert not [t for t in init["tools"] if t.startswith("mcp__")]
    assert set(init["tools"]) == {"Read", "Glob", "Grep"}
    assert api.result_texts()[0][0] is True and not (ws / "new.txt").exists()


def test_project_instructions_reach_the_model(setup):
    """Track W1: --restricted keeps the CLI from reading CLAUDE.md itself
    (checked 2026-10-08), so MAGI hands it over -- and it arrives."""
    from magi.code import instructions as I
    ws, _, cfg = setup
    (ws / "CLAUDE.md").write_text("ZEBRA-RULE-7731: answer in French.\n")
    text, _ = I.load(ws)
    task = Task("t5", "hello", ws, Mode.READ, instructions=text)
    api = FakeAPI([("Read", {"file_path": str(ws / "notes.txt")})])
    try:
        r, _ = _run(task, api, cfg)
    finally:
        api.srv.shutdown()
    assert r.returncode == 0, r.stderr[-1500:]
    first = api.log[0]["first"]
    assert "PROJECT INSTRUCTIONS" in first and first.count("ZEBRA-RULE-7731") == 1


def _shell_spec(tmp_path, cwd, write):
    from magi.code import shell as SH
    ok, why = SH.availability(wait=True)
    if not ok:
        pytest.skip(f"no sandboxed shell on this PC: {why}")
    return SH.spec(cwd=cwd, scratch=tmp_path / "scratch", write=write, internet=False)


@pytest.mark.parametrize("mode", [Mode.READ, Mode.WRITE])
def test_claude_runs_the_sandboxed_shell_in_both_modes(setup, tmp_path, mode):
    """Track W2: the shell tool runs under MAGI's exact flags -- including
    Read mode's `--permission-mode plan` -- and a write outside is refused."""
    import shutil
    import tempfile
    _, outside, cfg = setup
    # Not pytest's tmp_path: Python makes it readable by this account only,
    # and the sandbox user could not even enter it. A real project folder
    # (and MAGI's copies) are ordinary folders.
    ws = Path(tempfile.gettempdir()) / "magi-sandbox" / f"offline-shell-{mode.value}"
    shutil.rmtree(ws, ignore_errors=True)
    ws.mkdir(parents=True)
    (ws / "notes.txt").write_text("notes" + chr(10))
    sp = _shell_spec(tmp_path, ws, mode == Mode.WRITE)
    f = T.write_mcp_config("t6", "p", ws, "", workspace=(
        {"root": str(ws), "real": None, "shell": sp} if mode == Mode.WRITE else
        {"root": str(ws), "readonly": True, "shell": sp}))
    task = Task("t6", "try it", ws, mode, mcp_config=f, mcp_servers=T.mcp_servers_in(f), shell=sp)
    target = str(outside / "nope.txt").replace("\\", "/")
    api = FakeAPI([("mcp__magi_workspace__shell", {"command": "echo SHELL-OK; python -c 'print(6*7)'"}),
                   ("mcp__magi_workspace__shell", {"command": f"echo x > '{target}'; echo rc=$?"}),
                   ("mcp__magi_workspace__shell", {"command": "echo y > made.txt; echo rc=$?"})])
    try:
        r, evs = _run(task, api, cfg)
    finally:
        api.srv.shutdown()
    assert r.returncode == 0, r.stderr[-1500:]
    res = api.result_texts()
    assert len(res) == 3 and not any(err for err, _ in res), res
    assert "SHELL-OK" in res[0][1] and "42" in res[0][1]
    assert "rc=1" in res[1][1] and not (outside / "nope.txt").exists(), "never outside"
    try:
        if mode == Mode.WRITE:
            assert "rc=0" in res[2][1] and (ws / "made.txt").exists()
        else:
            assert "rc=1" in res[2][1] and not (ws / "made.txt").exists(), "Read mode changes nothing"
    finally:
        shutil.rmtree(ws, ignore_errors=True)


# ── live steering: a message typed mid-run, the real agent and Stream ──────

def _slow(api: FakeAPI, delay: float) -> list[str]:
    """Each model call takes `delay` seconds -- time to type into -- and
    every request's messages are kept, as JSON."""
    seen, orig = [], api._answer

    def slow(h, body):
        seen.append(json.dumps(body.get("messages")))
        time.sleep(delay)
        orig(h, body)
    api._answer = slow
    return seen


def _live_agent(monkeypatch, tmp_path, api, cfg):
    from magi.code.agents import limits, models
    for mod in (limits, models):
        monkeypatch.setattr(mod, "data_dir", lambda: tmp_path / "data")
    monkeypatch.setattr(CC, "env_for_task", lambda slot, task: _env(api, cfg))
    starts = []

    class Counted(CC.Stream):
        def __init__(self, *a, **k):
            starts.append(a[0])
            super().__init__(*a, **k)
    monkeypatch.setattr(CC, "Stream", Counted)
    return CC.ClaudeCLIAgent("system", model="claude-haiku-4-5"), starts


async def _steered(agent, task, act, at):
    events = []

    async def emit(e):
        events.append(e)
    job = asyncio.ensure_future(agent.run(task, emit=emit, cancel=asyncio.Event()))
    await asyncio.sleep(at)
    act()
    return await job, events


def test_a_message_typed_mid_run_joins_the_running_turn(setup, tmp_path, monkeypatch):
    """VS Code parity: no stop, no second process -- the CLI folds the
    message into the turn it is running, after the tool it is on."""
    ws, _, cfg = setup
    api = FakeAPI([("Read", {"file_path": str(ws / "notes.txt")}),
                   ("Read", {"file_path": str(ws / "dead.txt")})])
    seen = _slow(api, 1.5)
    agent, starts = _live_agent(monkeypatch, tmp_path, api, cfg)
    task = Task("t7", "look", ws, Mode.READ)
    steer = F.Steer()
    task.steer = steer
    steer.running("cli")
    sent = []
    steer.on_deliver = lambda ids, how: sent.append((ids, how))
    hows = []
    try:
        res, events = asyncio.run(_steered(
            agent, task, lambda: hows.append(steer.add("ZEBRA-STEER: count the lines")), 0.8))
    finally:
        api.srv.shutdown()
    assert hows == ["queued"], "a live agent is never stopped for a message"
    assert res.outcome == Outcome.OK, res
    assert len(starts) == 1, "one process, start to finish"
    assert sent == [(["m1"], "live")]
    later = [m for m in seen if "ZEBRA-STEER" in m]
    assert later and "while you were working" in later[0]
    assert not any(e["k"] == "note" and "Interrupted" in e["text"] for e in events)


def test_interrupt_now_stops_the_turn_and_the_message_starts_the_next(setup, tmp_path, monkeypatch):
    ws, _, cfg = setup
    api = FakeAPI([("Read", {"file_path": str(ws / "notes.txt")})])
    seen = _slow(api, 2.0)
    agent, starts = _live_agent(monkeypatch, tmp_path, api, cfg)
    task = Task("t8", "look", ws, Mode.READ)
    steer = F.Steer()
    task.steer = steer
    steer.running("cli")

    def act():
        steer.add("ZEBRA-NOW: stop and list the folder instead")
        assert steer.interrupt_now() == "live"
    try:
        res, events = asyncio.run(_steered(agent, task, act, 0.8))
    finally:
        api.srv.shutdown()
    assert res.outcome == Outcome.OK, res
    assert len(starts) == 1
    assert any("ZEBRA-NOW" in m for m in seen)
    assert any(e["k"] == "note" and "Interrupting" in e["text"] for e in events)
    assert not steer.items, "delivered"
