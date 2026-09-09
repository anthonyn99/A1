"""Post-capture validation.

The cases named "observed" are replays of real captures from the 2026-08-12
runs, where a one-sentence clarifying question was recorded RESOLVED, counted
toward a 4/4 quorum, and reported as HIGH-confidence consensus.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.engine.chairman import build_prompt, cap_confidence  # noqa: E402
from magi.engine.validate import (  # noqa: E402
    MIN_ANSWER_CHARS,
    Rejection,
    validate_answer,
)
from magi.providers.base import Answer, ProviderState  # noqa: E402


def _real_answer(topic: str = "trading") -> str:
    """A capture long enough to look like the good ones (4k-12k chars)."""
    return (
        f"The {topic} logic should live in a dedicated service module. "
        "Keep the decision rules separate from the execution path so each can "
        "be tested without the other. "
    ) * 40


# -- the two observed failures ------------------------------------------------


def test_observed_balthasar_where_should_this_live():
    """Run 2026-08-12 20:31: 23 chars, recorded RESOLVED, counted as a vote."""
    v = validate_answer(
        "Where should this live?",
        "Where should the trading logic live in my codebase?",
        display_name="Balthasar",
    )
    assert not v.ok
    assert v.reason is Rejection.CLARIFYING_QUESTION
    assert "Balthasar" in v.summary and "23" in v.summary


def test_observed_balthasar_long_short_call():
    """Run 2026-08-12 21:47: 51 chars in the UI, also a clarifying question."""
    v = validate_answer(
        "How should the long/short call be made?",
        "Should I go long or short on NVDA into earnings?",
        display_name="Balthasar",
    )
    assert not v.ok
    assert v.reason is Rejection.CLARIFYING_QUESTION


# -- the good captures must still pass ----------------------------------------


def test_full_length_answers_pass():
    """The 4k-12k char structured answers from the same runs."""
    v = validate_answer(_real_answer(), "Where should the trading logic live?")
    assert v.ok
    assert v.reason is None


def test_long_answer_ending_in_a_question_is_not_rejected():
    """Rhetorical questions are normal prose, not clarification requests."""
    body = _real_answer() + " So which should you actually pick?"
    assert validate_answer(body, "Where should the trading logic live?").ok


def test_clarifying_opener_phrased_as_a_statement():
    v = validate_answer(
        "Could you clarify which repository you mean.",
        "Where should the trading logic live?",
    )
    assert not v.ok
    assert v.reason is Rejection.CLARIFYING_QUESTION


def test_short_but_genuine_answer_is_kept_when_on_topic():
    """A terse real answer must not be overruled just for being short.

    Short answers are caught by FORM (is it a question?), not size alone --
    rejecting a correct terse answer would be a worse bug than admitting a
    bad capture.
    """
    v = validate_answer(
        "No. Postgres handles this workload fine at your volume.",
        "Should I migrate my Postgres database to Cassandra?",
    )
    assert v.ok


def test_stale_turn_from_a_previous_conversation():
    """Long enough to look real, but engaging with nothing that was asked."""
    v = validate_answer(
        (
            "Sourdough needs a wetter starter and a longer cold proof in the "
            "fridge, usually overnight, before you shape the loaf. "
        ) * 5,
        "Which cloud provider should I use for GPU training?",
    )
    assert not v.ok
    assert v.reason is Rejection.OFF_TOPIC


def test_observed_truncated_deepseek_captures():
    """Observed live: DeepSeek's first word captured before the rest streamed.

    It exposes no streaming marker and no stop button, so completion rests on
    text stability; it emits one word, pauses ~3s, then streams the answer.
    """
    for word in ("OK", "ok", "Print"):
        v = validate_answer(word, "Explain how TCP congestion control works.")
        assert not v.ok, word
        assert v.reason is Rejection.TRUNCATED


# -- calibration against the real corpus --------------------------------------
#
# Replaying all 86 successful captures in data/magi.db rejected 17, every one a
# genuine failure (9 truncated one-word streams, 8 Claude clarifying
# questions), with no false positives. The cases below are the ones that made
# an earlier, stricter version reject CORRECT answers -- they exist to stop
# that regression returning.


def test_deliberately_terse_answers_the_user_asked_for():
    """"One sentence." means a one-sentence answer is correct, not defective.

    A good short answer introduces new vocabulary rather than echoing the
    prompt, so a word-overlap test rejects exactly the answers that are best.
    An earlier version discarded 20+ of these.
    """
    cases = [
        (
            "Name one underrated engineering practice. One sentence.",
            "Treat observability as a product feature, not merely a debugging tool.",
        ),
        (
            "Name one habit that compounds over a career. One sentence.",
            "Consistently seeking feedback and acting on it.",
        ),
        (
            "Name one underrated debugging technique. One sentence.",
            "Explain the bug out loud, line by line, to a rubber duck.",
        ),
    ]
    for question, answer in cases:
        assert validate_answer(answer, question).ok, answer


def test_empty_capture():
    assert not validate_answer("", "anything").ok
    assert not validate_answer("   \n ", "anything").ok


def test_suspicion_threshold_sits_far_below_real_answers():
    """Guards the calibration: bad captures were 23-51 chars, good ones 4k+."""
    assert 51 < MIN_ANSWER_CHARS < 4000


def test_length_alone_never_rejects_a_capture():
    """The threshold marks a capture suspicious; only FORM rejects it.

    Regression guard: an earlier version rejected everything under the
    threshold, which threw away correct terse answers.
    """
    terse_but_relevant = "Yes, use Postgres."
    assert len(terse_but_relevant) < MIN_ANSWER_CHARS
    assert validate_answer(terse_but_relevant, "Should I use Postgres or Mongo?").ok


# -- degraded answers are excluded from synthesis -----------------------------


def _degraded() -> Answer:
    return Answer.degraded_capture(
        "claude", "Balthasar", "Where should this live?",
        "Balthasar asked a clarifying question instead of answering.",
    )


def _ok(name: str) -> Answer:
    return Answer(
        provider_id=name.lower(), display_name=name, text=_real_answer(),
        ok=True, state=ProviderState.DONE,
    )


def test_degraded_answer_is_not_ok_and_keeps_its_text():
    a = _degraded()
    assert a.ok is False                      # excluded from every quorum count
    assert a.state is ProviderState.DEGRADED  # distinct from FAILED
    assert a.failure is None                  # it did not fail; it responded
    assert a.text                             # text kept, so the UI can show it


def test_degraded_text_never_reaches_the_synthesis_prompt():
    prompt = build_prompt(
        "Where should the trading logic live?",
        [_ok("Melchior"), _degraded(), _ok("Casper")],
    )
    assert "Where should this live?" not in prompt
    assert "3 of 3" not in prompt          # must not claim all three answered
    assert "2 of 3" in prompt
    assert "excluded for an unusable response: Balthasar" in prompt


def test_degraded_member_is_not_reported_as_having_failed():
    """It responded -- calling it 'did not respond' misreports what happened."""
    prompt = build_prompt("q?", [_ok("Melchior"), _degraded()])
    assert "did not respond" not in prompt


def test_prompt_instructs_the_chairman_to_cap_confidence():
    prompt = build_prompt("q?", [_ok("Melchior"), _ok("Casper"), _degraded()])
    assert "at most MEDIUM" in prompt


def test_no_ceiling_language_when_every_member_was_usable():
    prompt = build_prompt("q?", [_ok("Melchior"), _ok("Casper")])
    assert "at most MEDIUM" not in prompt


# -- confidence capping -------------------------------------------------------


def test_high_confidence_is_forced_down_to_medium():
    verdict = "ANSWER\nUse Postgres.\n\nNOTES\nNone.\n\nCONFIDENCE\nHIGH -- all agreed."
    out = cap_confidence(verdict, reason="Balthasar returned no usable answer.")
    assert "HIGH" not in out
    assert "CONFIDENCE\nMEDIUM -- all agreed." in out
    assert "capped at MEDIUM" in out


def test_capping_leaves_medium_and_low_untouched():
    for level in ("MEDIUM", "LOW"):
        verdict = f"ANSWER\nx\n\nCONFIDENCE\n{level} -- split council."
        assert cap_confidence(verdict, reason="r") == verdict


def test_capping_ignores_the_word_high_in_the_answer_body():
    """Only the CONFIDENCE rating is a rating; prose is prose."""
    verdict = (
        "ANSWER\nHIGH availability matters most here.\n\n"
        "CONFIDENCE\nMEDIUM -- limited evidence."
    )
    assert cap_confidence(verdict, reason="r") == verdict
