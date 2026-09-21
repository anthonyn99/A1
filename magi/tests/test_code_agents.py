"""The coding agents and the fallback chain.

The property this file exists to pin: **when an agent runs out, the work goes
on; when a task fails, it stops.** Get the first half wrong and Code Mode dies
the moment Claude's allowance does. Get the second half wrong and one failing
test suite burns through every account on the chain, one after another.

The CLI event lines below are shaped exactly like real runs captured from
Claude Code 2.1 and Codex 0.155 (the Codex schema is its own SDK's, generated
from codex-rs/exec/src/exec_events.rs), trimmed and with paths neutralised --
so parsing is tested against what the CLIs actually emit, without needing a
signed-in CLI in CI.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from magi.code.agents import chain, claude_cli, codex_cli, context, limits, slots
from magi.code.agents.base import CodingAgent, Mode, Outcome, Result, Task


# ── Claude Code stream-json ────────────────────────────────────────────────

CLAUDE_OK = [
    {"type": "system", "subtype": "init", "model": "claude-sonnet-5",
     "session_id": "s-1", "tools": ["Read", "Glob", "Grep"]},
    {"type": "rate_limit_event", "rate_limit_info": {
        "status": "allowed", "resetsAt": 1789964400, "rateLimitType": "five_hour",
        "unifiedWindows": {"five_hour": {"utilization": 0.35, "resetsAt": 1789964400},
                           "seven_day": {"utilization": 0.71, "resetsAt": 1790226000}}}},
    {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Read", "input": {"file_path": "/p/workspace.py"}}]}},
    {"type": "user", "message": {"content": [{"type": "tool_result"}]}},
    {"type": "assistant", "message": {"content": [
        {"type": "text", "text": "It registers and inspects workspaces."}]}},
    {"type": "result", "subtype": "success", "is_error": False,
     "result": "It registers and inspects workspaces.", "num_turns": 2,
     "session_id": "s-1"},
]


def _lines(objs):
    return [json.dumps(o) + "\n" for o in objs]


def test_claude_init_is_recognised():
    ev = claude_cli.parse_line(_lines(CLAUDE_OK)[0])
    assert ev == {"k": "init", "model": "claude-sonnet-5", "session_id": "s-1",
                  "tools": ["Read", "Glob", "Grep"]}


def test_claude_rate_limit_event_carries_utilisation():
    """This is what lets MAGI show "71% of the week used" BEFORE the wall."""
    ev = claude_cli.parse_line(_lines(CLAUDE_OK)[1])
    assert ev["k"] == "ratelimit"
    assert ev["status"] == "allowed"
    assert ev["windows"]["seven_day"]["utilization"] == 0.71
    assert ev["resets_at"] == 1789964400


def test_claude_tool_calls_name_their_target():
    ev = claude_cli.parse_line(_lines(CLAUDE_OK)[2])
    assert ev == {"k": "batch", "events": [{"k": "tool", "name": "Read",
                                           "target": "/p/workspace.py"}]}


def test_claude_result_is_parsed():
    ev = claude_cli.parse_line(_lines(CLAUDE_OK)[-1])
    assert ev["k"] == "result" and ev["ok"] is True and ev["turns"] == 2


def test_claude_noise_is_ignored():
    for junk in ("", "   ", "not json", "{broken", '{"type":"user","message":{}}'):
        assert claude_cli.parse_line(junk) is None


@pytest.mark.parametrize("text,status,want", [
    ("", 429, Outcome.LIMITED),
    ("", 401, Outcome.UNAUTHED),
    ("Invalid API key · Please run /login", None, Outcome.UNAUTHED),
    ("Claude usage limit reached. Your limit will reset at 5pm", None, Outcome.LIMITED),
    ("You've hit your limit", None, Outcome.LIMITED),
    # The one that must NOT hand off: the agent did the work and it failed.
    ("3 tests failed in test_workspace.py", None, Outcome.TASK_FAILED),
])
def test_claude_failures_are_classified(text, status, want):
    assert claude_cli.classify_failure(text, status) == want


def test_claude_read_mode_pins_the_exact_tool_list():
    """--restricted alone still offered Artifact, PushNotification and
    SendMessage -- tools that can send project content off the machine."""
    argv = claude_cli.build_argv("claude", Task("t", "q", Path("."), Mode.READ))
    assert "--tools" in argv
    assert argv[argv.index("--tools") + 1] == "Read,Glob,Grep"


def test_claude_never_loads_the_projects_own_settings():
    """In A1, .claude/settings.json's Stop hook runs `git add -A`, commit and
    push. --restricted is what keeps it from firing after every task."""
    argv = claude_cli.build_argv("claude", Task("t", "q", Path("."), Mode.READ))
    assert "--restricted" in argv
    assert "--strict-mcp-config" in argv
    assert argv[argv.index("--permission-mode") + 1] == "plan"


def test_claude_prompt_never_goes_through_argv():
    """A .cmd shim + cmd.exe quoting turns `&` or `%` in prose into commands."""
    argv = claude_cli.build_argv("claude", Task("t", "delete everything & reboot", Path(".")))
    assert not any("delete everything" in a for a in argv)


# ── Codex exec --json ──────────────────────────────────────────────────────

CODEX_OK = [
    {"type": "thread.started", "thread_id": "th-1"},
    {"type": "turn.started"},
    {"type": "item.started", "item": {"id": "i1", "type": "command_execution",
                                      "command": "rg -n handoff", "aggregated_output": "",
                                      "status": "in_progress"}},
    {"type": "item.completed", "item": {"id": "i1", "type": "command_execution",
                                        "command": "rg -n handoff", "aggregated_output": "x",
                                        "exit_code": 0, "status": "completed"}},
    {"type": "item.completed", "item": {"id": "i2", "type": "agent_message",
                                        "text": "It continues rather than restarting."}},
    {"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 5}},
]


def test_codex_events_are_normalised():
    got = [codex_cli.parse_line(x) for x in _lines(CODEX_OK)]
    assert got[0] == {"k": "init", "session_id": "th-1"}
    assert got[2] == {"k": "tool", "name": "Bash", "target": "rg -n handoff"}
    # A COMPLETED command is not a second tool call.
    assert got[3] is None
    assert got[4] == {"k": "text", "text": "It continues rather than restarting."}
    assert got[5]["k"] == "done"


def test_codex_file_changes_list_their_paths():
    line = json.dumps({"type": "item.completed", "item": {
        "id": "i", "type": "file_change", "status": "completed",
        "changes": [{"path": "a.py", "kind": "update"}, {"path": "b.py", "kind": "add"}]}})
    assert codex_cli.parse_line(line) == {"k": "tool", "name": "Edit", "target": "a.py, b.py"}


def test_codex_unauthenticated_run_is_recognised():
    """Captured from a real run with an empty CODEX_HOME."""
    line = json.dumps({"type": "error", "message": (
        "Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or "
        "basic authentication in header, url: wss://api.openai.com/v1/responses)")})
    ev = codex_cli.parse_line(line)
    assert ev["k"] == "error"
    assert codex_cli.classify_failure(ev["text"]) == Outcome.UNAUTHED


@pytest.mark.parametrize("text,want", [
    ("You've hit your usage limit. Try again in 2 hours 13 minutes.", Outcome.LIMITED),
    ("stream error: 429 Too Many Requests", Outcome.LIMITED),
    ("401 Unauthorized", Outcome.UNAUTHED),
    ("cargo test: 2 failed", Outcome.TASK_FAILED),
])
def test_codex_failures_are_classified(text, want):
    assert codex_cli.classify_failure(text) == want


def test_codex_reset_time_is_read_from_the_message():
    t = codex_cli.parse_reset("Try again in 2 hours 13 minutes.")
    assert t is not None
    assert abs((t - time.time()) - (2 * 3600 + 13 * 60)) < 5


def test_codex_read_mode_is_sandboxed_and_ignores_repo_config():
    argv = codex_cli.build_argv("codex", Task("t", "q", Path("C:/p"), Mode.READ))
    assert argv[argv.index("--sandbox") + 1] == "read-only"
    for flag in ("--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json"):
        assert flag in argv
    assert argv[-1] == "-", "the prompt goes in on stdin"


# ── account slots ──────────────────────────────────────────────────────────

def test_codex_is_not_tied_to_any_other_login(tmp_path, monkeypatch):
    """Each slot is its own directory, so Codex can be signed in to ANY
    ChatGPT account -- not the one the council's ChatGPT unit uses."""
    monkeypatch.setattr(slots, "profiles_dir", lambda: tmp_path)
    a = slots.env_for("codex", "work")["CODEX_HOME"]
    b = slots.env_for("codex", "personal")["CODEX_HOME"]
    assert a != b
    assert Path(a).parent == Path(b).parent == tmp_path / "cli"


def test_claude_slots_get_their_own_config_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(slots, "profiles_dir", lambda: tmp_path)
    assert slots.env_for("claude", "alt")["CLAUDE_CONFIG_DIR"].endswith("claude-alt")
    # The system slot uses the CLI's own default: this PC's existing login.
    assert "CLAUDE_CONFIG_DIR" not in slots.env_for("claude", slots.SYSTEM_SLOT)


def test_no_api_key_can_leak_into_a_cli(monkeypatch):
    """An API key in the environment outranks the slot's login in both CLIs --
    it would silently bill an account nobody chose."""
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY",
              "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.setenv(k, "sk-should-not-appear")
    for agent, slot in (("claude", "system"), ("codex", "x")):
        env = slots.env_for(agent, slot)
        assert "sk-should-not-appear" not in env.values()


def test_the_agents_own_shell_cannot_read_its_credentials():
    assert slots.env_for("claude", "system")["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] == "1"


def test_slot_names_cannot_escape(tmp_path, monkeypatch):
    monkeypatch.setattr(slots, "profiles_dir", lambda: tmp_path)
    for bad in ("../x", "a/b", "", "X" * 30, "a b"):
        with pytest.raises(ValueError):
            slots.check_slot_name(bad)


def test_the_system_slot_cannot_be_deleted_by_magi():
    with pytest.raises(ValueError):
        slots.remove("claude", slots.SYSTEM_SLOT)


def test_codex_signs_in_with_a_device_code():
    """So the sign-in can happen on the phone in your hand, not only at the PC."""
    assert slots.login_argv("codex")[-2:] == ["login", "--device-auth"]


# ── remembered limits ──────────────────────────────────────────────────────

@pytest.fixture
def fresh_limits(tmp_path, monkeypatch):
    monkeypatch.setattr(limits, "data_dir", lambda: tmp_path)
    return tmp_path


def test_a_limit_is_remembered_until_it_resets(fresh_limits):
    limits.mark("claude", "system", time.time() + 600)
    assert limits.blocked_until("claude", "system") is not None
    assert limits.blocked_until("codex", "x") is None


def test_a_past_reset_time_does_not_block(fresh_limits):
    limits.mark("claude", "system", time.time() + 600)
    d = json.loads((fresh_limits / "agent_limits.json").read_text())
    d["claude:system"]["until"] = time.time() - 1
    (fresh_limits / "agent_limits.json").write_text(json.dumps(d))
    assert limits.blocked_until("claude", "system") is None


def test_a_limit_without_a_reset_time_backs_off_not_forever(fresh_limits):
    until = limits.mark("codex", "a", None)
    assert 60 < until - time.time() <= limits.DEFAULT_BACKOFF_S + 1


def test_success_clears_a_limit(fresh_limits):
    limits.mark("claude", "system", time.time() + 600)
    limits.clear("claude", "system")
    assert limits.blocked_until("claude", "system") is None


# ── the chain ──────────────────────────────────────────────────────────────

class Fake(CodingAgent):
    kind = "fake"

    def __init__(self, name, outcome, text="", available=True):
        self.id, self.label = name, name
        self._o, self._t, self._a = outcome, text, available
        self.runs = 0
        self.seen_note = None

    async def available(self):
        return self._a, "" if self._a else "not signed in"

    async def run(self, task, *, emit, cancel):
        self.runs += 1
        self.seen_note = task.handoff_note
        return Result(self._o, text=self._t, detail=str(self._o))


def _run(agents, cancel=None):
    events = []

    async def emit(ev):
        events.append(ev)

    task = Task("t", "do the thing", Path("."))
    res = asyncio.run(chain.run_chain(task, agents, emit=emit,
                                      cancel=cancel or asyncio.Event()))
    return res, events


def test_the_first_agent_that_succeeds_finishes_it():
    a, b = Fake("claude", Outcome.OK, "done"), Fake("codex", Outcome.OK)
    res, _ = _run([a, b])
    assert res.outcome == Outcome.OK and res.by == "claude"
    assert b.runs == 0, "nobody behind a success should be woken"


def test_a_limit_hands_off_to_the_next_agent():
    a = Fake("claude", Outcome.LIMITED, "halfway there")
    b = Fake("codex", Outcome.OK, "finished")
    res, ev = _run([a, b])
    assert res.outcome == Outcome.OK and res.by == "codex"
    assert any(e["k"] == "handoff" and e["from"] == "claude" for e in ev)


def test_signed_out_and_unavailable_hand_off_too():
    for o in (Outcome.UNAUTHED, Outcome.UNAVAILABLE):
        res, _ = _run([Fake("a", o), Fake("b", Outcome.OK)])
        assert res.by == "b", o


def test_a_task_failure_STOPS_the_chain():
    """If the tests failed under Claude they will fail under Codex too --
    handing on would spend a second allowance proving it."""
    a = Fake("claude", Outcome.TASK_FAILED, "tests failed")
    b = Fake("codex", Outcome.OK)
    res, _ = _run([a, b])
    assert res.outcome == Outcome.TASK_FAILED
    assert b.runs == 0


def test_the_next_agent_continues_rather_than_restarts():
    a = Fake("claude", Outcome.LIMITED, "found the bug in chain.py line 90")
    b = Fake("codex", Outcome.OK)
    _run([a, b])
    assert b.seen_note, "the second agent must be told about the first"
    assert "Continue it rather than beginning again" in b.seen_note
    assert "found the bug in chain.py line 90" in b.seen_note


def test_an_unavailable_agent_is_skipped_without_running():
    a = Fake("claude", Outcome.OK, available=False)
    b = Fake("codex", Outcome.OK)
    res, ev = _run([a, b])
    assert a.runs == 0 and res.by == "codex"
    assert any(e["k"] == "skip" for e in ev)


def test_every_agent_out_is_reported_not_hung():
    res, ev = _run([Fake("a", Outcome.LIMITED), Fake("b", Outcome.UNAUTHED)])
    assert res.outcome == Outcome.UNAVAILABLE
    assert any(e["k"] == "error" for e in ev)
    assert [a.outcome for a in res.attempts] == ["limited", "unauthed"]


def test_an_empty_chain_says_so():
    res, ev = _run([])
    assert res.outcome == Outcome.UNAVAILABLE
    assert "nothing is ticked" in ev[0]["text"]


def test_halt_stops_everything():
    cancel = asyncio.Event()
    cancel.set()
    b = Fake("b", Outcome.OK)
    res, _ = _run([b], cancel=cancel)
    assert res.outcome == Outcome.CANCELLED and b.runs == 0


def test_one_agent_crashing_does_not_end_the_chain():
    class Boom(Fake):
        async def run(self, task, *, emit, cancel):
            raise RuntimeError("segfault-ish")
    res, _ = _run([Boom("a", Outcome.OK), Fake("b", Outcome.OK)])
    assert res.by == "b"


def test_claude_and_codex_lead_the_default_order():
    assert chain.DEFAULT_ORDER[:2] == ["claude-cli", "codex-cli"]
    # ...and every council unit is behind them, so any unit can finish a task.
    for u in ("claude-pro", "chatgpt", "claude", "gemini", "deepseek", "grok", "perplexity"):
        assert u in chain.DEFAULT_ORDER


# ── context for browser agents ─────────────────────────────────────────────

def test_context_never_leaves_the_workspace(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (tmp_path / "outside.txt").write_text("OUTSIDE-SECRET", encoding="utf-8")
    assert context.contained(root, Path("../outside.txt")) is None


def test_context_never_reads_secrets(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    for name in (".env", ".env.local", "id_rsa", "server.pem", "auth.json",
                 ".credentials.json", "secrets.yaml"):
        assert context.is_secret(root / name), name
    assert not context.is_secret(root / "main.py")


def test_context_is_byte_bounded(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "big.py").write_text("x = 1\n" * 50_000, encoding="utf-8")
    out = context.gather(root, "look at big.py")
    assert len(out) <= context.BUDGET


def test_a_named_file_is_included(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "app.py").write_text("def hello():\n    return 1\n", encoding="utf-8")
    out = context.gather(root, "what does app.py do?")
    assert "FILE: app.py" in out and "def hello" in out


def test_a_named_secret_is_not_included_even_when_asked_for(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".env").write_text("TOKEN=hunter2", encoding="utf-8")
    assert "hunter2" not in context.gather(root, "show me .env")


# ── what you call an account ───────────────────────────────────────────────

def test_a_slot_can_be_renamed_without_touching_its_login(tmp_path, monkeypatch):
    monkeypatch.setattr(slots, "profiles_dir", lambda: tmp_path)
    d = slots.create("codex", "codex1")
    (d / "auth.json").write_text("{}", encoding="utf-8")
    assert slots.set_label("codex", "codex1", "  Tony  free  ") == "Tony free"
    assert slots.label_of("codex", "codex1") == "Tony free"
    # The login is untouched, and the folder is still the folder.
    assert (d / "auth.json").exists()
    # Cleared again by saving an empty name.
    slots.set_label("codex", "codex1", "")
    assert slots.label_of("codex", "codex1") == ""


def test_removing_a_slot_forgets_its_name_too(tmp_path, monkeypatch):
    monkeypatch.setattr(slots, "profiles_dir", lambda: tmp_path)
    slots.create("codex", "spare")
    slots.set_label("codex", "spare", "old account")
    slots.remove("codex", "spare")
    assert slots.label_of("codex", "spare") == ""


def test_the_name_you_gave_an_account_is_what_the_transcript_says(tmp_path, monkeypatch):
    monkeypatch.setattr(slots, "profiles_dir", lambda: tmp_path)
    slots.set_label("codex", "codex1", "Tony free")
    assert codex_cli.CodexCLIAgent("codex1").label == "Codex (Tony free)"
    slots.set_label("claude", slots.SYSTEM_SLOT, "this PC")
    assert claude_cli.ClaudeCLIAgent(slots.SYSTEM_SLOT).label == "Claude (this PC)"


# ── Codex's usage, which it does not report while it runs ──────────────────

_ROLLOUT = (
    '{"timestamp":"2026-09-20T18:20:02","type":"event_msg","payload":{"type":"token_count",'
    '"rate_limits":{"limit_id":"codex","primary":{"used_percent":37.5,"window_minutes":300,'
    '"resets_at":1792542002},"secondary":{"used_percent":4.0,"window_minutes":43200,'
    '"resets_at":1792550000},"plan_type":"free"}}}\n'
)


def _rollout(tmp_path, monkeypatch, body: str):
    monkeypatch.setattr(slots, "profiles_dir", lambda: tmp_path)
    d = slots.create("codex", "codex1") / "sessions" / "2026" / "09" / "20"
    d.mkdir(parents=True)
    (d / "rollout-2026-09-20T18-20-01-abc.jsonl").write_text(body, encoding="utf-8")


def test_codex_usage_is_read_from_its_own_session_log(tmp_path, monkeypatch):
    """`codex exec --json` reports tokens, never windows. The percentages do
    exist -- in the rollout file -- so MAGI reads them instead of walking
    into the limit to find out."""
    _rollout(tmp_path, monkeypatch, _ROLLOUT)
    u = codex_cli.session_usage("codex1")
    assert u["5h"]["utilization"] == 0.375
    assert u["30d"]["utilization"] == 0.04
    assert u["5h"]["resets_at"] == 1792542002


def test_the_latest_reading_wins(tmp_path, monkeypatch):
    later = _ROLLOUT.replace('"used_percent":37.5', '"used_percent":91.0')
    _rollout(tmp_path, monkeypatch, _ROLLOUT + later)
    assert codex_cli.session_usage("codex1")["5h"]["utilization"] == 0.91


def test_codex_usage_survives_a_log_that_never_mentions_limits(tmp_path, monkeypatch):
    _rollout(tmp_path, monkeypatch, '{"type":"turn.completed","usage":{"input_tokens":9}}\n')
    assert codex_cli.session_usage("codex1") == {}


def test_codex_windows_are_named_the_way_you_would_say_them():
    assert codex_cli._window_name(300) == "5h"
    assert codex_cli._window_name(43200) == "30d"
    assert codex_cli._window_name(10080) == "7d"
    assert codex_cli._window_name(45) == "45m"
