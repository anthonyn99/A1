"""Claude's reset times -> TaskHub (engine/claude_resets.py).

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
    monkeypatch.setattr(cr, "account_slot", lambda: "default")
    monkeypatch.setattr(cr, "plan_of", lambda slot: "pro")
    monkeypatch.setattr(cr, "label_of", lambda slot: "Tony")
    box = {"wins": _wins(five=NOW + 3600), "posts": [], "reads": 0}
    monkeypatch.setattr(cr, "stored_windows", lambda slot: box["wins"])

    def read(slot):
        box["reads"] += 1
    monkeypatch.setattr(cr, "read_windows", read)

    def post(profile, token, cfg, items):
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


def test_a_failed_post_is_retried_next_tick(engine, monkeypatch):
    monkeypatch.setattr(cr, "post", lambda *a: {"ok": False, "detail": "down"})
    asyncio.run(cr.tick())
    assert cr.panel()["ok"] is False and cr.panel()["detail"] == "down"
    calls = []
    monkeypatch.setattr(cr, "post", lambda *a: calls.append(a) or {"ok": True, "detail": ""})
    asyncio.run(cr.tick())
    assert len(calls) == 1 and cr.panel()["ok"] is True


def test_no_panel_on_an_unknown_profile(monkeypatch):
    monkeypatch.setattr(cr, "active_profile", lambda: "guest")
    assert cr.panel() is None
