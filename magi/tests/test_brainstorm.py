"""Brainstorm engine: the deliberation contract, not the browser plumbing.

These cover the properties that made the council's output untrustworthy rather
than merely imperfect -- a lost answer, a repeated question, a plan declared
finished over an unanswered question that decided its shape. Each one is a
behaviour that was observed going wrong, so each test names what it protects.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.engine import brainstorm as b  # noqa: E402


def chairman_turn(round_no: int, parsed: dict, *, phase: str = "round", attempt: int = 1):
    return {
        "round_no": round_no,
        "attempt": attempt,
        "role": "chairman",
        "provider_id": "claude",
        "phase": phase,
        "parsed_json": json.dumps(parsed),
    }


def user_turn(round_no: int, content: str, *, phase: str = "round", attempt: int = 1):
    return {
        "round_no": round_no,
        "attempt": attempt,
        "role": "user",
        "content": content,
        "phase": phase,
    }


# ── the appendix must not lose an answer ────────────────────────────────────

def test_finalize_reply_does_not_overwrite_the_round_reply():
    """The bug: both turns share a round number, so one silently replaced the
    other in a document whose own summary promises 'every answer given'."""
    turns = [
        {"round_no": 2, "attempt": 1, "role": "council", "provider_id": "chatgpt",
         "ok": 1, "content": "proposal", "phase": "round"},
        user_turn(2, "the round answer"),
        user_turn(2, "the finalise answer", phase="finalize"),
    ]
    out = b.build_transcript_appendix(turns)
    assert "the round answer" in out
    assert "the finalise answer" in out


def test_finalize_pass_is_labelled_as_one():
    turns = [
        user_turn(2, "round reply"),
        user_turn(2, "final reply", phase="finalize"),
    ]
    out = b.build_transcript_appendix(turns)
    assert "### Round 2" in out
    assert "### Finalise pass" in out


def test_superseded_is_scoped_per_phase():
    """A finalise pass must never mark the round it followed as superseded."""
    turns = [
        user_turn(3, "round reply", attempt=1),
        user_turn(3, "final reply", phase="finalize", attempt=1),
    ]
    out = b.build_transcript_appendix(turns)
    assert "superseded" not in out


def test_retried_round_is_still_marked_superseded():
    turns = [
        user_turn(1, "first try", attempt=1),
        user_turn(1, "second try", attempt=2),
    ]
    out = b.build_transcript_appendix(turns)
    assert "superseded" in out
    assert "first try" in out and "second try" in out


# ── the ledger must stop a question being re-asked ──────────────────────────

def test_answered_question_is_dropped_from_the_next_round():
    turns = [
        chairman_turn(1, {"plan_so_far": "d", "questions": [{"q": "What is your budget?"}]}),
        user_turn(2, "ANSWERS FROM THE PERSON\n1. What is your budget?\n   -> 500 dollars"),
    ]
    kept, dropped = b.drop_answered_questions(
        [{"q": "What is your budget?"}, {"q": "How should errors be logged?"}], turns
    )
    assert [k["q"] for k in kept] == ["How should errors be logged?"]
    assert dropped == ["What is your budget?"]


def test_a_skipped_question_is_not_re_asked_either():
    """Skipping is an answer -- it means 'you decide' -- so it must not return."""
    turns = [
        chairman_turn(1, {"plan_so_far": "d", "questions": [{"q": "Which cloud provider?"}]}),
        user_turn(
            2,
            "ANSWERS FROM THE PERSON\n1. Which cloud provider?\n"
            "   -> (not answered -- decide this one yourself)",
        ),
    ]
    kept, dropped = b.drop_answered_questions([{"q": "Which cloud provider?"}], turns)
    assert kept == []
    assert dropped == ["Which cloud provider?"]
    # ...but it carries no fact, so it is not reported as answered.
    assert b.answered_questions(turns) == []


def test_a_genuinely_different_question_survives_the_filter():
    turns = [
        chairman_turn(1, {"plan_so_far": "d", "questions": [{"q": "Which database?"}]}),
        user_turn(2, "ANSWERS FROM THE PERSON\n1. Which database?\n   -> sqlite"),
    ]
    kept, _ = b.drop_answered_questions(
        [{"q": "Which database migration tool should we use?"}], turns
    )
    assert len(kept) == 1


def test_ledger_block_separates_answered_from_skipped():
    turns = [
        chairman_turn(1, {"plan_so_far": "d", "questions": [
            {"q": "What is your budget?"}, {"q": "Which region?"},
        ]}),
        user_turn(
            2,
            "ANSWERS FROM THE PERSON\n1. What is your budget?\n   -> 500\n"
            "2. Which region?\n   -> (not answered -- decide this one yourself)",
        ),
    ]
    block = b.build_ledger_block(turns)
    assert "500" in block
    assert "Which region?" in block
    assert "skipped" in block.lower()


# ── blocking unknowns gate finalisation ─────────────────────────────────────

BLOCKING_ROUND = """PLAN SO FAR
Do the thing.

QUESTIONS
Q: What is your time horizon?
HEADER: Horizon
KIND: open
BLOCKING: yes

Q: Which colour?
HEADER: Colour
KIND: choice
BLOCKING: no
OPTION: Blue -- calmer
OPTION: Red -- louder

AGREEMENT
| Claim | Agreed | Dissented | Silent | Call |
| Use SQLite | Melchior | Balthasar | Casper | keep |

CORRECTIONS
- Balthasar — claimed: SQLite has no WAL — actually: WAL exists since 3.7.

READY
YES everything looks settled"""


def test_ready_is_overridden_while_a_blocking_question_is_open():
    """The chairman said YES; a blocking question was open. Code wins."""
    parsed = b.parse_round(BLOCKING_ROUND)
    assert parsed["blocking"] == ["What is your time horizon?"]
    assert parsed["ready"] is False
    assert "shape of the plan" in parsed["ready_note"]


def test_blocking_flag_is_parsed_per_question():
    parsed = b.parse_round(BLOCKING_ROUND)
    assert parsed["questions"][0]["blocking"] is True
    assert parsed["questions"][1]["blocking"] is False


def test_agreement_and_corrections_are_parsed():
    parsed = b.parse_round(BLOCKING_ROUND)
    assert "| Claim |" in parsed["agreement"]
    assert parsed["corrections"][0]["who"] == "Balthasar"
    assert "WAL" in parsed["corrections"][0]["correction"]


def test_unanswered_blocking_makes_the_document_provisional():
    turns = [chairman_turn(1, b.parse_round(BLOCKING_ROUND))]
    prompt = b.build_finalize_prompt("build a thing", turns, [])
    assert "THIS DOCUMENT IS PROVISIONAL" in prompt
    assert "time horizon" in prompt


def test_answering_the_blocker_clears_provisional():
    turns = [
        chairman_turn(1, b.parse_round(BLOCKING_ROUND)),
        user_turn(2, "ANSWERS FROM THE PERSON\n1. What is your time horizon?\n   -> 10 years"),
    ]
    assert b.unanswered_blocking(turns) == []
    prompt = b.build_finalize_prompt("build a thing", turns, [])
    assert "THIS DOCUMENT IS PROVISIONAL" not in prompt


def test_a_withdrawn_blocking_question_does_not_block_forever():
    """Only the newest round's blocking questions count: one the council
    stopped asking was resolved, not ignored."""
    turns = [
        chairman_turn(1, b.parse_round(BLOCKING_ROUND)),
        chairman_turn(2, {"plan_so_far": "d", "questions": [{"q": "Colour?", "blocking": False}]}),
    ]
    assert b.unanswered_blocking(turns) == []


def test_legacy_round_without_blocking_still_parses():
    raw = "PLAN SO FAR\nd\n\nQUESTIONS\nQ: Budget?\nHEADER: Budget\nKIND: open\n\nREADY\nYES fine"
    parsed = b.parse_round(raw)
    assert parsed["ready"] is True
    assert parsed["questions"][0]["blocking"] is False


def test_legacy_council_split_feeds_the_agreement_field():
    raw = "PLAN SO FAR\nd\n\nCOUNCIL SPLIT\nThey disagreed on storage.\n\nREADY\nNO"
    parsed = b.parse_round(raw)
    assert parsed["agreement"] == "They disagreed on storage."


# ── task type decides the document shape ────────────────────────────────────

@pytest.mark.parametrize(
    "topic,expected",
    [
        ("add a retry to the upload endpoint", b.BUILD),
        ("refactor the auth module", b.BUILD),
        ("how should I allocate 50k across index funds", b.ADVICE),
        ("should I take the job offer", b.ADVICE),
        ("compare vector databases for RAG", b.RESEARCH),
        ("what are the options for CI on windows", b.RESEARCH),
    ],
)
def test_topic_classification(topic, expected):
    assert b.classify_topic(topic) == expected


def test_an_advice_session_never_gets_files_to_touch():
    """The template mismatch that made the system invent a build task."""
    prompt = b.build_finalize_prompt("how should I allocate my savings", [], [])
    assert "Files to Touch" not in prompt
    assert "Implementation Steps" not in prompt
    assert "What would change this" in prompt


def test_a_build_session_keeps_the_handoff_template():
    prompt = b.build_finalize_prompt("add a retry to the upload endpoint", [], [])
    assert "Files to Touch" in prompt
    assert "Implementation Steps" in prompt


def test_every_document_carries_the_plain_words_layer():
    for topic in ("add a retry endpoint", "should I invest", "compare databases"):
        prompt = b.build_finalize_prompt(topic, [], [])
        assert "## In plain words" in prompt
        assert "## Glossary" in prompt


def test_sensitive_topics_append_the_guardrail():
    assert "high-stakes" in b.build_member_prompt("plan my retirement drawdown", [], 1)
    assert "high-stakes" not in b.build_member_prompt("refactor the parser", [], 1)


# ── corrections are replayed to the member that made them ───────────────────

def test_a_member_is_shown_its_own_refuted_claim():
    turns = [
        chairman_turn(1, {
            "plan_so_far": "d",
            "corrections": [
                {"who": "claude", "claim": "SQLite has no WAL", "correction": "it has."}
            ],
        })
    ]
    block = b.corrections_block(turns, "claude")
    assert "SQLite has no WAL" in block
    # ...and not to anyone else, where it would just be noise.
    assert b.corrections_block(turns, "gemini") == ""


def test_member_prompt_carries_its_corrections():
    turns = [
        chairman_turn(1, {
            "plan_so_far": "d",
            "corrections": [
                {"who": "claude", "claim": "X is impossible", "correction": "X is routine."}
            ],
        })
    ]
    prompt = b.build_member_prompt("build a thing", turns, 2, provider_id="claude")
    assert "X is impossible" in prompt


# ── critique parsing ────────────────────────────────────────────────────────

CRITIQUE = """OBJECTIONS
- Balthasar: the polling loop re-reads the whole file each tick.

CORRECTIONS
- Balthasar — claimed: SQLite cannot do concurrent reads — actually: WAL allows them.

CONCEDE
Casper is right that my retry count was too low."""


def test_critique_sections_parse():
    parsed = b.parse_critique(CRITIQUE)
    assert parsed["parsed"] is True
    assert "polling loop" in parsed["objections"]
    assert parsed["corrections"][0]["who"] == "Balthasar"
    assert "WAL" in parsed["corrections"][0]["correction"]
    assert "retry count" in parsed["concede"]


def test_critique_none_values_are_empty_not_literal():
    parsed = b.parse_critique("OBJECTIONS\nx\n\nCORRECTIONS\nNone\n\nCONCEDE\nNothing")
    assert parsed["corrections"] == []
    assert parsed["corrections_text"] == ""
    assert parsed["concede"] == ""


def test_unparseable_critique_never_raises():
    assert b.parse_critique("total gibberish")["parsed"] is False
    assert b.parse_critique("")["parsed"] is False


def test_corrections_are_collected_with_their_accuser():
    critiques = [{
        "display_name": "Melchior",
        "parsed": b.parse_critique(CRITIQUE),
    }]
    collected = b.collect_corrections(critiques)
    assert collected[0]["raised_by"] == "Melchior"


# ── the review pass must not be allowed to shrink the document ──────────────

def test_a_review_that_drops_content_is_discarded():
    original = "x" * 1000
    text, accepted, reason = b.accept_review(original, "y" * 400)
    assert accepted is False
    assert text == original
    assert "dropped" in reason


def test_an_empty_review_is_discarded():
    text, accepted, _ = b.accept_review("x" * 500, "")
    assert accepted is False
    assert text == "x" * 500


def test_a_reasonable_review_is_accepted():
    text, accepted, _ = b.accept_review("x" * 1000, "y" * 950)
    assert accepted is True
    assert text == "y" * 950


# ── the transcript keeps its promise ────────────────────────────────────────

def test_appendix_records_critiques_and_corrections():
    turns = [
        {"round_no": 1, "attempt": 1, "role": "council", "provider_id": "chatgpt",
         "ok": 1, "content": "proposal", "phase": "round"},
        {"round_no": 1, "attempt": 1, "role": "critique", "provider_id": "gemini",
         "ok": 1, "content": "OBJECTIONS\n- chatgpt: too slow", "phase": "round"},
        chairman_turn(1, {
            "plan_so_far": "d",
            "agreement": "| Claim | Agreed |",
            "corrections_text": "- x — claimed: a — actually: b",
            "dropped_questions": ["Budget?"],
        }),
    ]
    out = b.build_transcript_appendix(turns)
    assert "too slow" in out
    assert "Factual errors caught" in out
    assert "dropped as already settled" in out
    assert "Budget?" in out
