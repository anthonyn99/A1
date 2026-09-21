"""Usage figures that are as fresh as the provider, not as old as the last task.

The bodies below are real responses from the two usage endpoints (trimmed,
identifiers removed), captured 2026-09-21 -- the morning the card still said
"5h used 90%" from the night before while the account was at 20%.
"""

from __future__ import annotations

import json
import time

import pytest

from magi.code.agents import limits, slots, usage_fetch as U

CLAUDE_BODY = {
    "five_hour": {"utilization": 20.0, "resets_at": "2026-09-21T17:10:00.685932+00:00",
                  "limit_dollars": None},
    "seven_day": {"utilization": 81.0, "resets_at": "2026-09-24T05:00:00.685954+00:00"},
    "seven_day_opus": None, "seven_day_sonnet": None,
    "nimbus_quill": {"utilization": 0.0, "resets_at": None},
    "extra_usage": {"is_enabled": False},
}
CODEX_FREE = {"plan_type": "free", "rate_limit": {
    "allowed": True, "limit_reached": False,
    "primary_window": {"used_percent": 6, "limit_window_seconds": 2592000,
                       "reset_after_seconds": 2536640, "reset_at": 1792542004},
    "secondary_window": None}}
CODEX_PLUS_LIMITED = {"rate_limit": {
    "allowed": False, "limit_reached": True,
    "primary_window": {"used_percent": 100, "limit_window_seconds": 18000, "reset_at": 1790000000},
    "secondary_window": {"used_percent": 40, "limit_window_seconds": 604800, "reset_at": 1790500000}}}


def test_claude_body_becomes_the_two_windows_the_ui_knows():
    w = U.parse_claude(CLAUDE_BODY)
    assert set(w) == {"five_hour", "seven_day"}, "codenamed / null windows are left out"
    assert w["five_hour"]["utilization"] == pytest.approx(0.20)
    assert w["seven_day"]["utilization"] == pytest.approx(0.81)
    assert w["seven_day"]["resets_at"] == pytest.approx(1790226000.685954)


def test_codex_free_account_has_one_thirty_day_window():
    w, allowed = U.parse_codex(CODEX_FREE)
    assert w == {"30d": {"utilization": 0.06, "resets_at": 1792542004.0}}
    assert allowed is True


def test_codex_plus_windows_and_a_reached_limit():
    w, allowed = U.parse_codex(CODEX_PLUS_LIMITED)
    assert set(w) == {"5h", "7d"} and w["5h"]["utilization"] == 1.0
    assert allowed is False


def test_a_window_past_its_reset_reads_zero_not_last_nights_figure():
    now = 1_790_000_000
    aged = limits.aged({"five_hour": {"utilization": 0.9, "resets_at": now - 60},
                        "seven_day": {"utilization": 0.77, "resets_at": now + 3600}}, now)
    assert aged["five_hour"]["utilization"] == 0.0 and aged["five_hour"]["reset"]
    assert aged["seven_day"]["utilization"] == 0.77


@pytest.fixture
def sandboxed(tmp_path, monkeypatch):
    monkeypatch.setattr(limits, "_path", lambda: tmp_path / "limits.json")
    monkeypatch.setattr(U, "_last", {})
    monkeypatch.setattr(slots, "slot_dir", lambda a, s: tmp_path / f"{a}-{s}")
    return tmp_path


def _claude_login(root, expires_in: float):
    d = root / "claude-work"
    d.mkdir(exist_ok=True)
    (d / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {
        "accessToken": "tok", "expiresAt": (time.time() + expires_in) * 1000}}))


def test_refresh_stores_fresh_figures_and_clears_an_outdated_limit(sandboxed, monkeypatch):
    _claude_login(sandboxed, 3600)
    calls = []
    monkeypatch.setattr(U, "_get", lambda url, h: calls.append((url, h)) or CLAUDE_BODY)
    limits.mark("claude", "work", time.time() + 7200, "old")
    U.refresh("claude", "work")
    assert calls and calls[0][0] == U.CLAUDE_URL
    assert calls[0][1]["Authorization"] == "Bearer tok"
    assert limits.usage("claude", "work")["seven_day"]["utilization"] == pytest.approx(0.81)
    assert limits.blocked_until("claude", "work") is None, "the provider says there is room"


def test_refresh_is_throttled(sandboxed, monkeypatch):
    _claude_login(sandboxed, 3600)
    calls = []
    monkeypatch.setattr(U, "_get", lambda url, h: calls.append(url) or CLAUDE_BODY)
    U.refresh("claude", "work")
    U.refresh("claude", "work")
    assert len(calls) == 1
    U.refresh("claude", "work", force=True)
    assert len(calls) == 2


def test_an_expired_token_is_never_used_or_refreshed(sandboxed, monkeypatch):
    """Refreshing it ourselves could race the CLI's own refresh and sign it out."""
    _claude_login(sandboxed, -60)
    calls = []
    monkeypatch.setattr(U, "_get", lambda url, h: calls.append(url) or CLAUDE_BODY)
    assert U.refresh("claude", "work") == {}
    assert calls == []


def test_a_failed_read_changes_nothing(sandboxed, monkeypatch):
    _claude_login(sandboxed, 3600)
    limits.note_usage("claude", "work", "five_hour", 0.5, time.time() + 600)
    monkeypatch.setattr(U, "_get", lambda url, h: None)
    assert U.refresh("claude", "work") == {}
    assert limits.usage("claude", "work")["five_hour"]["utilization"] == 0.5
