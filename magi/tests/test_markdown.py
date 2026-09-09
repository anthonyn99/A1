"""DOM -> markdown recovery.

The chat UIs render the model's markdown into real elements. Reading them with
inner_text() throws the structure away, so the verdict arrives as a wall of
anonymous paragraphs. These tests pin the structure back down, running the real
serializer against a real DOM rather than asserting on a Python reimplementation
of it -- the whole point is that it behaves correctly in a browser.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.browser.markdown import DOM_TO_MARKDOWN_JS  # noqa: E402


@pytest.fixture(scope="module")
def page():
    pw = pytest.importorskip("playwright.sync_api")
    with pw.sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as exc:  # no browser binary installed
            pytest.skip(f"chromium unavailable: {exc}")
        pg = browser.new_page()
        yield pg
        browser.close()


def render(page, html: str) -> str:
    page.set_content(f"<div id='a'>{html}</div>")
    return page.eval_on_selector("#a", DOM_TO_MARKDOWN_JS).strip()


def test_headings_become_hashes(page):
    """A heading rendered as <h3> must not arrive as a bare line -- that is the
    exact bug that made every verdict render as flat prose."""
    assert render(page, "<h3>Define the target first</h3>") == "### Define the target first"
    # Level is normalised: the UIs pick inconsistently and the parser does not care.
    assert render(page, "<h1>Top</h1>") == "### Top"


def test_bullets_keep_their_markers(page):
    """One list is one block: bullets on consecutive lines, not split by blank
    lines into separate paragraphs."""
    out = render(page, "<ul><li>Index: SPY futures</li><li>Sector: ETF move</li></ul>")
    assert out == "- Index: SPY futures\n- Sector: ETF move"


def test_ordered_lists_are_numbered(page):
    out = render(page, "<ol><li>Load watchlist</li><li>Pull data</li></ol>")
    assert out == "1. Load watchlist\n2. Pull data"


def test_nested_list_is_indented_two_spaces(page):
    """Two spaces is one nesting step to the verdict parser."""
    out = render(page, "<ul><li>Outer<ul><li>Inner</li></ul></li></ul>")
    assert "- Outer" in out
    assert "  - Inner" in out


def test_emphasis_round_trips(page):
    out = render(page, "<p>Use <strong>ATR units</strong> and <em>not</em> <code>pct</code></p>")
    assert out == "Use **ATR units** and *not* `pct`"


def test_bold_label_bullet_survives(page):
    """`- **Label:** text` is the shape the frontend styles as a lead-in."""
    out = render(page, "<ul><li><strong>Sizing:</strong> flat fractional risk</li></ul>")
    assert out == "- **Sizing:** flat fractional risk"


def test_table_becomes_pipe_table(page):
    out = render(
        page,
        "<table><thead><tr><th>Option</th><th>Cost</th></tr></thead>"
        "<tbody><tr><td>A</td><td>Low</td></tr></tbody></table>",
    )
    assert out.splitlines() == [
        "| Option | Cost |",
        "| --- | --- |",
        "| A | Low |",
    ]


def test_paragraphs_are_blank_line_separated(page):
    out = render(page, "<p>First para.</p><p>Second para.</p>")
    assert out == "First para.\n\nSecond para."


def test_source_wrapping_is_collapsed(page):
    """Newlines and indentation in the HTML source are formatting, not content.
    Left in, the answer arrives pre-wrapped at the page source's width."""
    out = render(page, "<p>One sentence\n     continued here.</p>")
    assert out == "One sentence continued here."


def test_explicit_br_is_preserved(page):
    """Unlike source wrapping, a <br> is real intent."""
    out = render(page, "<p>Line one<br>Line two</p>")
    assert out == "Line one\nLine two"


def test_buttons_and_svg_are_dropped(page):
    """Copy affordances live inside the markdown container on several sites."""
    out = render(page, "<p>Answer.</p><button>Copy</button><svg><path/></svg>")
    assert out == "Answer."


def test_private_use_glyphs_are_dropped(page):
    """Claude's memory banner carries U+E027, which renders as tofu."""
    out = render(page, "<p>Recalled memories</p>")
    assert "" not in out


def test_nested_divs_do_not_merge_paragraphs(page):
    """Claude wraps blocks in divs; a naive walk glues them into one line."""
    out = render(page, "<div><div><p>One.</p></div><div><p>Two.</p></div></div>")
    assert out == "One.\n\nTwo."


def test_full_answer_shape(page):
    """End to end: the section keywords the parser buckets on must survive
    alongside the structure inside them."""
    out = render(
        page,
        "<p>ANSWER</p><p>Build it as a measurement system.</p>"
        "<h3>Define the target</h3><p>Pick one thing.</p>"
        "<ul><li>Gap %</li><li>ATR</li></ul>"
        "<p>NOTES</p><ul><li>Look-ahead bias is the risk.</li></ul>"
        "<p>CONFIDENCE</p><p>HIGH on the architecture.</p>",
    )
    lines = out.splitlines()
    assert "ANSWER" in lines
    assert "### Define the target" in lines
    assert "- Gap %" in lines
    assert "NOTES" in lines
    assert "CONFIDENCE" in lines
