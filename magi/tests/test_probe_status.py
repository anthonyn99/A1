"""How a selector non-match should be READ.

A miss only means something when the element could have been on the page. The
Doctor panel originally coloured every non-match red, which reported a healthy
install as three of four units broken across four fields each -- and sent a bug
report chasing a rewrite of selectors that were verified correct.

The live findings these encode (probed 2026-08-13 against the real sites):
  * claude.ai and gemini.google.com create the send button only once the
    composer has text: count goes 0 -> 1 on the first keystroke.
  * assistant_turn / stop_button / streaming_marker cannot match on an idle
    chat -- no answer on screen, nothing generating.
  * DeepSeek configures `submit` as an empty list on purpose; it is driven by
    the Enter key because it has no stable send-button selector.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.browser.resolve import Probe, ProbeStatus  # noqa: E402


def _miss(field: str, tried: int = 3, **kw) -> Probe:
    return Probe(field=field, matched=None, count=0,
                 tried=[f"sel{i}" for i in range(tried)], **kw)


def test_a_match_is_ok():
    p = Probe(field="input", matched="div.ProseMirror", count=1, tried=["div.ProseMirror"])
    assert p.status is ProbeStatus.OK
    assert p.ok


def test_idle_only_fields_are_not_faults():
    """No answer on screen and nothing generating -- these cannot match."""
    for field in ("assistant_turn", "stop_button", "streaming_marker"):
        p = _miss(field)
        assert p.status is ProbeStatus.NOT_APPLICABLE, field
        assert "idle" in p.note


def test_submit_missing_on_an_idle_page_is_not_a_fault():
    """Verified live: the send button does not exist on an empty composer."""
    p = _miss("submit")
    assert p.status is ProbeStatus.NOT_APPLICABLE
    assert "composer has text" in p.note


def test_submit_missing_after_typing_IS_a_fault():
    """Once primed, the button should exist -- absence is now real evidence."""
    p = _miss("submit", verified_absent=True)
    assert p.status is ProbeStatus.MISS


def test_empty_candidate_list_is_deliberate_not_broken():
    """DeepSeek's submit is empty by design; it sends with the Enter key.

    This is the 'all 0 failed' row that read as a hard failure.
    """
    p = Probe(field="submit", matched=None, count=0, tried=[])
    assert p.status is ProbeStatus.UNSET
    assert "Enter key" in p.note


def test_absent_login_and_challenge_controls_are_the_healthy_case():
    """A missing login wall means the session works. That is good news."""
    for field in ("login_selectors", "challenge_selectors"):
        p = _miss(field)
        assert p.status is ProbeStatus.NOT_APPLICABLE, field
        assert "healthy" in p.note


def test_a_missing_input_selector_is_a_real_fault():
    """The composer is always on screen; if it does not match, it is broken."""
    p = _miss("input")
    assert p.status is ProbeStatus.MISS
    assert p.note == ""


def test_the_reported_doctor_table_contains_no_real_faults():
    """Replays the exact table from the bug report.

    Every red MISS in it was one of the benign cases. Reproducing it must now
    yield zero faults, or the false alarm has returned.
    """
    reported = [
        ("claude", "submit", 3), ("claude", "assistant_turn", 4),
        ("claude", "stop_button", 1), ("claude", "streaming_marker", 1),
        ("claude", "login_selectors", 3), ("claude", "challenge_selectors", 2),
        ("gemini", "submit", 3), ("gemini", "assistant_turn", 4),
        ("gemini", "stop_button", 2), ("gemini", "streaming_marker", 0),
        ("gemini", "challenge_selectors", 2),
        ("deepseek", "submit", 0), ("deepseek", "assistant_turn", 2),
        ("deepseek", "stop_button", 0), ("deepseek", "streaming_marker", 0),
        ("deepseek", "login_selectors", 2), ("deepseek", "challenge_selectors", 1),
    ]
    faults = [
        (unit, field)
        for unit, field, tried in reported
        if _miss(field, tried).status is ProbeStatus.MISS
    ]
    assert faults == []
