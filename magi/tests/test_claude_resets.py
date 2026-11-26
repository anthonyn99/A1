"""Claude and Codex reset times -> TaskHub (engine/claude_resets.py).

`wanted()` decides what is on the calendar and `needs_read()` how often the
usage endpoint is asked, so both are pinned: a known reset is never re-read,
a passed one is never pushed, and off means an empty list (which is what
makes the worker delete the events and reminders).
"""

from __future__ import annotations

import asyncio

import pytest

from magi.engine import claude_resets as cr

NOW = 1_790_000_000.0
CFG = dict(cr.DEFAULTS)


def _wins(five=None, week=None):
    w = {}
    if five is not None:
        w["five_hour"] = {"utilization": 0.2, "resets_at": five}
    if week is not None:
        w["seven_day"] = {"utilization": 0.3, "resets_at": week}
    return w


def test_the_next_five_hour_reset_on_the_minute():
    r = NOW + 3600 + 29.6
    got = cr.wanted(CFG, _wins(five=r), NOW)
    assert got == [{"kind": "five_hour", "at": round(r / 60) * 60}]
    assert got[0]["at"] % 60 == 0


def test_sub_second_wobble_is_the_same_event():
    a = cr.wanted(CFG, _wins(five=NOW + 3600.2), NOW)
    b = cr.wanted(CFG, _wins(five=NOW + 3600.9), NOW)
    assert cr.signature(CFG, a) == cr.signature(CFG, b)


def test_a_passed_or_missing_reset_is_not_pushed():
    assert cr.wanted(CFG, _wins(five=NOW - 60), NOW) == []
    assert cr.wanted(CFG, _wins(), NOW) == []
    assert cr.wanted(CFG, {"five_hour": {"utilization": 0, "resets_at": None}}, NOW) == []


def test_weekly_only_when_asked():
    w = _wins(five=NOW + 600, week=NOW + 86400 * 3)
    assert [i["kind"] for i in cr.wanted(CFG, w, NOW)] == ["five_hour"]
    assert [i["kind"] for i in cr.wanted({**CFG, "weekly": True}, w, NOW)] == ["five_hour", "seven_day"]


def test_off_is_an_empty_list():
    assert cr.wanted({**CFG, "enabled": False}, _wins(five=NOW + 600), NOW) == []


def test_reads_only_while_a_reset_is_unknown():
    # Known future reset: no read, however long ago the last one was.
    assert not cr.needs_read(CFG, _wins(five=NOW + 600), NOW, 0)
    # Unknown: read, but not more often than READ_EVERY_S.
    assert cr.needs_read(CFG, _wins(), NOW, 0)
    assert not cr.needs_read(CFG, _wins(), NOW, NOW - cr.READ_EVERY_S + 5)
    # Weekly wanted and missing: read.
    assert cr.needs_read({**CFG, "weekly": True}, _wins(five=NOW + 600), NOW, 0)
    # Off: never.
    assert not cr.needs_read({**CFG, "enabled": False}, _wins(), NOW, 0)


def test_settings_change_the_signature():
    items = cr.wanted(CFG, _wins(five=NOW + 600), NOW)
    assert cr.signature(CFG, items) != cr.signature({**CFG, "notify": False}, items)


def test_config_round_trips_and_ignores_strangers(tmp_path, monkeypatch):
    monkeypatch.setattr(cr, "data_dir", lambda: tmp_path)
    assert cr.config() == cr.DEFAULTS
    cr.save_config({"weekly": True, "notify": False, "evil": "x"})
    assert cr.config() == {"enabled": True, "notify": False, "weekly": True}


@pytest.fixture
def engine(tmp_path, monkeypatch):
    """A Tony engine with a signed-in account and a fake post."""
    monkeypatch.setattr(cr, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(cr, "active_profile", lambda: "tony")
    monkeypatch.setattr(cr, "api_token", lambda: "tok")
    monkeypatch.setattr(cr, "account_slot", lambda agent: "default")
    monkeypatch.setattr(cr, "plan_of", lambda slot, agent: "pro")
    monkeypatch.setattr(cr, "label_of", lambda slot, agent: "Tony")
    box = {"wins": _wins(five=NOW + 3600), "posts": [], "reads": 0}
    monkeypatch.setattr(cr, "stored_windows", lambda slot, agent: box["wins"])

    def read(slot, agent):
        box["reads"] += 1
    monkeypatch.setattr(cr, "read_windows", read)

    def post(profile, token, cfg, items, agent):
        box["posts"].append((profile, cfg["enabled"], cfg["notify"], items))
        return {"ok": True, "detail": ""}
    monkeypatch.setattr(cr, "post", post)
    monkeypatch.setattr(cr.time, "time", lambda: NOW)
    return box


def test_posts_only_on_change(engine):
    asyncio.run(cr.tick())
    asyncio.run(cr.tick())
    assert len(engine["posts"]) == 1
    assert engine["posts"][0][0] == "tony"
    assert engine["reads"] == 0                 # the reset was already known
    engine["wins"] = _wins(five=NOW + 7200)     # a new window
    asyncio.run(cr.tick())
    assert len(engine["posts"]) == 2
    p = cr.panel()
    assert p["unit"] == "claude-pro" and p["items"][0]["at"] == round((NOW + 7200) / 60) * 60


def test_turning_off_posts_an_empty_list(engine):
    asyncio.run(cr.tick())
    cr.save_config({"enabled": False})
    asyncio.run(cr.tick())
    assert engine["posts"][-1][1:] == (False, True, [])


@pytest.mark.parametrize("profile", ["tony", "veda"])
def test_codex_uses_its_own_usage_and_settings(profile, tmp_path, monkeypatch):
    from magi.code.agents import limits

    monkeypatch.setattr(cr, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(cr, "active_profile", lambda: profile)
    monkeypatch.setattr(cr, "api_token", lambda: "tok")
    monkeypatch.setattr(cr, "account_slot", lambda agent: "default")
    monkeypatch.setattr(cr, "plan_of", lambda slot, agent: "free")
    monkeypatch.setattr(cr, "label_of", lambda slot, agent: slot)
    monkeypatch.setattr(cr.time, "time", lambda: NOW)
    reset = NOW + 29 * 86400
    monkeypatch.setattr(limits, "usage", lambda agent, slot: {"30d": {"resets_at": reset}}
                        if (agent, slot) == ("codex", "default") else {})
    calls = []
    monkeypatch.setattr(cr, "post", lambda *a: calls.append(a) or {"ok": True, "detail": ""})

    cr.save_config({"notify": False, "weekly": True}, "codex")
    panel = asyncio.run(cr.tick(agent="codex"))
    asyncio.run(cr.tick(agent="codex"))
    assert panel["unit"] == "chatgpt" and panel["agent"] == "codex"
    assert calls == [(profile, "tok", cr.config("codex"),
                      [{"kind": "thirty_day", "at": round(reset / 60) * 60}], "codex")]
    assert cr.state() == {} and cr.config() == cr.DEFAULTS


@pytest.mark.parametrize("profile", ["tony", "veda"])
def test_paid_codex_ignores_old_free_window_and_reads_five_hour(profile, tmp_path, monkeypatch):
    from magi.code.agents import limits

    monkeypatch.setattr(cr, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(cr, "active_profile", lambda: profile)
    monkeypatch.setattr(cr, "api_token", lambda: "tok")
    monkeypatch.setattr(cr, "account_slot", lambda agent: "account")
    monkeypatch.setattr(cr, "plan_of", lambda slot, agent: "plus")
    monkeypatch.setattr(cr.time, "time", lambda: NOW)
    windows = {"30d": {"utilization": 0, "resets_at": NOW + 20 * 86400},
               "5h": {"utilization": 0, "resets_at": None}}
    monkeypatch.setattr(limits, "usage", lambda agent, slot: windows)
    reads, posts = [], []

    def read(slot, agent):
        reads.append((slot, agent))
        windows["5h"] = {"utilization": 1, "resets_at": NOW + 3600}

    monkeypatch.setattr(cr, "read_windows", read)
    monkeypatch.setattr(cr, "post", lambda *args: posts.append(args) or {"ok": True, "detail": ""})
    asyncio.run(cr.tick(agent="codex"))
    assert reads == [("account", "codex")]
    assert posts[0][0] == profile
    expected = [{"kind": "five_hour", "at": round((NOW + 3600) / 60) * 60}]
    assert posts[0][3] == expected
    assert cr.state("codex")["items"] == expected


def test_a_failed_post_is_retried_next_tick(engine, monkeypatch):
    monkeypatch.setattr(cr, "post", lambda *a: {"ok": False, "detail": "down"})
    asyncio.run(cr.tick())
    assert cr.panel()["ok"] is False and cr.panel()["detail"] == "down"
    calls = []
    monkeypatch.setattr(cr, "post", lambda *a: calls.append(a) or {"ok": True, "detail": ""})
    asyncio.run(cr.tick())
    assert calls == []                          # backing off: not every tick
    monkeypatch.setattr(cr.time, "time", lambda: NOW + cr.retry_after(1) + 1)
    asyncio.run(cr.tick())
    assert len(calls) == 1 and cr.panel()["ok"] is True


def test_backoff_grows_and_caps():
    assert [cr.retry_after(n) for n in (1, 2, 3, 4, 9)] == [300, 600, 1200, 1800, 1800]


def test_no_panel_on_an_unknown_profile(monkeypatch):
    monkeypatch.setattr(cr, "active_profile", lambda: "guest")
    assert cr.panel() is None
