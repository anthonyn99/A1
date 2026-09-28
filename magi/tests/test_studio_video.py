"""Studio's Video: written by the best SELECTED unit, never an unticked one.

Every other card falls back to "whatever is enabled" when the selection is
empty or unknown. Video does not: it walks a quality-ranked chain of exactly
the ticked units, and an empty selection is refused out loud rather than
quietly driving an account the person switched off.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from magi.engine.studio import (
    VIDEO_RANK,
    StudioKind,
    _parse_video,
    build_prompt,
    video_writer_chain,
)
from magi.settings import load_settings

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")


def _s():
    return load_settings()


def test_chain_is_only_the_ticked_units_best_first():
    chain = video_writer_chain(_s(), ["gemini", "deepseek", "chatgpt"])
    assert chain == ["chatgpt", "gemini", "deepseek"]


def test_an_unticked_unit_never_enters_the_chain():
    for unticked in VIDEO_RANK:
        allowed = [p for p in VIDEO_RANK if p != unticked]
        assert unticked not in video_writer_chain(_s(), allowed)


@pytest.mark.parametrize("sel", [None, [], ["nosuchmodel"]])
def test_no_usable_selection_is_refused_not_filled_in(sel):
    with pytest.raises(ValueError):
        video_writer_chain(_s(), sel)


def test_prompt_asks_for_the_scene_format():
    p = build_prompt(StudioKind.VIDEO, question="Q?", answers=[], verdict="V.")
    for label in ("VIDEO TITLE:", "SCENE 1", "LAYOUT:", "HEADLINE:", "VISUAL:", "NARRATION:"):
        assert label in p


def test_parser_survives_a_capture_that_lost_its_newlines():
    raw = ("VIDEO TITLE: Leak SCENE 1 LAYOUT: title HEADLINE: The Leak VISUAL: - sub "
           "NARRATION: One.SCENE 2 LAYOUT: stat HEADLINE: Most VISUAL: - 73% | orphaned "
           "- context NARRATION: Two.SCENE 3 LAYOUT: bogus HEADLINE: End VISUAL: - x NARRATION: Three.")
    v = _parse_video(raw)
    assert v["title"] == "Leak"
    assert [s["layout"] for s in v["scenes"]] == ["title", "stat", "points"]
    assert v["scenes"][1]["visual"] == ["73% | orphaned", "context"]
    assert v["scenes"][2]["narration"] == "Three."


def test_parser_keeps_only_the_final_draft():
    one = "SCENE 1\nLAYOUT: title\nHEADLINE: A\nNARRATION: a\nSCENE 2\nLAYOUT: closing\nHEADLINE: B\nNARRATION: b\n"
    v = _parse_video("draft\n" + one + "final\n" + one)
    assert len(v["scenes"]) == 2


def test_console_offers_video_as_a_real_card():
    assert '"video"]' in PAGE and "video:      { label: \"Video\"" in PAGE
    # The old permanently-disabled tile is gone.
    assert "No video generation surface exists" not in PAGE


def test_narration_voices_are_single_language_and_match_the_console():
    """Multilingual voices switched accent mid-video on foreign names."""
    import re as _re

    from magi.app import TTS_VOICES

    assert not [v for v in TTS_VOICES.values() if "Multilingual" in v]
    block = PAGE[PAGE.index("const VIDEO_VOICES = ["):]
    block = block[:block.index("];")]
    assert set(_re.findall(r'\["(\w+)", "', block)) == set(TTS_VOICES)


def test_captions_are_never_sliced():
    """A caption used to keep only the last two wrapped lines of a chunk."""
    fn = PAGE[PAGE.index("  function caption(i, t) {"):]
    fn = fn[:fn.index("\n  }\n")]
    assert ".slice(" not in fn
