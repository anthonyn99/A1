"""Phase U3: each unit's limits and model, from what the engine already saw.

* `units.summarize` is the one verdict: limited (account at 100%, a notice at
  the last check, a limit a run hit) > near (a number past warn_at) > signed
  out > fell back > OK > not used yet. Only Claude (Pro) has numbers.
* `usage._snapshot_limit` no longer reads the user's own prompt, saved in the
  failure's page snapshot, as the site's limit notice (the "fix first").
* Brainstorm turns count: a member limited in a round is limited for runs.
* Tony's and Veda's state never meet: the DB, the checks file and Code
  Mode's usage numbers are all in the profile's own data folder.
* GET /api/units/usage and POST /api/units/{id}/check over the real app.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from magi.db import Database
from magi.engine import units, usage
from magi.providers.base import Answer, HealthReport, ProviderState

NOW = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _sum(recent=None, facts=None, check=None, account=None, pid="grok"):
    return units.summarize(
        provider_id=pid, display_name=pid.title(),
        recent=recent or {"issues": [], "last_ok_at": None},
        facts=facts or {}, check=check, account=account, now=NOW)


def _limit_issue(at: datetime, resets: datetime | None, cleared=False, passed=False):
    return {"kind": "rate_limited", "limit": True, "detail": "The site said: 3 hours before limit is gone",
            "at": _iso(at), "resets_at": _iso(resets) if resets else None,
            "cleared": cleared, "reset_passed": passed}


# ── the verdict ──────────────────────────────────────────────────────────

def test_never_used_is_not_ok():
    s = _sum()
    assert s["state"] == "unknown" and s["headline"] == "Not used yet"


def test_a_good_answer_is_ok():
    s = _sum(recent={"issues": [], "last_ok_at": _iso(NOW)})
    assert s["state"] == "ok" and s["limit"] is None


def test_a_run_limit_shows_until_its_reset():
    at = NOW - timedelta(hours=1)
    s = _sum(recent={"issues": [_limit_issue(at, NOW + timedelta(hours=2))],
                     "last_ok_at": _iso(at - timedelta(hours=1))})
    assert s["state"] == "limited"
    assert s["limit"]["source"] == "run"
    assert s["limit"]["resets_at"] == _iso(NOW + timedelta(hours=2))


@pytest.mark.parametrize("cleared,passed", [(True, False), (False, True)])
def test_a_limit_answered_past_or_past_its_reset_is_over(cleared, passed):
    at = NOW - timedelta(hours=4)
    s = _sum(recent={"issues": [_limit_issue(at, at + timedelta(hours=3), cleared, passed)],
                     "last_ok_at": _iso(NOW) if cleared else None})
    assert s["state"] != "limited" and s["limit"] is None


def test_a_notice_at_the_last_check_is_a_limit_with_its_countdown():
    at = NOW - timedelta(minutes=10)
    s = _sum(check={"at": _iso(at), "reachable": True, "logged_in": True, "usable": True,
                    "limit": "6 hours 50 minutes before limit is gone"})
    assert s["state"] == "limited" and s["limit"]["source"] == "check"
    assert s["limit"]["resets_at"] == _iso(at + timedelta(hours=6, minutes=50))


def test_a_check_notice_answered_past_since_is_over():
    at = NOW - timedelta(hours=1)
    s = _sum(recent={"issues": [], "last_ok_at": _iso(NOW - timedelta(minutes=5))},
             check={"at": _iso(at), "reachable": True, "logged_in": True, "limit": "limit reached"})
    assert s["state"] == "ok"


def test_signed_out_at_the_last_check():
    s = _sum(check={"at": _iso(NOW), "reachable": True, "logged_in": False, "usable": False})
    assert s["state"] == "signed_out"


def test_an_unreachable_check_does_not_say_signed_out():
    s = _sum(check={"at": _iso(NOW), "reachable": False, "logged_in": False})
    assert s["state"] == "unknown"


def test_the_last_answer_on_a_fallback_model():
    s = _sum(recent={"issues": [], "last_ok_at": _iso(NOW)},
             facts={"model": "gpt-5-6-mini", "model_fallback": "the site switched model",
                    "model_at": _iso(NOW)})
    assert s["state"] == "fallback" and s["model"] == "gpt-5-6-mini"


def test_a_newer_check_label_wins_over_an_older_run_label():
    s = _sum(facts={"model": "Fast", "model_at": _iso(NOW - timedelta(days=1))},
             check={"at": _iso(NOW), "reachable": True, "logged_in": True, "model": "Expert"})
    assert s["model"] == "Expert" and s["model_fallback"] == ""
    s = _sum(facts={"model": "Fast", "model_at": _iso(NOW)},
             check={"at": _iso(NOW - timedelta(days=1)), "reachable": True, "logged_in": True,
                    "model": "Expert"})
    assert s["model"] == "Fast"


def test_a_check_is_not_a_run():
    """The sheet says "last in a run X · checked Y": a check must not move X."""
    ran = NOW - timedelta(days=2)
    s = _sum(facts={"last_seen_at": _iso(ran)},
             check={"at": _iso(NOW), "reachable": True, "logged_in": True})
    assert s["last_seen_at"] == _iso(ran) and s["checked_at"] == _iso(NOW)


def test_prompt_too_long_is_a_note_not_a_limit():
    s = _sum(recent={"issues": [{"kind": "prompt_too_long", "limit": False, "cleared": False,
                                 "detail": "Your query is 12 characters over the limit",
                                 "at": _iso(NOW)}], "last_ok_at": None})
    assert s["state"] != "limited" and s["too_long"]["detail"].startswith("Your query")


def _acct(five: float, week: float, warn=80):
    r = NOW + timedelta(hours=2)
    return {"slot": "system", "label": "system", "warn_at": warn, "credits": None,
            "windows": {"five_hour": {"utilization": five, "resets_at": _iso(r), "read_at": _iso(NOW)},
                        "seven_day": {"utilization": week, "resets_at": _iso(r + timedelta(days=3)),
                                      "read_at": _iso(NOW)}}}


def test_claude_pro_numbers_near_and_at_the_limit():
    ok = _sum(pid="claude-pro", account=_acct(0.30, 0.52),
              recent={"issues": [], "last_ok_at": _iso(NOW)})
    assert ok["state"] == "ok" and ok["account"]["windows"]["five_hour"]["utilization"] == 0.30
    near = _sum(pid="claude-pro", account=_acct(0.85, 0.52))
    assert near["state"] == "near" and near["near"]["window"] == "five_hour"
    full = _sum(pid="claude-pro", account=_acct(1.0, 0.52))
    assert full["state"] == "limited" and full["limit"]["source"] == "account"
    assert full["limit"]["resets_at"] == _iso(NOW + timedelta(hours=2))


def test_warn_at_is_the_code_mode_setting():
    assert _sum(pid="claude-pro", account=_acct(0.85, 0.1, warn=90))["state"] != "near"


# ── the snapshot fix ─────────────────────────────────────────────────────

async def _db(tmp_path, name="magi.db") -> Database:
    d = Database(tmp_path / name)
    await d.init()
    return d


def _failed(pid: str, at: datetime, kind="timeout", artifacts=(), text="") -> Answer:
    return Answer(provider_id=pid, display_name=pid, text=text, ok=False,
                  state=ProviderState.FAILED, failure=kind, error_detail="No new answer",
                  started_at=at, ended_at=at, artifacts=list(artifacts))


def test_a_prompt_quoting_limit_words_in_a_snapshot_is_not_a_limit(tmp_path):
    """The bug: an old timeout's snapshot showed the prompt, the prompt said
    "rate limit", and the doctor reported a usage limit."""
    q = "Why do APIs have a rate limit reached error?"
    snap = tmp_path / "p.html"
    snap.write_text(f"<div class='user'><p>{q}</p></div><div>thinking</div>", encoding="utf-8")

    async def go():
        d = await _db(tmp_path)
        await d.create_run("r1", q, None)
        # The real clock, not NOW: _recent_sync looks back WINDOW_HOURS from
        # the actual time, so a fixed date aged out of the window (2026-09-30).
        at = datetime.now(timezone.utc) - timedelta(minutes=5)
        await d.save_answer("r1", _failed("perplexity", at, artifacts=[str(snap)]))
    asyncio.run(go())
    r = usage._recent_sync(str(tmp_path / "magi.db"), "perplexity", ["text=/rate limit reached/i"])
    assert [i["kind"] for i in r["issues"]] == ["timeout"]


def test_the_sites_own_notice_beside_the_prompt_still_counts(tmp_path):
    q = "Describe this environment"
    snap = tmp_path / "g.html"
    snap.write_text(f"<div><p>{q}</p></div><div role='alert'>3 hours before limit is gone</div>",
                    encoding="utf-8")

    async def go():
        d = await _db(tmp_path)
        await d.create_run("r1", q, None)
        await d.save_answer("r1", _failed("grok", datetime.now(timezone.utc), artifacts=[str(snap)]))
    asyncio.run(go())
    r = usage._recent_sync(str(tmp_path / "magi.db"), "grok", ["text=/before limit is gone/i"])
    (i,) = r["issues"]
    assert i["limit"] and i["detail"] == "The site said: 3 hours before limit is gone"


def test_a_saved_answer_quoting_limit_words_is_not_a_limit(tmp_path):
    snap = tmp_path / "a.html"
    snap.write_text("<div><p>Hi</p></div><div><p>You have reached your daily limit of fun.</p></div>",
                    encoding="utf-8")

    async def go():
        d = await _db(tmp_path)
        await d.create_run("r1", "Hi", None)
        await d.save_answer("r1", _failed("grok", datetime.now(timezone.utc), artifacts=[str(snap)],
                                          text="You have reached your daily limit of fun."))
    asyncio.run(go())
    r = usage._recent_sync(str(tmp_path / "magi.db"), "grok",
                           ["text=/You(?:'ve| have) reached your .{0,40}limit/i"])
    assert [i["kind"] for i in r["issues"]] == ["timeout"]


# ── brainstorm turns and the DB facts ────────────────────────────────────

def test_a_brainstorm_limit_and_model_reach_the_panel(tmp_path):
    async def go():
        d = await _db(tmp_path)
        await d.create_session("s1", "topic", ["grok", "claude"])
        await d.add_turn("s1", 1, "council", provider_id="grok", ok=False,
                         failure_kind="rate_limited", error_detail="3 hours before limit is gone")
        await d.add_turn("s1", 1, "council", provider_id="claude", ok=True, content="x",
                         model="Sonnet 5.5 Medium")
    asyncio.run(go())
    db = str(tmp_path / "magi.db")
    r = usage._recent_sync(db, "grok", [])
    (i,) = r["issues"]
    assert i["limit"] and i["resets_at"] and not i["cleared"]
    f = units._facts_sync(db, "claude")
    assert f["model"] == "Sonnet 5.5 Medium" and f["last_seen_at"]
    assert usage._recent_sync(db, "claude", [])["last_ok_at"]


def test_the_newest_model_wins_across_runs_and_brainstorm(tmp_path):
    old, new = NOW - timedelta(days=1), datetime.now(timezone.utc)

    async def go():
        d = await _db(tmp_path)
        await d.create_run("r1", "q", None)
        a = Answer(provider_id="chatgpt", display_name="ChatGPT", text="x", ok=True,
                   state=ProviderState.DONE, started_at=old, ended_at=old, model="gpt-5-6")
        await d.save_answer("r1", a)
        await d.create_session("s1", "t", ["chatgpt"])
        await d.add_turn("s1", 1, "council", provider_id="chatgpt", ok=True, content="y",
                         model="gpt-5-6-mini", model_fallback="the site switched model")
    asyncio.run(go())
    f = units._facts_sync(str(tmp_path / "magi.db"), "chatgpt")
    assert f["model"] == "gpt-5-6-mini" and f["model_fallback"]


# ── checks, and Tony/Veda separation ─────────────────────────────────────

def test_only_a_check_that_reached_the_site_is_kept(tmp_path):
    db = tmp_path / "magi.db"
    ok = HealthReport(provider_id="grok", display_name="Grok", reachable=True, logged_in=True,
                      limit="3 hours before limit is gone", model="Fast")
    units.save_check(db, "grok", ok)
    units.save_check(db, "grok", HealthReport(provider_id="grok", display_name="Grok",
                                              reachable=False, logged_in=False, error="in use"))
    rec = units.load_checks(db)["grok"]
    assert rec["model"] == "Fast" and rec["limit"].startswith("3 hours")


def test_tony_and_veda_never_share_state(tmp_path, monkeypatch):
    from magi import settings as S
    from magi.code.agents import limits, models

    monkeypatch.setattr(S, "ROOT", tmp_path)
    was = S.active_profile()
    try:
        paths = {}
        for who in ("tony", "veda"):
            S.set_active_profile(who)
            paths[who] = S.load_settings().db_path
        assert paths["tony"].parent != paths["veda"].parent
        assert paths["tony"].parent.name == "tony" and paths["veda"].parent.name == "veda"

        # A check on Tony's engine is not on Veda's.
        rep = HealthReport(provider_id="grok", display_name="Grok", reachable=True,
                           logged_in=False)
        paths["tony"].parent.mkdir(parents=True, exist_ok=True)
        units.save_check(paths["tony"], "grok", rep)
        assert "grok" in units.load_checks(paths["tony"])
        assert units.load_checks(paths["veda"]) == {}

        # Tony's Pro account numbers are not Veda's claude-pro.
        S.set_active_profile("tony")
        (S.data_dir() / "agent_models.json").write_text(json.dumps(
            {"slots": {"claude:system": {"models": [], "plan": "pro"}}}), encoding="utf-8")
        limits.note_usage("claude", "system", "five_hour", 0.4, time.time() + 3600)
        t = units.pro_account()
        assert t and t["windows"]["five_hour"]["utilization"] == 0.4
        S.set_active_profile("veda")
        assert units.pro_account() is None
    finally:
        S.set_active_profile(was)


def test_a_free_claude_slot_is_never_shown_as_pro(tmp_path, monkeypatch):
    from magi import settings as S
    from magi.code.agents import limits

    monkeypatch.setattr(S, "ROOT", tmp_path)
    (S.data_dir() / "agent_models.json").write_text(json.dumps(
        {"slots": {"claude:system": {"models": [], "plan": "free"}}}), encoding="utf-8")
    limits.note_usage("claude", "system", "five_hour", 0.9, None)
    assert units.pro_account() is None


# ── the routes ───────────────────────────────────────────────────────────

@pytest.fixture
def api(tmp_path, monkeypatch):
    from starlette.testclient import TestClient
    from magi import app as app_mod
    from magi import settings as S

    monkeypatch.delenv(S.api_token_env(), raising=False)
    monkeypatch.setattr(app_mod.settings, "db_path", tmp_path / "magi.db")
    asyncio.run(Database(tmp_path / "magi.db").init())
    monkeypatch.setattr(units, "pro_account", lambda refresh=False: None)
    return TestClient(app_mod.app, raise_server_exceptions=False), app_mod, tmp_path


def test_the_usage_route_lists_every_enabled_unit(api):
    client, app_mod, _ = api
    r = client.get("/api/units/usage")
    assert r.status_code == 200, r.text
    ids = [u["id"] for u in r.json()["units"]]
    assert ids == app_mod.settings.enabled_site_ids()
    assert all(u["state"] in units.HEADLINE for u in r.json()["units"])


def test_check_now_keeps_what_it_saw(api, monkeypatch):
    client, app_mod, tmp = api
    from magi.providers.browser_base import BrowserProvider

    async def fake_check(self, *, deep=False):
        return HealthReport(provider_id=self.id, display_name=self.display_name,
                            reachable=True, logged_in=True,
                            limit="2 hours before limit is gone", model="Fast")
    monkeypatch.setattr(BrowserProvider, "health_check", fake_check)
    r = client.post("/api/units/grok/check").json()
    assert r["ok"] and r["unit"]["state"] == "limited" and r["unit"]["model"] == "Fast"
    assert r["unit"]["limit"]["resets_at"]
    assert units.load_checks(tmp / "magi.db")["grok"]["model"] == "Fast"
    # And the panel reads the same thing back.
    g = next(u for u in client.get("/api/units/usage").json()["units"] if u["id"] == "grok")
    assert g["state"] == "limited"


def test_check_now_waits_for_no_run(api, monkeypatch):
    client, _, _ = api
    from magi.browser import launcher
    monkeypatch.setattr(launcher, "in_use", lambda sid: sid == "grok")
    r = client.post("/api/units/grok/check").json()
    assert not r["ok"] and r["error"] == "busy"


def test_check_now_refuses_an_unknown_unit(api):
    client, _, _ = api
    assert client.post("/api/units/nope/check").status_code == 404
