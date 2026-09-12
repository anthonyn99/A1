"""Every finished result can be taken away, in both flavours.

A result you cannot get out of the console is a result you have to retype. The
button is one shared control (`copyButton`) deliberately, so what is pinned
here is mostly that it is actually WIRED to each surface -- a refactor that
drops it from one of them breaks nothing, renders fine, and is invisible until
somebody goes looking for it on the round they wanted.

The two flavours matter as much as the button. The clipboard carries the
markdown for editors and other models, and styled HTML for documents; losing
either one silently halves what the button is for.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")


def _fn(name: str) -> str:
    """One top-level function body out of the page."""
    at = PAGE.index(f"function {name}(")
    depth, start = 0, PAGE.index("{", PAGE.index(")", at))
    for i in range(start, len(PAGE)):
        if PAGE[i] == "{":
            depth += 1
        elif PAGE[i] == "}":
            depth -= 1
            if depth == 0:
                return PAGE[at:i + 1]
    raise AssertionError(f"unbalanced: {name}")


def test_both_flavours_are_written():
    """Markdown for an editor, html for a document, from the one click."""
    body = _fn("putOnClipboard")
    assert "ClipboardItem" in body
    assert '"text/html"' in body and '"text/plain"' in body


def test_the_plain_flavour_is_the_markdown_not_the_rendered_text():
    """Pasting into another model should carry the ** and the # with it."""
    btn = _fn("copyButton")
    # md leads; the rendered text is only the fallback for a node with no
    # source markdown (a unit's answer, which is plain text to begin with).
    assert re.search(r"md \|\| \(node \? node\.innerText", btn), btn


def test_the_fallback_route_keeps_both_flavours_too():
    """execCommand copies a selection, whose plain text is the RENDERED prose.

    Without the copy listener the last-resort route silently downgrades the
    markdown to stripped text -- the one thing the button exists to preserve.
    """
    body = _fn("putOnClipboard")
    assert 'clipboardData.setData("text/plain", text)' in body
    assert 'clipboardData.setData("text/html", html)' in body


def test_colours_are_made_readable_on_paper():
    """A white-on-black console pasted into a white document is invisible."""
    body = _fn("forPaper")
    assert "if (l <= 0.5) return null" in body, "dark colours are already fine"
    assert "1 - l" in body, "lightness is inverted, hue and saturation kept"
    assert "Math.min(0.42" in body, "and floored short of black"


def test_the_style_walk_happens_before_anything_is_pruned():
    """The two trees are walked BY INDEX; pruning first shifts every sibling."""
    body = _fn("richHtml")
    assert body.index("inlineStyle(node, clone)") < body.index(".copybtn, button"), (
        "remove the controls AFTER the walk, or the styling lands on the wrong nodes"
    )


def test_only_typography_is_inlined():
    """Carrying a 2000px console's box model into Word is what breaks pastes."""
    body = _fn("inlineStyle")
    for prop in ("color", "font-weight", "font-style", "font-family", "white-space"):
        assert prop in body, prop
    for prop in ("padding", "margin", "display:", "width", "flex"):
        assert f'"{prop}' not in body, f"{prop} should not be inlined"


def test_the_button_does_not_fold_away_the_thing_it_copied():
    """Past rounds live inside <details>; a click there would close them."""
    btn = _fn("copyButton")
    assert "ev.preventDefault()" in btn and "ev.stopPropagation()" in btn


def test_the_payload_is_read_at_click_time():
    """These panels re-render constantly; a captured node goes stale."""
    btn = _fn("copyButton")
    assert "payload()" in btn, "the payload is a function, called on click"


def test_every_surface_that_produces_a_result_has_one():
    """The wiring. Each of these is a place the user asked to copy from."""
    surfaces = {
        "the verdict (live, and reopened from History)":
            re.compile(r"const body = verdictBody\(v\.verdict\);\s*\n\s*hd\.append\(copyButton"),
        "a single unit's answer":
            re.compile(r"copyButton\(\(\) => \(\{ md: p\.text \}\)"),
        "a finished brainstorm plan":
            re.compile(r"copyButton\(\(\) => \(\{ node: planBody, md: bs\.planMd"),
        "the plan as it stands mid-session":
            re.compile(r"copyButton\(\(\) => \(\{ node: planNow, md: latest\.plan_so_far"),
        "a round whose headings did not parse":
            re.compile(r"copyButton\(\(\) => \(\{ node: rawNow, md: latest\.raw_text"),
        "an earlier round in a session's history":
            re.compile(r"copyButton\(\(\) => \(\{ node: draft, md: r\.plan_so_far"),
        "a Studio report":
            re.compile(r"copyButton\(\(\) => \(\{ node: body, md: raw \}\)"),
    }
    for where, pattern in surfaces.items():
        assert pattern.search(PAGE), f"no copy button on: {where}"


def test_a_failed_synthesis_offers_nothing_to_copy():
    """An error message is not a result."""
    body = _fn("renderVerdict")
    ok_at = body.index("if (v.synthesis_ok)")
    assert body.count("copyButton") == 1
    assert body.index("copyButton") > ok_at, "the button belongs to the success branch"


def test_it_is_a_finger_sized_target_on_a_phone():
    block = PAGE[PAGE.index(".copybtn {"):PAGE.index(".copybtn {") + 2200]
    assert "min-height: 36px" in block, "36px under the mobile breakpoint"
    assert "touch-action: manipulation" in block, "no 300ms tap delay"


def test_a_streaming_unit_has_no_copy_button_yet():
    """Copying half an answer is a promise the button cannot keep."""
    body = _fn("updateNode")
    i = body.index("if (!working) {")
    assert "copyButton" in body[i:i + 260]
