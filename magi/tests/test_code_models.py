"""Phase 11B: models, usage credits, Auto, caps and warnings.

The provider bodies are the real shapes captured live on 2026-09-24 (a Pro
Claude account with usage credits off; a free ChatGPT account), trimmed.
The CLI runs are a scripted stream, so the retry-on-credits and the mid-run
cap are exercised without spending anything.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from magi.code.agents import claude_cli as CC
from magi.code.agents import codex_cli as CX
from magi.code.agents import limits, slots
from magi.code.agents import models as M
from magi.code.agents import usage_fetch as U
from magi.code.agents.base import Mode, Outcome, Task

CLAUDE_MODELS = {"data": [
    {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5",
     "capabilities": {"effort": {e: {"supported": True} for e in ("low", "medium", "high", "xhigh", "max")}}},
    {"id": "claude-fable-5-1", "display_name": "Claude Fable 5.1"},
    {"id": "claude-opus-5", "display_name": "Claude Opus 5"},
    {"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5",
     "capabilities": {"effort": {e: {"supported": True} for e in ("low", "medium", "high")}}},
    {"id": "claude-fable-5", "display_name": "Claude Fable 5"},
    {"id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5"},
    {"id": "claude-sonnet-4-5-20250929", "display_name": "Claude Sonnet 4.5"},
    {"id": "not-a-claude-model", "display_name": "x"},
]}
PRO_PROFILE = {"account": {"has_claude_max": False, "has_claude_pro": True},
               "organization": {"organization_type": "claude_pro"}}
CODEX_MODELS = {"models": [
    {"slug": "gpt-6-luna", "display_name": "GPT-6-Luna", "visibility": "list", "priority": 3,
     "description": "Fast and affordable model for easier tasks.",
     "supported_reasoning_levels": [{"effort": e} for e in ("low", "medium", "high", "xhigh", "max")]},
    {"slug": "gpt-reserve", "display_name": "GPT-Reserve", "visibility": "hide", "priority": 3},
    {"slug": "gpt-5.6-terra", "display_name": "GPT-5.6-Terra", "visibility": "list", "priority": 7,
     "description": "Older balanced model for straightforward work.",
     "supported_reasoning_levels": [{"effort": e} for e in ("low", "medium", "high", "xhigh", "max")]},
    {"slug": "gpt-5.5", "display_name": "GPT-5.5", "visibility": "list", "priority": 12,
     "description": "Legacy coding model.",
     "supported_reasoning_levels": [{"effort": e} for e in ("low", "medium", "high", "xhigh")]},
    {"slug": "codex-auto-review", "visibility": "hide", "priority": 43},
]}
CLAUDE_USAGE_OFF = {
    "five_hour": {"utilization": 6.0, "resets_at": "2099-09-24T17:40:00+00:00"},
    "seven_day": {"utilization": 1.0, "resets_at": "2099-10-01T05:00:00+00:00"},
    "extra_usage": {"is_enabled": False, "monthly_limit": None, "used_credits": None,
                    "disabled_reason": None, "user_disabled": True, "spend_limit_reached": False},
}
CODEX_USAGE_FREE = {"plan_type": "free", "rate_limit": {
    "allowed": True, "limit_reached": False,
    "primary_window": {"used_percent": 7, "limit_window_seconds": 2592000, "reset_at": 4102444800},
    "secondary_window": None},
    "credits": {"has_credits": False, "unlimited": False, "overage_limit_reached": False, "balance": None}}


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Everything this phase stores, in a temporary profile folder."""
    for mod in (M, limits):
        monkeypatch.setattr(mod, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(slots, "cli_root", lambda: tmp_path / "cli")
    (tmp_path / "cli").mkdir(exist_ok=True)
    monkeypatch.setattr(U, "_last", {})
    return tmp_path


def seed(agent, slot, models, plan=""):
    cat = M._read(M._catalog_path())
    cat.setdefault("slots", {})[limits.key(agent, slot)] = {
        "models": models, "plan": plan, "fetched_at": time.time()}
    M._write(M._catalog_path(), cat)


def credits(agent, slot, enabled, exhausted=False, **more):
    limits.note_account(agent, slot, {"credits": {"enabled": enabled, "exhausted": exhausted}, **more})


FUTURE = time.time() + 3 * 3600


# ── reading the providers' lists ──────────────────────────────────────────

def test_claude_models_strongest_first_newest_marked():
    ms = M.parse_claude_models(CLAUDE_MODELS)
    ids = [m["id"] for m in ms]
    assert "not-a-claude-model" not in ids
    # Opus 5.5 outranks Opus 5 (a bare list compare put the shorter first).
    assert ids.index("claude-opus-5-5") < ids.index("claude-opus-5")
    assert ids.index("claude-fable-5-1") < ids.index("claude-fable-5")
    latest = {m["id"] for m in ms if m["latest"]}
    assert latest == {"claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"}
    op = next(m for m in ms if m["id"] == "claude-opus-5-5")
    assert op["label"] == "Opus 5.5" and op["tier"] == 3 and op["efforts"][-1] == "max"
    assert [m["tier"] for m in ms] == sorted((m["tier"] for m in ms), reverse=True)


@pytest.mark.parametrize("profile,plan", [
    (PRO_PROFILE, "pro"),
    ({"account": {"has_claude_max": True}, "organization": {"organization_type": "claude_max"}}, "max"),
    ({"account": {}, "organization": {"organization_type": "claude_team"}}, "team"),
    ({"account": {}, "organization": {}}, "free"),
    ({}, ""),
])
def test_the_claude_plan(profile, plan):
    assert M.claude_plan(profile) == plan


def test_codex_lists_only_what_its_picker_lists():
    ms = M.parse_codex_models(CODEX_MODELS)
    assert [m["id"] for m in ms] == ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.5"]
    luna = ms[0]
    assert luna["light"] and luna["efforts"][-1] == "max" and luna.get("latest")
    assert not ms[1]["light"]


def test_catalog_is_cached_and_a_failure_is_not_retried_every_minute(home, monkeypatch):
    calls = []
    monkeypatch.setattr(M, "fetch_claude", lambda slot: calls.append(slot) or {
        "models": M.parse_claude_models(CLAUDE_MODELS), "plan": "pro"})
    a = M.catalog("claude", "system")
    b = M.catalog("claude", "system")
    assert calls == ["system"] and a["plan"] == b["plan"] == "pro"
    M.catalog("claude", "system", force=True)
    assert len(calls) == 2
    monkeypatch.setattr(M, "fetch_claude", lambda slot: calls.append("x") or None)
    cat = M._read(M._catalog_path())
    cat["slots"]["claude:system"]["fetched_at"] = 0          # stale
    M._write(M._catalog_path(), cat)
    kept = M.catalog("claude", "system")
    again = M.catalog("claude", "system")
    assert calls[-1] == "x" and calls.count("x") == 1, "a failed read waits FAIL_TTL"
    assert kept["models"] and again["models"], "the old list is kept through a failed read"


def test_codex_falls_back_to_the_clis_own_cache(home, monkeypatch):
    d = slots.slot_dir("codex", "c1")
    d.mkdir(parents=True)
    (d / "models_cache.json").write_text(json.dumps(CODEX_MODELS), "utf-8")
    monkeypatch.setattr(M, "_http_json", lambda url, h: None)
    got = M.fetch_codex("c1")
    assert [m["id"] for m in got["models"]] == ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.5"]


# ── usage credits, as the usage answer states them ───────────────────────

def test_claude_credits_are_read_from_extra_usage():
    assert U.claude_account(CLAUDE_USAGE_OFF)["credits"]["enabled"] is False
    on = {**CLAUDE_USAGE_OFF, "extra_usage": {"is_enabled": True, "spend_limit_reached": False}}
    assert U.claude_account(on)["credits"] == {**U.claude_account(on)["credits"], "enabled": True,
                                                "exhausted": False}
    spent = {**CLAUDE_USAGE_OFF, "extra_usage": {"is_enabled": True, "spend_limit_reached": True}}
    assert U.claude_account(spent)["credits"]["exhausted"] is True


def test_codex_credits_and_plan():
    a = U.codex_account(CODEX_USAGE_FREE)
    assert a["plan"] == "free" and a["credits"]["enabled"] is False and a["allowed"] is True
    rich = {**CODEX_USAGE_FREE, "credits": {"has_credits": True, "overage_limit_reached": False}}
    assert U.codex_account(rich)["credits"]["enabled"] is True


def test_turning_credits_on_after_a_limit_lets_the_account_work_again(home, monkeypatch):
    full = {**CLAUDE_USAGE_OFF, "five_hour": {"utilization": 100.0, "resets_at": "2099-01-01T00:00:00+00:00"}}
    monkeypatch.setattr(U, "_claude_creds", lambda slot: _creds(home))
    limits.mark("claude", "system", FUTURE, "rate_limit_event")
    monkeypatch.setattr(U, "_get", lambda url, h: full)
    U.refresh("claude", "system", force=True)
    assert limits.blocked_until("claude", "system"), "credits off: still limited"
    on = {**full, "extra_usage": {"is_enabled": True, "spend_limit_reached": False}}
    monkeypatch.setattr(U, "_get", lambda url, h: on)
    U.refresh("claude", "system", force=True)
    assert limits.blocked_until("claude", "system") is None, "credits on: the limit is lifted"
    assert M.credits("claude", "system")["enabled"] is True


def _creds(home):
    p = home / "creds.json"
    p.write_text(json.dumps({"claudeAiOauth": {"accessToken": "tok", "expiresAt": (time.time() + 3600) * 1000}}))
    return p


def test_the_account_record_is_not_rewritten_when_nothing_changed(home):
    credits("claude", "system", False)
    f = home / "agent_limits.json"
    before = f.stat().st_mtime_ns
    time.sleep(0.02)
    credits("claude", "system", False)
    assert f.stat().st_mtime_ns == before
    credits("claude", "system", True)
    assert f.stat().st_mtime_ns != before


# ── may this account run this model? ─────────────────────────────────────

@pytest.fixture
def pro(home):
    seed("claude", "system", M.parse_claude_models(CLAUDE_MODELS), plan="pro")
    credits("claude", "system", False)
    return home


def _m(agent, slot, mid):
    return next(m for m in M.models_for(agent, slot) if m["id"] == mid)


def test_fable_on_pro_with_credits_off_cannot_be_used(pro):
    f = _m("claude", "system", "claude-fable-5-1")
    assert f["credits"] and not f["available"] and "usage credits" in f["why"]
    assert _m("claude", "system", "claude-opus-5-5")["available"]


def test_credits_turned_on_make_it_available_without_anything_else(pro):
    credits("claude", "system", True)
    f = _m("claude", "system", "claude-fable-5-1")
    assert f["available"] and f["why"] == "on usage credits"
    credits("claude", "system", True, exhausted=True)
    assert not _m("claude", "system", "claude-fable-5-1")["available"]


def test_a_max_plan_runs_fable_without_credits(home):
    seed("claude", "system", M.parse_claude_models(CLAUDE_MODELS), plan="max")
    credits("claude", "system", False)
    assert _m("claude", "system", "claude-fable-5-1")["available"]


def test_a_model_the_provider_refused_for_credits_is_remembered(home):
    seed("claude", "system", M.parse_claude_models(CLAUDE_MODELS), plan="max")
    credits("claude", "system", False)
    M.note_gated("claude", "system", "claude-opus-5-5", True)
    assert not _m("claude", "system", "claude-opus-5-5")["available"]
    M.note_gated("claude", "system", "claude-opus-5-5", False)
    assert _m("claude", "system", "claude-opus-5-5")["available"]


def test_a_used_up_plan_runs_only_on_credits(pro):
    limits.note_usage("claude", "system", "five_hour", 1.0, FUTURE)
    assert not _m("claude", "system", "claude-sonnet-5")["available"]
    credits("claude", "system", True)
    s = _m("claude", "system", "claude-sonnet-5")
    assert s["available"] and "credits" in s["why"]


def test_a_used_up_window_that_has_reset_is_not_used_up(pro):
    limits.note_usage("claude", "system", "five_hour", 1.0, time.time() - 5)
    assert M.plan_used_up("claude", "system") is None


# ── Auto ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("prompt,mode,tier", [
    ("what does tasks.py do?", "read", 1),
    ("Add a docstring to foo", "write", 1),
    ("Fix the bug where the save button does nothing on mobile", "read", 2),
    ("Refactor the scheduler to fix the race condition", "read", 3),
    ("Implement a new feature: export to CSV with tests", "write", 3),
    ("Think hard: design a new sync protocol from scratch", "read", 4),
])
def test_classify(prompt, mode, tier):
    assert M.classify(prompt, mode)["tier"] == tier


def test_a_long_brief_with_a_trace_weighs_more():
    brief = "The export fails.\n```\nTraceback (most recent call last):\n  x\n```\n" + "detail " * 300
    assert M.classify(brief)["tier"] >= 3


def test_auto_picks_the_strongest_model_the_account_can_run(pro):
    hard = "Think hard: design a new sync protocol from scratch"
    c = M.choose("claude", "system", hard)
    assert c["auto"] and c["model"] == "claude-opus-5-5", "Fable needs credits that are off"
    assert c["effort"] == "xhigh"
    credits("claude", "system", True)
    assert M.choose("claude", "system", hard)["model"] == "claude-fable-5-1"
    easy = M.choose("claude", "system", "what does tasks.py do?")
    assert easy["model"] == "claude-sonnet-5" and easy["effort"] == "low"


def test_auto_steps_down_when_the_allowance_is_running_low(pro):
    limits.note_usage("claude", "system", "seven_day", 0.9, FUTURE)
    c = M.choose("claude", "system", "Refactor the scheduler to fix the race condition")
    assert c["model"] == "claude-sonnet-5" and "one step lighter" in c["why"]


def test_codex_auto(home):
    seed("codex", "c1", M.parse_codex_models(CODEX_MODELS))
    credits("codex", "c1", False)
    assert M.choose("codex", "c1", "what does x do?")["model"] == "gpt-6-luna"
    everyday = M.choose("codex", "c1", "Fix the bug where save does nothing on mobile")
    assert everyday["model"] == "gpt-6-luna", "the provider's recommended model"
    hard = M.choose("codex", "c1", "Think hard: design a sync protocol from scratch")
    assert hard["model"] == "gpt-6-luna" and hard["effort"] == "xhigh"


def test_your_choice_is_honoured(pro):
    M.set_choice("claude", "claude-opus-5", "high")
    c = M.choose("claude", "system", "anything")
    assert (c["model"], c["effort"], c["auto"]) == ("claude-opus-5", "high", False)


def test_a_chosen_model_that_needs_credits_falls_back_to_auto_and_says_why(pro):
    M.set_choice("claude", "claude-fable-5-1", "auto")
    c = M.choose("claude", "system", "Refactor the scheduler")
    assert c["model"] != "claude-fable-5-1" and c["auto"]
    assert "usage credits" in c["note"] and "Auto chose instead" in c["note"]
    assert c["note"].startswith("Fable 5.1 runs on") and c["note"].count("Fable 5.1") == 1
    credits("claude", "system", True)
    assert M.choose("claude", "system", "Refactor the scheduler")["model"] == "claude-fable-5-1"


def test_effort_is_clamped_to_what_the_model_supports(pro):
    M.set_choice("claude", "claude-sonnet-5", "max")
    assert M.choose("claude", "system", "x")["effort"] == "high"


def test_with_no_list_your_choice_passes_through_and_auto_uses_the_default(home):
    assert M.choose("claude", "system", "x")["model"] is None
    M.set_choice("claude", "claude-opus-5", "auto")
    assert M.choose("claude", "system", "x")["model"] == "claude-opus-5"


@pytest.mark.parametrize("bad", [("claude", "rm -rf /", "auto"), ("claude", "auto", "ultra-mega"),
                                 ("gemini", "auto", "auto")])
def test_choices_are_validated(home, bad):
    with pytest.raises(ValueError):
        M.set_choice(*bad)


# ── caps ─────────────────────────────────────────────────────────────────

def test_a_cap_holds_until_the_window_resets(pro):
    limits.note_usage("claude", "system", "seven_day", 0.81, FUTURE)
    assert M.cap_block("claude", "system") == (None, "")
    M.set_cap("claude", "seven_day", 80)
    until, why = M.cap_block("claude", "system")
    assert until == FUTURE and "80% cap on the weekly limit" in why and "81% used" in why
    M.set_cap("claude", "seven_day", 90)
    assert M.cap_block("claude", "system")[0] is None, "raising the cap releases it at once"
    M.set_cap("claude", "seven_day", 80)
    limits.note_usage("claude", "system", "seven_day", 0.81, time.time() - 1)
    assert M.cap_block("claude", "system")[0] is None, "a reset window starts again at 0%"


def test_caps_are_per_agent_and_per_window(pro):
    M.set_cap("codex", "30d", 5)
    limits.note_usage("claude", "system", "five_hour", 0.5, FUTURE)
    assert M.cap_block("claude", "system")[0] is None
    limits.note_usage("codex", "c1", "30d", 0.07, FUTURE)
    assert M.cap_block("codex", "c1")[0] == FUTURE
    assert M.prefs()["caps"] == {"claude": {}, "codex": {"30d": 5}}
    M.set_cap("codex", "30d", None)
    assert M.cap_block("codex", "c1")[0] is None


@pytest.mark.parametrize("pct", [0, 101, -5, True, "80", 12.5e9])
def test_caps_are_validated(home, pct):
    with pytest.raises(ValueError):
        M.set_cap("claude", "five_hour", pct)


def test_the_chain_skips_a_capped_account_with_the_reason(pro, monkeypatch):
    monkeypatch.setattr(slots, "cli_path", lambda a: "claude")
    M.set_cap("claude", "five_hour", 50)
    limits.note_usage("claude", "system", "five_hour", 0.6, FUTURE)
    ok, why = asyncio.run(CC.ClaudeCLIAgent("system").available())
    assert not ok and "50% cap on the session (5h) limit" in why and "until" in why


def test_a_used_up_plan_with_credits_off_is_skipped_before_launching(pro, monkeypatch):
    monkeypatch.setattr(slots, "cli_path", lambda a: "claude")
    monkeypatch.setattr(slots, "status", lambda *a: pytest.fail("no CLI should start"))
    limits.note_usage("claude", "system", "five_hour", 1.0, FUTURE)
    ok, why = asyncio.run(CC.ClaudeCLIAgent("system").available())
    assert not ok and "usage credits are off" in why


# ── warnings ─────────────────────────────────────────────────────────────

def test_alerts_have_levels_and_are_keyed_per_reset(pro):
    limits.note_usage("claude", "system", "five_hour", 0.84, FUTURE)
    a = M.alerts()
    assert [x["level"] for x in a] == ["warn"] and a[0]["used"] == 84
    assert str(FUTURE) in a[0]["key"]
    M.set_cap("claude", "five_hour", 88)
    assert M.alerts()[0]["level"] == "near_cap"
    M.set_cap("claude", "five_hour", 80)
    assert M.alerts()[0]["level"] == "capped"
    M.set_cap("claude", "five_hour", None)
    M.set_warn(90)
    assert M.alerts() == []
    limits.note_usage("claude", "system", "five_hour", 1.0, FUTURE)
    assert M.alerts()[0]["level"] == "limit"


# ── the Claude run: credits refusal, mid-run caps ────────────────────────

class FakeStream:
    scripts: list[list[str]] = []
    argvs: list[list[str]] = []

    def __init__(self, argv, *, cwd, env, stdin_text=None):
        FakeStream.argvs.append(argv)
        self._lines = FakeStream.scripts.pop(0)
        self.killed = False
        self.stderr_tail: list[str] = []

    async def lines(self, cancel):
        for ln in self._lines:
            if self.killed:
                return
            yield ln
            await asyncio.sleep(0)

    def kill(self):
        self.killed = True

    async def wait(self):
        return 0


def J(**d):
    return json.dumps(d)


REFUSED = [J(type="system", subtype="init", model="claude-fable-5-1", session_id="s"),
           J(type="rate_limit_event", rate_limit_info={"status": "rejected", "resetsAt": FUTURE + 86400,
                                                       "errorCode": "credits_required"}),
           J(type="assistant", message={"content": [{"type": "text", "text":
             "Fable 5.1 requires usage credits. Switch to another model."}]}),
           J(type="result", is_error=True, subtype="success", api_error_status=429,
             result="Fable 5.1 requires usage credits. Switch to another model.")]
FINE = [J(type="system", subtype="init", model="claude-opus-5-5", session_id="s2"),
        J(type="assistant", message={"content": [{"type": "text", "text": "OK"}]}),
        J(type="result", is_error=False, result="OK", num_turns=1)]


@pytest.fixture
def fake_cli(home, monkeypatch):
    FakeStream.scripts, FakeStream.argvs = [], []
    monkeypatch.setattr(CC, "Stream", FakeStream)
    monkeypatch.setattr(CX, "Stream", FakeStream)
    monkeypatch.setattr(slots, "cli_path", lambda a: a)
    return FakeStream


def _go(agent, prompt="Think hard: design a sync protocol from scratch", mode=Mode.READ):
    events = []

    async def emit(ev):
        events.append(ev)
    res = asyncio.run(agent.run(Task("t", prompt, Path(".")), emit=emit, cancel=asyncio.Event()))
    return res, events


def test_a_credits_refusal_is_learned_and_retried_not_counted_as_a_limit(fake_cli):
    # A plan MAGI does not know to be credit-gated (max): Auto picks Fable,
    # the provider refuses it for credits, and the task goes again on Opus.
    seed("claude", "system", M.parse_claude_models(CLAUDE_MODELS), plan="max")
    credits("claude", "system", False)
    fake_cli.scripts = [list(REFUSED), list(FINE)]
    res, ev = _go(CC.ClaudeCLIAgent("system"))
    assert res.outcome == Outcome.OK and res.text == "OK"
    models_run = [a[a.index("--model") + 1] for a in fake_cli.argvs]
    assert models_run == ["claude-fable-5-1", "claude-opus-5-5"]
    assert {"claude-fable-5-1", "claude-fable-5"} <= M.gated("claude", "system"), "the family"
    assert "claude-opus-5-5" not in M.gated("claude", "system")
    assert limits.blocked_until("claude", "system") is None, "the ACCOUNT is not out of usage"
    assert [e["model"] for e in ev if e["k"] == "model"] == models_run
    assert any("usage credits" in e.get("text", "") for e in ev if e["k"] == "note")


@pytest.mark.parametrize("which", ["event", "text"])
def test_a_credits_refusal_is_recognised_by_either_signal(fake_cli, which):
    # The event's errorCode alone (a result worded differently), or the
    # words alone (an older CLI without errorCode): each is enough.
    seed("claude", "system", M.parse_claude_models(CLAUDE_MODELS), plan="max")
    credits("claude", "system", False)
    if which == "event":
        first = [REFUSED[0], REFUSED[1], J(type="result", is_error=True, api_error_status=429,
                                           result="API Error: 429")]
    else:
        first = [REFUSED[0], J(type="rate_limit_event", rate_limit_info={"status": "rejected",
                                                                         "resetsAt": FUTURE}),
                 REFUSED[3]]
    fake_cli.scripts = [first, list(FINE)]
    res, _ = _go(CC.ClaudeCLIAgent("system"))
    assert res.outcome == Outcome.OK
    assert limits.blocked_until("claude", "system") is None


def test_two_credit_refusals_hand_off_without_marking_a_limit(fake_cli):
    seed("claude", "system", M.parse_claude_models(CLAUDE_MODELS), plan="max")
    credits("claude", "system", False)
    fake_cli.scripts = [list(REFUSED), list(REFUSED)]
    res, _ = _go(CC.ClaudeCLIAgent("system"))
    assert res.outcome == Outcome.UNAVAILABLE and res.outcome.hands_off
    assert limits.blocked_until("claude", "system") is None


def test_the_model_and_effort_reach_the_cli(fake_cli, pro):
    fake_cli.scripts = [list(FINE)]
    _go(CC.ClaudeCLIAgent("system"), "Refactor the scheduler to fix the race condition")
    argv = fake_cli.argvs[0]
    assert argv[argv.index("--model") + 1] == "claude-opus-5-5"
    assert argv[argv.index("--effort") + 1] == "high"


def test_a_cap_reached_mid_run_stops_it_and_hands_on(fake_cli, pro):
    M.set_cap("claude", "five_hour", 50)
    fake_cli.scripts = [[
        J(type="system", subtype="init", model="claude-opus-5-5", session_id="s"),
        J(type="rate_limit_event", rate_limit_info={"status": "allowed", "unifiedWindows": {
            "five_hour": {"utilization": 0.51, "resetsAt": FUTURE}}}),
        J(type="assistant", message={"content": [{"type": "text", "text": "never read"}]}),
        J(type="result", is_error=False, result="never read")]]
    res, ev = _go(CC.ClaudeCLIAgent("system"))
    assert res.outcome == Outcome.LIMITED and res.outcome.hands_off
    assert "50% cap" in res.detail
    assert not any(e.get("text") == "never read" for e in ev), "stopped at the reading"
    assert limits.blocked_until("claude", "system") is None, "a cap is not a remembered limit"


def test_codex_gets_its_model_and_reasoning_effort(fake_cli, home):
    seed("codex", "c1", M.parse_codex_models(CODEX_MODELS))
    credits("codex", "c1", False)
    fake_cli.scripts = [[J(type="thread.started", thread_id="x"),
                         J(type="item.completed", item={"type": "agent_message", "text": "done"}),
                         J(type="turn.completed", usage={})]]
    res, ev = _go(CX.CodexCLIAgent("c1"), "Think hard: design a sync protocol from scratch")
    assert res.outcome == Outcome.OK
    argv = fake_cli.argvs[0]
    assert argv[argv.index("-m") + 1] == "gpt-6-luna"
    assert "model_reasoning_effort=xhigh" in argv
    assert argv[-1] == "-", "the prompt still arrives on stdin"


def test_codex_capped_is_skipped(fake_cli, home):
    M.set_cap("codex", "30d", 5)
    limits.note_usage("codex", "c1", "30d", 0.07, FUTURE)
    ok, why = asyncio.run(CX.CodexCLIAgent("c1").available())
    assert not ok and "5% cap on the 30-day limit" in why


def test_rate_limit_event_keeps_the_error_code():
    ev = CC.parse_line(REFUSED[1])
    assert ev["error_code"] == "credits_required" and ev["status"] == "rejected"


# ── per profile ──────────────────────────────────────────────────────────

def test_choices_and_caps_belong_to_the_profile(tmp_path, monkeypatch):
    import magi.settings as S
    monkeypatch.setattr(S, "ROOT", tmp_path)
    monkeypatch.setattr(M, "data_dir", S.data_dir)
    was = S.active_profile()
    try:
        S.set_active_profile("tony")
        M.set_cap("claude", "seven_day", 80)
        M.set_choice("claude", "claude-opus-5", "high")
        S.set_active_profile("veda")
        assert M.prefs() == M.default_prefs(), "Veda starts from her own defaults"
        M.set_cap("claude", "seven_day", 60)
        S.set_active_profile("tony")
        assert M.prefs()["caps"]["claude"] == {"seven_day": 80}
        assert (tmp_path / "data" / "veda" / "code_models.json").exists()
        assert (tmp_path / "data" / "tony" / "code_models.json").exists()
    finally:
        S.set_active_profile(was)


# ── a model the installed Claude Code is too old for ─────────────────────

TOO_OLD_TEXT = ("API Error: 400 Claude Code 2.1.278 does not support this model; version 2.1.280 "
                "or newer is required. Run 'claude update', or update the Claude desktop app, then "
                "try again.")
TOO_OLD = [J(type="system", subtype="init", model="claude-opus-5-5", session_id="s"),
           J(type="assistant", message={"content": [{"type": "text", "text": TOO_OLD_TEXT}]}),
           J(type="result", is_error=True, subtype="success", api_error_status=400, result=TOO_OLD_TEXT)]
FINE_OPUS5 = [J(type="system", subtype="init", model="claude-opus-5", session_id="s2"),
              J(type="result", is_error=False, result="found it", num_turns=1)]


def test_a_model_too_new_for_the_cli_is_learned_and_retried(fake_cli, pro, monkeypatch):
    # Found live: Auto chose Opus 5.5 (listed for the account), Claude Code
    # 2.1.278 refused it, and the chain STOPPED as if the task had failed.
    monkeypatch.setattr(M, "claude_cli_version", lambda: "2.1.278")
    fake_cli.scripts = [list(TOO_OLD), list(FINE_OPUS5)]
    res, ev = _go(CC.ClaudeCLIAgent("system"), "Refactor the scheduler to fix the race condition")
    assert res.outcome == Outcome.OK and res.text == "found it"
    ran = [a[a.index("--model") + 1] for a in fake_cli.argvs]
    assert ran == ["claude-opus-5-5", "claude-opus-5"], "the next-best Opus, same account"
    assert any("needs Claude Code 2.1.280 or newer" in e.get("text", "") and "claude update" in e["text"]
               for e in ev if e["k"] == "note")
    assert limits.blocked_until("claude", "system") is None
    op = _m("claude", "system", "claude-opus-5-5")
    assert not op["available"] and "2.1.280" in op["why"] and "2.1.278" in op["why"]


def test_updating_the_cli_makes_the_model_available_again(pro, monkeypatch):
    M.note_cli_min("claude-opus-5-5", "2.1.280")
    monkeypatch.setattr(M, "claude_cli_version", lambda: "2.1.278")
    assert not _m("claude", "system", "claude-opus-5-5")["available"]
    assert M.choose("claude", "system", "Refactor the scheduler")["model"] == "claude-opus-5"
    monkeypatch.setattr(M, "claude_cli_version", lambda: "2.1.281")
    assert _m("claude", "system", "claude-opus-5-5")["available"]
    assert M.choose("claude", "system", "Refactor the scheduler")["model"] == "claude-opus-5-5"


def test_the_version_compare_is_numeric():
    assert M._ver("2.1.280") > M._ver("2.1.278") and M._ver("2.10.0") > M._ver("2.9.9")


def test_two_too_old_refusals_hand_off_rather_than_stop_the_chain(fake_cli, pro, monkeypatch):
    monkeypatch.setattr(M, "claude_cli_version", lambda: "2.1.278")
    fake_cli.scripts = [list(TOO_OLD), list(TOO_OLD)]
    res, _ = _go(CC.ClaudeCLIAgent("system"), "Refactor the scheduler")
    assert res.outcome.hands_off, "the next agent gets it; the task did not fail on its merits"
    assert "claude update" in res.detail
