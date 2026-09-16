"""What a capture is validated AGAINST.

A real failure, 2026-09-15. "Does uranus have rings" got two good answers and
a correct verdict -- "ANSWER Yes. Uranus has 13 known rings..." -- and the run
reported "Chairman (ChatGPT) failed: ChatGPT's response shares almost no
vocabulary with the question, which usually means a previous conversation turn
was captured." The verdict was thrown away and the queue row went red.

The capture was fine. The REFERENCE was wrong: browser_base validated against
the prompt it had just sent, and the chairman's prompt is the whole synthesis
instruction plus every member's answer -- 6,492 characters on that run.
_overlap divides by the reference's vocabulary, so the verdict scored 0.098
against the prompt (threshold 0.10) where it scores 0.667 against the question.

It only bit captures in the 300-1200 char band, which means it only bit SHORT
verdicts -- simple factual questions -- and left long analytical ones alone.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from magi.engine.validate import (  # noqa: E402
    MAX_REFERENCE_WORDS, _overlap, validate_answer,
)

SRC = (REPO / "magi" / "providers" / "browser_base.py").read_text(encoding="utf-8")

QUESTION = "Does uranus have rings"
VERDICT = (
    "ANSWER Yes. Uranus has 13 known rings. They are much darker, narrower and "
    "fainter than Saturn's rings and are made mostly of dark particles, "
    "including ice and rocky material. The rings were first discovered in 1977, "
    "and additional rings were found by Voyager 2 and later observations. "
    "NOTES The rings are grouped into nine main rings plus fainter inner and "
    "outer ones. CONFIDENCE HIGH -- both members agreed on the count and on the "
    "discovery date."
)
# Stands in for the chairman's prompt: an instruction block, not a question.
PROMPT = QUESTION + " " + " ".join(f"instruction{i} clause{i}" for i in range(400))


def test_the_capture_is_validated_against_the_question():
    assert "ctx.question or question" in SRC, (
        "validated against the prompt that was sent again -- which for the "
        "chairman is the whole synthesis instruction"
    )


def test_a_good_short_verdict_survives_its_own_prompt():
    assert validate_answer(VERDICT, QUESTION, display_name="ChatGPT").ok


def test_an_instruction_block_is_refused_as_a_reference():
    """Belt and braces for the next caller that passes the wrong thing."""
    assert _overlap(PROMPT, VERDICT) == 1.0, (
        "a reference with hundreds of content words still scores answers, so "
        "every short answer reads as off-topic"
    )
    assert validate_answer(VERDICT, PROMPT, display_name="ChatGPT").ok


def test_the_guard_is_wide_enough_for_a_real_question():
    """Questions measured 2-40 content words; the chairman's prompt 600+."""
    assert 40 < MAX_REFERENCE_WORDS < 400
    long_question = " ".join(f"topic{i}" for i in range(50))
    assert _overlap(long_question, "topic1 topic2") < 1.0, (
        "the guard is so loose that a genuinely long question stops being "
        "checked at all"
    )


def test_a_stale_capture_is_still_caught():
    """The whole reason the check exists: a turn from another conversation."""
    stale = ("The grizzly bear is a subspecies of brown bear. Standing your "
             "ground is the advised response; running triggers a chase. ") * 4
    v = validate_answer(stale, "Compare Firestore and Cloudflare KV for an app",
                        display_name="ChatGPT")
    assert not v.ok
    assert "vocabulary" in v.summary
