"""Which Claude model a prompt gets, and why.

The failure mode worth guarding is not "picked the wrong one" -- reasonable
people would disagree on half of these -- it is picking on the wrong GROUNDS.
Two in particular, both of which the first cut of this got wrong:

  * discounting a question for being SHORT when it asks for something hard.
    "Why does this deadlock?" is eighty characters and squarely Opus work.
  * letting length outweigh the kind of work. Three thousand words asking for
    a spelling fix is still a spelling fix.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from magi.engine.modelpick import OPUS, SONNET, resolve, suggest  # noqa: E402


@pytest.mark.parametrize("q", [
    "Design a schema for recurring tasks and explain the trade-offs",
    "Why does this deadlock? The worker holds the profile lock while awaiting.",
    "Compare Firestore, KV and D1 on latency, cost and offline support",
    "Debug this traceback and tell me the root cause",
    "Write me a full report on this quarter's positioning",
])
def test_work_that_earns_the_bigger_model(q):
    assert suggest(q).model == OPUS, suggest(q).signals


@pytest.mark.parametrize("q", [
    "what is the capital of Denmark?",
    "summarize this in one line",
    "Fix the typo in this title",
    "rewrite this shorter",
    "translate this to French",
])
def test_work_that_does_not(q):
    assert suggest(q).model == SONNET, suggest(q).signals


def test_a_hard_question_is_not_discounted_for_being_short():
    short_and_hard = "Why does this deadlock?"
    assert len(short_and_hard) < 120
    p = suggest(short_and_hard)
    assert p.model == OPUS
    assert "one-line" not in " ".join(p.signals), (
        "shortness counted against a question that asks for reasoning"
    )


def test_length_alone_does_not_outweigh_the_kind_of_work():
    p = suggest("Fix the spelling. " + "context " * 500)
    assert p.model == SONNET, p.signals


def test_long_prompts_and_attachments_count():
    plain = suggest("Tell me about this")
    withfiles = suggest("Tell me about this", attachments=3)
    assert withfiles.score > plain.score
    assert withfiles.model == OPUS


def test_every_pick_explains_itself():
    """An automatic choice nobody can see the basis of is one nobody trusts."""
    p = suggest("Design a migration plan for the schema")
    assert p.reason
    assert p.signals, "no signals means the row has nothing to show on hover"


@pytest.mark.parametrize("choice", ["opus", "sonnet", "OPUS", " Sonnet "])
def test_an_explicit_choice_is_never_overridden(choice):
    p = resolve(choice, "what is 2 + 2")
    assert p.model == choice.strip().lower()
    assert p.reason == "you chose it"


@pytest.mark.parametrize("choice", [None, "", "auto", "nonsense"])
def test_anything_else_falls_back_to_the_heuristic(choice):
    """Including a value that is not a model: the composer would not know what
    to do with it, and a run must not stop over a typo in a queue row."""
    assert resolve(choice, "Design the schema and explain the trade-offs").model == OPUS
