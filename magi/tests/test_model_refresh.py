"""The weekly model-list refresh (engine/model_refresh.py).

The slot is Monday 4 AM local, caught up after a PC that was off; each unit
is read once per slot; a busy one is retried soon; a failed read keeps the
old list and is not retried until next week; Code Mode's catalogs are forced
once per slot.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest

from magi.engine import model_refresh as mr


def test_slot_is_the_most_recent_monday_4am():
    # 2026-11-12 is a Thursday.
    assert mr.slot_for(datetime(2026, 11, 12, 13, 48)) == datetime(2026, 11, 9, 4, 0)
    # Monday before 4 AM: still last week's slot.
    assert mr.slot_for(datetime(2026, 11, 16, 3, 59)) == datetime(2026, 11, 9, 4, 0)
    # Monday at 4 AM: this week's.
    assert mr.slot_for(datetime(2026, 11, 16, 4, 0)) == datetime(2026, 11, 16, 4, 0)
    assert mr.next_slot(datetime(2026, 11, 12, 13, 48)) == datetime(2026, 11, 16, 4, 0)


def test_pending_is_per_slot():
    slot = datetime(2026, 11, 9, 4, 0)
    st = {"slot": slot.isoformat(), "units": {"claude": {"ok": True}}}
    assert mr.pending(st, slot, ["claude", "gemini"]) == ["gemini"]
    # A new week: everything again.
    assert mr.pending(st, datetime(2026, 11, 16, 4, 0), ["claude", "gemini"]) == ["claude", "gemini"]


@pytest.fixture
def fake(monkeypatch, tmp_path):
    state: dict = {}
    monkeypatch.setattr(mr, "load_state", lambda: dict(state, units=dict(state.get("units", {}))))
    monkeypatch.setattr(mr, "save_state", lambda d: state.update(d))
    monkeypatch.setattr(mr, "GAP_S", 0)
    calls = {"code": 0, "read": []}
    monkeypatch.setattr(mr, "refresh_code_catalogs", lambda: calls.__setitem__("code", calls["code"] + 1))
    monkeypatch.setattr(mr, "pickable_units", lambda s: ["claude", "claude_pro", "gemini"])
    results = {"claude": ("ok", "5 models"), "claude_pro": ("busy", "in a run"), "gemini": ("failed", "signed out")}

    async def read(settings, bp, pid):
        calls["read"].append(pid)
        return results[pid]
    monkeypatch.setattr(mr, "read_unit", read)
    return SimpleNamespace(state=state, calls=calls, results=results)


def test_a_week_reads_each_unit_once_and_retries_only_the_busy_one(fake):
    now = datetime(2026, 11, 16, 4, 1)
    wait = asyncio.run(mr.tick(None, None, now=now))
    assert fake.calls["read"] == ["claude", "claude_pro", "gemini"]
    assert fake.calls["code"] == 1
    assert wait == mr.BUSY_S
    assert set(fake.state["units"]) == {"claude", "gemini"}
    assert fake.state["units"]["gemini"]["ok"] is False      # failed: kept, not retried

    fake.results["claude_pro"] = ("ok", "4 models")
    fake.calls["read"].clear()
    wait = asyncio.run(mr.tick(None, None, now=now))
    assert fake.calls["read"] == ["claude_pro"]
    assert fake.calls["code"] == 1                           # once per slot

    fake.calls["read"].clear()
    wait = asyncio.run(mr.tick(None, None, now=now))
    assert fake.calls["read"] == []                          # done until next Monday
    assert wait == mr.IDLE_S
