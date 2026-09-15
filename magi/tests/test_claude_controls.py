"""Choosing Claude's model and effort, and capping what it may spend.

Written after checking the account MAGI actually drives, which changed what
this code has to do. On that plan the model menu lists Fable 5.1, Opus 5,
Opus 4.8/4.7/4.6/3 -- and EVERY ONE of them says "Upgrade". Haiku is not in
the menu at all, and the current model is not a row: it is simply what the
trigger already reads. Clicking an upgrade row opens billing and changes no
model.

So the rule this file mostly exists to protect is: MAGI must never click a row
that sells a model, and must never report a model it did not get. Effort is
the lever that does work there -- Low/Medium/High/Extra/Max, verified live,
landing in the trigger's own label ("Sonnet 5 High").
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from magi import accounts as accounts_mod  # noqa: E402
from magi import usage as usage_mod  # noqa: E402
from magi.engine import modelpick  # noqa: E402
from magi.providers.browser_base import BrowserProvider  # noqa: E402
from magi.settings import load_settings  # noqa: E402

SITE = load_settings().site("claude")
SRC = (REPO / "magi" / "providers" / "browser_base.py").read_text(encoding="utf-8")


# ── the model menu ──────────────────────────────────────────────────────────
def test_haiku_is_a_model_you_can_ask_for():
    assert modelpick.HAIKU in modelpick.MODELS
    assert modelpick.resolve("haiku", "anything").model == "haiku"


def test_an_upgrade_row_is_never_clicked():
    """Verified live: asking for opus on this plan left the composer alone
    and said 'not on this Claude plan', rather than opening billing."""
    fake = type("P", (), {"site": SITE})()
    locked = BrowserProvider._locked
    assert locked(fake, "Opus 5 Pro For complex tasks Upgrade") is True
    assert locked(fake, "Sonnet 5 Medium") is False


def test_the_locked_words_are_configured_not_hardcoded():
    assert SITE.model_locked_text, "nothing marks a row as an upgrade offer"
    assert "_locked(" in SRC and "model_locked_text" in SRC


def test_a_model_behind_a_submenu_is_still_looked_for():
    assert SITE.model_more, "More models is not configured"
    assert "site.model_more" in SRC


def test_never_reports_a_model_it_did_not_get():
    """The whole point: the label is read back AFTER the attempt."""
    i = SRC.index("async def _ensure_model")
    body = SRC[i : SRC.index("async def _ensure_effort")]
    assert "after = await self._read_model(page)" in body
    assert "answered on" in body, "a failed switch does not say what did answer"


# ── effort ──────────────────────────────────────────────────────────────────
def test_effort_is_configured_for_claude():
    assert SITE.effort_button and SITE.effort_option


@pytest.mark.parametrize("level", ["low", "medium", "high", "extra", "max"])
def test_every_effort_level_is_accepted(level):
    assert level in modelpick.EFFORTS


def test_max_effort_is_never_chosen_automatically():
    """Claude's own menu says 3.5x or more usage. Opting into that has to be
    a decision, not a side effect of a long prompt."""
    assert "max" not in modelpick.EFFORT_AUTO
    for q in ("Design a schema and explain the trade-offs " * 40,
              "Debug this traceback and find the root cause"):
        assert modelpick.suggest(q, attachments=4, units=6).effort != "max"


def test_effort_tracks_the_same_judgement_as_the_model():
    assert modelpick.suggest("Design a schema and explain the trade-offs").effort == "high"
    assert modelpick.suggest("what is the capital of Denmark?").effort == "low"


def test_an_explicit_effort_survives_an_auto_model():
    p = modelpick.resolve("auto", "Design a schema", effort="max")
    assert p.effort == "max"
    assert p.model == "opus", "choosing an effort must not also pin the model"


# ── the cap ─────────────────────────────────────────────────────────────────
def _cap(**over):
    prefs = {"cap_enabled": True, "cap_tokens": 1000, "cap_percent": 90}
    prefs.update(over)
    return usage_mod.cap_state(prefs)


def test_the_cap_is_a_share_of_your_own_budget():
    """There is no percentage of Anthropic's limit anywhere, because the limit
    is not published and not in the data."""
    s = _cap()
    assert s["budget"] == 1000
    assert "you budgeted" in s["note"]


def test_a_cap_with_no_budget_cannot_be_enabled():
    prefs = accounts_mod.set_claude_prefs(cap_enabled=True, cap_tokens=0)
    try:
        assert prefs["cap_enabled"] is False, (
            "a cap with no denominator would fire on the first token or never"
        )
    finally:
        accounts_mod.set_claude_prefs(
            cap_enabled=False, cap_tokens=0, cap_percent=90,
            model="auto", effort="auto")


def test_an_unreadable_transcript_leaves_claude_available():
    """The failure that loses nothing: reporting zero used keeps Claude, where
    guessing high would silently drop a unit from every run."""
    src = (REPO / "magi" / "usage.py").read_text(encoding="utf-8")
    body = src[src.index("def cap_state("):]
    assert "used = 0" in body and "except Exception" in body


def test_the_cap_only_governs_the_unit_it_can_measure():
    app = (REPO / "magi" / "app.py").read_text(encoding="utf-8")
    assert 'CAPPED_ID = "claude"' in app, (
        "a cap on a unit whose usage nothing records would be an invented "
        "number about a number that does not exist"
    )


def test_a_run_already_going_keeps_claude():
    """Checked as a run STARTS and never again."""
    app = (REPO / "magi" / "app.py").read_text(encoding="utf-8")
    gate = app[app.index("def _claude_gate("):]
    gate = gate[: gate.index("\ndef ")]
    assert "STARTS" in gate or "starts" in gate
    # The only callers are the two entry points, not the per-round loops.
    assert app.count("_claude_gate(") == 3, (
        "the gate is called somewhere new -- if that is mid-run, a "
        "deliberation can now lose Claude halfway through"
    )


def test_dropping_the_last_unit_is_an_error_not_a_silent_empty_run():
    app = (REPO / "magi" / "app.py").read_text(encoding="utf-8")
    assert app.count("Untick the cap in Accounts") == 2, (
        "one of the two entry points no longer explains an empty council"
    )
