"""Prompt-refiner response parsing.

The parser exists for one failure: the refiner ANSWERS the request instead of
rewriting it. That output goes straight into the composer and from there to
four models as the question, so a wrong accept is much worse than a wrong
reject -- these tests are weighted accordingly.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.engine.refine import REFINE_PROMPT, parse  # noqa: E402


def test_plain_rewrite_passes_through():
    text = (
        "Explain how Python's GIL affects multithreaded CPU-bound work, "
        "and say when multiprocessing is the better choice."
    )
    assert parse(text) == text


def test_strips_narrating_preamble():
    assert parse(
        "Here is the rewritten prompt:\nExplain how the GIL works."
    ) == "Explain how the GIL works."
    assert parse(
        "Rewritten request: Explain how the GIL works."
    ) == "Explain how the GIL works."
    assert parse(
        "Here's your refined prompt:\n\nExplain how the GIL works."
    ) == "Explain how the GIL works."


def test_strips_code_fence():
    assert parse("```\nExplain how the GIL works.\n```") == "Explain how the GIL works."
    assert parse("```text\nExplain how the GIL works.\n```") == "Explain how the GIL works."


def test_strips_wrapping_quotes():
    assert parse('"Explain how the GIL works."') == "Explain how the GIL works."
    assert parse("\u201cExplain how the GIL works.\u201d") == "Explain how the GIL works."


def test_inner_quotes_are_left_alone():
    """Only a fully-wrapping pair is stripped -- a rewrite that legitimately
    quotes a term must not lose its own punctuation."""
    text = 'Explain what "the GIL" means for CPU-bound threads.'
    assert parse(text) == text


def test_multi_paragraph_rewrite_is_kept():
    """The prompt allows one paragraph plus bullets, so structure alone is not
    grounds to reject."""
    text = (
        "Compare Postgres and MySQL for a write-heavy analytics workload.\n"
        "- Cover replication, indexing and operational cost.\n"
        "- Answer as a table, one row per database."
    )
    assert parse(text) == text


def test_empty_and_whitespace_rejected():
    assert parse("") is None
    assert parse("   \n  ") is None
    assert parse(None) is None


def test_preamble_with_no_rewrite_after_it_is_rejected():
    assert parse("Here is the rewritten prompt:") is None


def test_answer_instead_of_rewrite_is_rejected():
    """The load-bearing case: a model that answered rather than rewrote. Its
    output is characteristically far longer than any rewrite should be, and
    accepting it would send an ANSWER to the council as the question."""
    essay = (
        "The GIL is a mutex protecting access to Python objects, preventing "
        "multiple threads from executing Python bytecode at once. "
    ) * 40
    assert len(essay) > 4000
    assert parse(essay) is None


def test_refine_prompt_forbids_answering():
    """The prompt is the first of the two guards; if this instruction is ever
    dropped, the parser is carrying the whole job alone."""
    assert "Do not answer it" in REFINE_PROMPT
    assert "{question}" in REFINE_PROMPT
