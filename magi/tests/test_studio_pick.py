"""Studio must never drive a unit the person has unticked.

A card generated after unticking Claude still went to Claude: the picker
reused the ORIGINAL run's stored chairman unconditionally, so a Report came
back labelled "Ready - claude" with that account driven and its quota spent.

Unticking a unit has to mean it is not driven at all -- it is someone's paid
account and their explicit instruction -- not merely that it sits out the next
council run.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.engine.studio import pick_generator_id  # noqa: E402
from magi.settings import load_settings  # noqa: E402


def _s():
    return load_settings()


def test_the_run_chairman_is_refused_when_it_is_unticked():
    """The exact reported bug: Claude chaired the run, then was unticked."""
    got = pick_generator_id(_s(), "claude", ["chatgpt", "gemini"])
    assert got != "claude"
    assert got in ("chatgpt", "gemini")


def test_the_run_chairman_is_preferred_when_it_is_still_selected():
    """It answered moments ago, so it is the best guess when allowed."""
    assert pick_generator_id(_s(), "claude", ["claude", "chatgpt"]) == "claude"


def test_a_single_selected_unit_is_the_only_choice():
    for only in ("chatgpt", "gemini", "deepseek"):
        assert pick_generator_id(_s(), "claude", [only]) == only


def test_the_configured_chairman_is_skipped_when_unticked():
    s = _s()
    others = [p for p in s.enabled_site_ids() if p != s.chairman.provider_id]
    assert others, "test needs more than one enabled site"
    assert pick_generator_id(s, None, others) != s.chairman.provider_id


def test_no_selection_falls_back_to_enabled_rather_than_failing():
    """A Studio that silently cannot run is worse than one that picks."""
    assert pick_generator_id(_s(), None, None) in _s().enabled_site_ids()
    assert pick_generator_id(_s(), None, ["nosuchmodel"]) in _s().enabled_site_ids()
