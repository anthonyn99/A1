"""TradeHub's two standing prompts, run by the engine (engine/autoprompts.py).

Pins: the NYSE calendar (holidays, 1 PM closes), exactly when each job is due
(and its catch-up window), which prompt and units are used, and the run →
push → record path with every failure: no unit answered, a push that fails
(re-sent without asking the council again), retries spaced out and capped,
Veda's engine never running them. The engine's own functions are faked: no
council runs, nothing reaches a worker.
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime

import pytest

from magi.engine import autoprompts as ap

ET = ap.ET


def at(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=ET)


# ── the calendar ──────────────────────────────────────────────────────────

def test_nyse_2026_holidays_and_half_days():
    hol, half = ap.nyse_year(2026)
    assert hol == {date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16), date(2026, 4, 3), date(2026, 5, 25),
                   date(2026, 6, 19), date(2026, 7, 3), date(2026, 9, 7), date(2026, 11, 26), date(2026, 12, 25)}
    assert half == {date(2026, 11, 27), date(2026, 12, 24)}


def test_new_year_on_a_saturday_is_not_observed_and_july_3_closes_early():
    hol, half = ap.nyse_year(2022)          # Jan 1 2022 was a Saturday
    assert date(2021, 12, 31) not in hol and date(2022, 1, 1) not in hol
    hol, half = ap.nyse_year(2025)          # July 4 2025 was a Friday
    assert date(2025, 7, 3) in half


def test_close_time():
    assert ap.close_et(date(2026, 11, 9)).hour == 16
    assert ap.close_et(date(2026, 11, 27)).hour == 13


# ── when each job is due ──────────────────────────────────────────────────

def test_movers_due_an_hour_after_the_close_until_4am():
    assert ap.due(at(2026, 11, 9, 16, 59), {}) == []
    assert ap.due(at(2026, 11, 9, 17, 0), {}) == [("movers", "2026-11-09")]
    assert ap.due(at(2026, 11, 10, 3, 59), {}) == [("movers", "2026-11-09")]
    assert ap.due(at(2026, 11, 10, 4, 0), {}) == []


def test_movers_once_per_trading_day():
    assert ap.due(at(2026, 11, 9, 18, 0), {"done": {"movers": "2026-11-09"}}) == []


def test_movers_on_a_half_day_and_never_on_a_holiday_or_weekend():
    assert ap.due(at(2026, 11, 27, 14, 0), {}) == [("movers", "2026-11-27")]
    assert ap.due(at(2026, 11, 27, 13, 59), {}) == []
    assert ap.due(at(2026, 11, 26, 18, 0), {}) == []          # Thanksgiving
    assert [j for j in ap.due(at(2026, 11, 15, 18, 0), {}) if j[0] == "movers"] == []   # Sunday (weekly is due then)


def test_weekly_saturday_10am_until_monday_4am():
    assert ap.due(at(2026, 11, 14, 9, 59), {}) == []
    assert ap.due(at(2026, 11, 14, 10, 0), {}) == [("weekly", "2026-11-14")]
    assert ap.due(at(2026, 11, 15, 20, 0), {}) == [("weekly", "2026-11-14")]
    assert ap.due(at(2026, 11, 16, 3, 0), {}) == [("weekly", "2026-11-14")]
    assert ap.due(at(2026, 11, 16, 4, 0), {}) == []
    assert ap.due(at(2026, 11, 14, 12, 0), {"done": {"weekly": "2026-11-14"}}) == []


def test_friday_movers_still_due_early_saturday_beside_nothing_else():
    assert ap.due(at(2026, 11, 14, 1, 0), {}) == [("movers", "2026-11-13")]


def test_next_run():
    assert ap.next_run(at(2026, 11, 9, 12, 0), "movers") == at(2026, 11, 9, 17, 0)
    assert ap.next_run(at(2026, 11, 25, 18, 0), "movers") == at(2026, 11, 27, 14, 0)   # skips Thanksgiving
    assert ap.next_run(at(2026, 11, 9, 12, 0), "weekly") == at(2026, 11, 14, 10, 0)


# ── which prompt, which units ─────────────────────────────────────────────

AVAIL = ["chatgpt", "claude", "gemini", "perplexity", "deepseek"]


def test_units_magi_ticked_then_single_site_then_all():
    assert ap.pick_units({"magiUnits": ["gemini", "grok", "chatgpt"]}, AVAIL) == ["gemini", "chatgpt"]
    assert ap.pick_units({"magiUnits": [], "aiUrl": "https://chatgpt.com/"}, AVAIL) == ["chatgpt"]
    assert ap.pick_units({"magiUnits": [], "aiUrl": "https://www.perplexity.ai/"}, AVAIL) == ["perplexity"]
    assert ap.pick_units({"aiUrl": "https://example.com/my-bot"}, AVAIL) == AVAIL
    assert ap.pick_units(None, AVAIL) == AVAIL


def test_prompt_from_tradehub_else_the_default():
    cfg = {"auto": {"movers": {"name": "Movers", "text": "What moved it?"}}}
    assert ap.pick_prompt(cfg, "movers") == {"name": "Movers", "text": "What moved it?", "src": "tradehub"}
    p = ap.pick_prompt(cfg, "weekly")
    assert p["src"] == "default" and "Weekly Trading Catalyst Tier List" in p["text"]


def test_result_body_is_magis_run_shape_trimmed():
    run = {"run": {"question": "q"}, "answers": [{"provider_id": "chatgpt", "ok": True, "answer_text": "x" * 70000}],
           "synthesis": {"verdict_text": "v"}}
    b = ap.result_body("movers", "2026-11-09", {"name": "n", "text": "q", "src": "tradehub"}, run)
    assert b["job"] == "movers" and b["for"] == "2026-11-09" and b["run"] == {"question": "q"}
    assert len(b["answers"][0]["answer_text"]) == 60000 and b["synthesis"]["verdict_text"] == "v"


# ── running: the engine faked ─────────────────────────────────────────────

class Engine:
    def __init__(self, answers_ok=True):
        self.started = []
        self.answers_ok = answers_ok

    async def start_run(self, q, units):
        self.started.append((q, units))
        return f"r{len(self.started)}"

    async def get_run(self, rid):
        return {"run": {"question": self.started[-1][0], "created_at": "2026-11-09T22:00:00Z"},
                "answers": [{"provider_id": u, "display_name": u, "ok": self.answers_ok, "answer_text": "ans"} for u in self.started[-1][1]],
                "synthesis": {"verdict_text": "verdict"}}

    def kw(self):
        return dict(start_run=self.start_run, get_run=self.get_run, is_done=lambda rid: True,
                    available=lambda: AVAIL, busy=lambda: False)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(ap, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(ap, "active_profile", lambda: "tony")
    monkeypatch.setattr(ap, "fetch_config", lambda: {"ok": True, "magiUnits": ["chatgpt", "gemini"],
                                                      "auto": {"movers": {"name": "Movers", "text": "What moved it?"}}})
    pushes = []
    state = {"push_ok": True}

    def fake_push(body):
        pushes.append(body)
        return (state["push_ok"], "" if state["push_ok"] else "HTTP 500")
    monkeypatch.setattr(ap, "push", fake_push)
    return pushes, state


def run(coro):
    return asyncio.run(coro)


def test_a_due_job_runs_the_council_and_pushes_once(env):
    pushes, _ = env
    e = Engine()
    out = run(ap.tick(now=at(2026, 11, 9, 17, 5), **e.kw()))
    assert e.started == [("What moved it?", ["chatgpt", "gemini"])]
    assert len(pushes) == 1 and pushes[0]["job"] == "movers" and pushes[0]["for"] == "2026-11-09"
    assert out[0]["ok"] and ap.load_state()["done"]["movers"] == "2026-11-09"
    # The next tick that evening does nothing.
    run(ap.tick(now=at(2026, 11, 9, 17, 6), **e.kw()))
    assert len(e.started) == 1 and len(pushes) == 1


def test_a_failed_push_is_resent_without_asking_the_council_again(env):
    pushes, st = env
    e = Engine()
    st["push_ok"] = False
    run(ap.tick(now=at(2026, 11, 9, 17, 5), **e.kw()))
    assert len(e.started) == 1 and "done" not in ap.load_state()
    st["push_ok"] = True
    run(ap.tick(now=at(2026, 11, 9, 17, 6), **e.kw()))
    assert len(e.started) == 1, "no second council"
    assert len(pushes) == 2 and pushes[1] == pushes[0]
    assert ap.load_state()["done"]["movers"] == "2026-11-09"
    assert "pending" not in ap.status(at(2026, 11, 9, 17, 7))["jobs"]["movers"]["last"]


def test_no_answer_retries_20_minutes_later_at_most_3_councils(env):
    pushes, _ = env
    e = Engine(answers_ok=False)
    run(ap.tick(now=at(2026, 11, 9, 17, 5), **e.kw()))
    run(ap.tick(now=at(2026, 11, 9, 17, 10), **e.kw()))           # too soon
    assert len(e.started) == 1 and not pushes
    run(ap.tick(now=at(2026, 11, 9, 17, 26), **e.kw()))
    run(ap.tick(now=at(2026, 11, 9, 17, 47), **e.kw()))
    assert len(e.started) == 3
    assert ap.load_state()["done"]["movers"] == "2026-11-09", "given up for the day after 3"
    run(ap.tick(now=at(2026, 11, 9, 18, 30), **e.kw()))
    assert len(e.started) == 3


def test_a_live_council_goes_first(env, monkeypatch):
    e = Engine()
    calls = {"n": 0}

    def busy():
        calls["n"] += 1
        return calls["n"] < 3
    monkeypatch.setattr(ap.asyncio, "sleep", _nosleep)
    kw = {**e.kw(), "busy": busy}
    run(ap.tick(now=at(2026, 11, 9, 17, 5), **kw))
    assert calls["n"] >= 3 and len(e.started) == 1


async def _nosleep(_s):
    return None


def test_weekly_and_force(env):
    e = Engine()
    run(ap.tick(now=at(2026, 11, 14, 10, 1), **e.kw()))
    assert e.started[0][0].startswith("# Weekly Trading Catalyst Tier List")    # the default (TradeHub sent none)
    run(ap.tick(now=at(2026, 11, 10, 12, 0), force="movers", **e.kw()))
    assert len(e.started) == 2 and e.started[1][0] == "What moved it?"


def test_veda_engine_never_runs_them(env, monkeypatch):
    monkeypatch.setattr(ap, "active_profile", lambda: "veda")
    e = Engine()
    assert run(ap.tick(now=at(2026, 11, 9, 17, 5), **e.kw())) == []
    assert e.started == []
