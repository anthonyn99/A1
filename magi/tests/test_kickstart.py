"""The daily Claude (Pro) kickstart (engine/kickstart.py).

`decide()` is the whole policy, so every branch is pinned here: it must never
send past the weekly cap, never send into a window that is already open, and
send at most once a day. The argv is pinned too -- each flag is what keeps
the message at a few hundred tokens instead of fifteen thousand.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from magi import settings
from magi.engine import kickstart as ks

TZ = timezone(timedelta(hours=-7))
NOW = datetime(2026, 9, 29, 8, 0, tzinfo=TZ)
TODAY = NOW.date().isoformat()
CFG = {**ks.DEFAULTS}


def _wins(week=0.3, five_resets: datetime | None = None, five=0.1):
    w = {"seven_day": {"utilization": week, "resets_at": (NOW + timedelta(days=3)).timestamp()}}
    if five_resets:
        w["five_hour"] = {"utilization": five, "resets_at": five_resets.timestamp()}
    return w


def _act(**kw):
    args = {"now": NOW, "cfg": CFG, "st": {}, "wins": _wins()}
    args.update(kw)
    return ks.decide(**args)


def test_sends_on_a_fresh_day():
    assert _act()["act"] == "send"


def test_off_sends_nothing():
    assert _act(cfg={**CFG, "enabled": False})["act"] == "off"


def test_before_not_before_waits_until_then():
    d = _act(cfg={**CFG, "not_before": "09:30"})
    assert d["act"] == "wait" and d["status"] == "early"
    assert d["until"] == NOW.replace(hour=9, minute=30).timestamp()


def test_once_a_day():
    assert _act(st={"day": TODAY, "status": "sent"})["act"] == "done"
    # Yesterday's send does not count for today.
    y = (NOW - timedelta(days=1)).date().isoformat()
    assert _act(st={"day": y, "status": "sent"})["act"] == "send"


@pytest.mark.parametrize("week,cap,act", [(0.79, 80, "send"), (0.80, 80, "skip"),
                                          (0.95, 80, "skip"), (0.95, 100, "send")])
def test_weekly_cap(week, cap, act):
    d = _act(cfg={**CFG, "week_cap": cap}, wins=_wins(week=week))
    assert d["act"] == act
    if act == "skip":
        assert d["status"] == "capped"


def test_the_opus_or_sonnet_week_counts_too():
    w = _wins(week=0.2)
    w["seven_day_sonnet"] = {"utilization": 0.9, "resets_at": None}
    assert _act(wins=w)["status"] == "capped"


def test_cap_holds_even_for_send_now():
    assert _act(wins=_wins(week=0.9), force=True)["act"] == "skip"


def test_no_reading_does_not_send():
    assert _act(wins=None)["status"] == "no_reading"


def test_a_window_carried_over_from_the_night_is_waited_out():
    r = NOW + timedelta(hours=1)          # opened 04:00, before Not before
    d = _act(wins=_wins(five_resets=r))
    assert d["act"] == "wait" and d["status"] == "open" and d["until"] == r.timestamp()


def test_a_window_you_opened_today_counts_as_done():
    r = NOW + timedelta(hours=4, minutes=30)   # opened 07:30, after 06:00
    d = _act(wins=_wins(five_resets=r))
    assert d["act"] == "done" and d["status"] == "already"


def test_a_passed_window_does_not_block():
    assert _act(wins=_wins(five_resets=NOW - timedelta(minutes=1)))["act"] == "send"


def test_limited_skips_even_forced():
    until = (NOW + timedelta(hours=2)).timestamp()
    assert _act(blocked_until=until)["status"] == "limited"
    assert _act(blocked_until=until, force=True)["status"] == "limited"


def test_gives_up_after_three_failures():
    st = {"day": TODAY, "status": "failed", "tries": ks.MAX_TRIES, "detail": "boom"}
    assert _act(st=st)["status"] == "gave_up"
    assert _act(st={**st, "tries": 1})["act"] == "send"


def test_send_now_goes_past_done_early_and_open():
    st = {"day": TODAY, "status": "sent"}
    d = _act(st=st, cfg={**CFG, "not_before": "23:00"},
             wins=_wins(five_resets=NOW + timedelta(hours=1)), force=True)
    assert d["act"] == "send"


def test_argv_is_the_cheap_one():
    a = ks.build_argv("claude")
    assert a[a.index("--tools") + 1] == ""
    assert a[a.index("--model") + 1] == "haiku"
    for flag in ("--system-prompt", "--no-session-persistence", "--restricted",
                 "--strict-mcp-config", "--disable-slash-commands", "-p"):
        assert flag in a
    assert a[a.index("--max-turns") + 1] == "1"


@pytest.mark.parametrize("bad", [{"message": ""}, {"message": "x" * 201},
                                 {"not_before": "6am"}, {"not_before": "24:00"},
                                 {"week_cap": 5}, {"week_cap": 101}, {"week_cap": "x"}])
def test_bad_config_is_refused(bad):
    with pytest.raises(ValueError):
        ks.clean(bad)


def test_config_round_trips(tmp_path, monkeypatch):
    monkeypatch.setattr(ks, "data_dir", lambda: tmp_path)
    assert ks.config() == ks.DEFAULTS
    ks.save_config({"week_cap": 70, "not_before": "07:15"})
    assert ks.config()["week_cap"] == 70 and ks.config()["not_before"] == "07:15"
    assert ks.config()["message"] == ks.DEFAULTS["message"]


def test_tonys_and_vedas_engines(monkeypatch):
    monkeypatch.setattr(ks, "pro_slot", lambda: "system")
    for who in ("tony", "veda"):
        monkeypatch.setattr(ks, "active_profile", lambda who=who: who)
        assert ks.available() is True
    monkeypatch.setattr(ks, "active_profile", lambda: "guest")
    assert ks.available() is False and ks.panel() is None
    # No Pro account in this profile's Code Mode: no section, no sends.
    monkeypatch.setattr(ks, "active_profile", lambda: "veda")
    monkeypatch.setattr(ks, "pro_slot", lambda: None)
    assert ks.available() is False and ks.panel() is None


@pytest.fixture
def claims(tmp_path, monkeypatch):
    """Both profiles' engines on one PC, sharing one claims folder."""
    monkeypatch.setattr(ks, "_claims_dir", lambda: tmp_path)
    who = {"p": "tony"}
    monkeypatch.setattr(ks, "active_profile", lambda: who["p"])
    return who, tmp_path


def test_one_send_per_shared_account_per_day(claims, monkeypatch):
    who, d = claims
    monkeypatch.setattr(ks, "_account_key", lambda slot: "shared")
    assert ks._claim("system", TODAY) is None          # Tony's engine wins
    assert ks._claim("system", TODAY) is None          # ...and keeps it
    who["p"] = "veda"
    assert ks._claim("system", TODAY) == "tony"        # Veda's engine stands down
    ks._release("system", TODAY)                       # not hers to release
    assert ks._claim("system", TODAY) == "tony"
    who["p"] = "tony"
    ks._release("system", TODAY)                       # Tony's send failed
    who["p"] = "veda"
    assert ks._claim("system", TODAY) is None          # so Veda's may try


def test_separate_accounts_never_block_each_other(claims, monkeypatch):
    who, _ = claims
    monkeypatch.setattr(ks, "_account_key", lambda slot: f"acct-{who['p']}")
    assert ks._claim("system", TODAY) is None
    who["p"] = "veda"
    assert ks._claim("system", TODAY) is None


def test_old_claims_are_swept(claims, monkeypatch):
    _, d = claims
    monkeypatch.setattr(ks, "_account_key", lambda slot: "k")
    (d / "k-2026-09-28.json").write_text('{"profile": "veda"}', encoding="utf-8")
    assert ks._claim("system", TODAY) is None
    assert sorted(f.name for f in d.iterdir()) == [f"k-{TODAY}.json"]


def test_account_key_is_the_credentials_file(monkeypatch, tmp_path):
    from magi.code.agents import usage_fetch
    monkeypatch.setattr(usage_fetch, "_claude_creds", lambda slot: tmp_path / slot / ".credentials.json")
    assert ks._account_key("a") == ks._account_key("a")
    assert ks._account_key("a") != ks._account_key("b")


def _tick_env(monkeypatch, tmp_path, claim_by):
    """_tick with everything external stubbed; returns the sends made."""
    from magi.code.agents import limits, updates
    monkeypatch.setattr(ks, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(ks, "pro_slot", lambda: "system")
    monkeypatch.setattr(ks, "_local_now", lambda: NOW)
    monkeypatch.setattr(ks, "windows", lambda slot, fresh=True: _wins())
    monkeypatch.setattr(limits, "blocked_until", lambda a, s: None)
    monkeypatch.setattr(updates, "updating", lambda a: False)
    monkeypatch.setattr(ks, "_claim", lambda slot, day: claim_by)
    monkeypatch.setattr(ks, "_release", lambda slot, day: None)
    sent = []

    async def fake_send(slot, message):
        sent.append(message)
        return {"ok": True, "window_resets_at": None}
    monkeypatch.setattr(ks, "send", fake_send)
    return sent


def test_tick_stands_down_when_the_other_engine_sent(monkeypatch, tmp_path):
    import asyncio
    sent = _tick_env(monkeypatch, tmp_path, claim_by="tony")
    asyncio.run(ks._tick(False))
    assert sent == [] and ks.state()["status"] == "already"
    assert "Tony" in ks.state()["detail"]
    # ...and stays done for the day.
    assert ks.decide(NOW, ks.config(), ks.state(), _wins())["act"] == "done"


def test_tick_sends_when_the_claim_is_ours(monkeypatch, tmp_path):
    import asyncio
    sent = _tick_env(monkeypatch, tmp_path, claim_by=None)
    asyncio.run(ks._tick(False))
    assert sent == ["k"] and ks.state()["status"] == "sent"


def test_a_day_already_done_still_holds_the_claim(monkeypatch, tmp_path):
    """An engine restarted after today's send must still keep the other
    profile's engine on this PC from sending on the same account."""
    import asyncio
    _tick_env(monkeypatch, tmp_path, claim_by=None)
    took = []
    monkeypatch.setattr(ks, "_claim", lambda slot, day: took.append(day))
    ks._put_state({"day": TODAY, "status": "sent"})
    asyncio.run(ks._tick(False))
    assert took == [TODAY]
    # Switched off holds it too: the other profile must not kickstart an
    # account whose owner turned the kickstart off.
    ks.save_config({"enabled": False})
    ks._put_state({})
    asyncio.run(ks._tick(False))
    assert took == [TODAY, TODAY]


def test_send_now_is_never_blocked_by_a_claim(monkeypatch, tmp_path):
    import asyncio
    sent = _tick_env(monkeypatch, tmp_path, claim_by="tony")
    asyncio.run(ks._tick(True))
    assert sent == ["k"]


def test_next_sleep_wakes_just_after_the_wait(monkeypatch):
    monkeypatch.setattr(ks, "state", lambda: {"until": 1000.0})
    assert ks.next_sleep(now=900.0) == 115.0
    assert ks.next_sleep(now=990.0) == 30.0          # floor
    monkeypatch.setattr(ks, "state", lambda: {})
    assert ks.next_sleep(now=900.0) == ks.TICK_S
