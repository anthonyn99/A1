"""Answer-text cleaning.

Scraped chrome must be removed before it reaches the synthesis prompt --
otherwise an injected ad or citation pill gets quoted back as though a council
member said it.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.browser.extract import clean  # noqa: E402


def test_strips_gemini_citation_pill():
    """Observed live: Gemini appended 'AcqNotes\\n+ 2' after the answer."""
    raw = "The biggest cause is unclear requirements.\n\nAcqNotes\n+ 2"
    out = clean(raw, [r"\n\s*\+\s*\d+\s*$", r"\n\s*(Sources|AcqNotes)\s*$"])
    assert out == "The biggest cause is unclear requirements."


def test_strips_generic_trailing_ui_affordances():
    assert clean("Paris is the capital.\nCopy") == "Paris is the capital."
    assert clean("Paris is the capital.\nRetry") == "Paris is the capital."


def test_repeats_until_stable():
    """Removing one trailing element can expose another."""
    assert clean("Answer here.\nSources\n+ 3\nCopy") == "Answer here."


def test_never_touches_the_middle_of_an_answer():
    """A false positive mid-answer would silently corrupt the model's words."""
    raw = "First copy the file. Then retry the build. Sources matter here."
    assert clean(raw) == raw


def test_empty_and_whitespace():
    assert clean("") == ""
    assert clean("   \n  ") == ""


def test_strips_deepseek_code_block_toolbar():
    """Observed live: DeepSeek renders 'text\\nCopy\\nDownload' inside answers.

    This sits mid-answer, so the leading/trailing rules cannot reach it.
    """
    raw = "Use this:\n\ntext\nCopy\nDownload\nprint('hi')\n\nThat's it."
    assert clean(raw) == "Use this:\n\ntext\nprint('hi')\n\nThat's it."


def test_toolbar_strip_requires_the_whole_line():
    """'Copy the file' is prose; only a bare 'Copy' line is a button."""
    raw = "First, Copy the file.\nThen Download the archive and run it."
    assert clean(raw) == raw


def test_custom_patterns_are_applied():
    raw = "Real answer.\n\nTake a 5-Minute IQ Test"
    assert clean(raw, [r"\n\s*Take a 5-Minute IQ Test.*$"]) == "Real answer."
