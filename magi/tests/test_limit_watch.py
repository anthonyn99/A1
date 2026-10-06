"""The free Claude cap is re-read on its own (engine/limit_watch.py)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from magi.engine import limit_watch as lw
from magi.engine import units

NOW = datetime(2026, 10, 6, 17, 0, tzinfo=timezone.utc)


def _entry(resets_in_s=None, limited=True):
    if not limited:
        return {"limit": None}
    at = (NOW + timedelta(seconds=resets_in_s)).isoformat() if resets_in_s is not None else None
    return {"limit": {"resets_at": at}}


def test_sleeps_until_just_after_the_reset():
    wait, go = lw.next_wait(_entry(600), NOW, None, True)
    assert not go and wait == 600 + lw.AFTER_RESET_S


def test_probes_once_the_reset_has_passed():
    assert lw.next_wait(_entry(-30), NOW, None, True) == (0.0, True)


def test_never_probes_twice_inside_the_gap():
    last = NOW - timedelta(seconds=60)
    wait, go = lw.next_wait(_entry(-30), NOW, last, True)
    assert not go and wait == lw.MIN_GAP_S - 60


def test_a_cap_without_a_reset_time_is_looked_at_slowly():
    assert lw.next_wait(_entry(None), NOW, None, True)[1] is True
    last = NOW - timedelta(seconds=100)
    wait, go = lw.next_wait(_entry(None), NOW, last, True)
    assert not go and wait == lw.NO_RESET_S - 100


def test_nothing_is_opened_while_the_unit_is_fine():
    assert lw.next_wait(_entry(limited=False), NOW, None, False) == (float(lw.IDLE_S), False)


def test_a_wall_that_just_ran_out_is_confirmed_once():
    assert lw.next_wait(_entry(limited=False), NOW, None, True) == (0.0, True)


def test_a_clean_check_clears_a_run_recorded_cap_for_claude_only():
    at = NOW - timedelta(hours=2)
    run = {"kind": "rate_limited", "limit": True, "at": at.isoformat(),
           "detail": "x", "resets_at": None, "reset_passed": False, "cleared": False}
    check = {"at": NOW.isoformat(), "reachable": True, "logged_in": True,
             "usable": True, "limit": ""}

    def state(pid):
        return units.summarize(
            provider_id=pid, display_name=pid, recent={"issues": [run]},
            facts={}, check=check, account=None, now=NOW)["state"]

    assert state("claude") != "limited"
    assert state("grok") == "limited"   # its cap only shows on a send
