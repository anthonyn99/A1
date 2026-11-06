"""Every screen's renderer is live code, not commented-out text.

Written after breaking Accounts. Removing the Claude usage card left the tail
of a deleted arrow function behind -- half a template literal and an
unterminated `/*` -- and that comment swallowed 202 lines, `renderAccounts`
and `checkAccount` among them. Accounts rendered as a blank panel with no
error anywhere.

Nothing caught it, and it is worth being precise about why, because it decides
what this test can be. `node --check` passes: commented-out code is
syntactically fine. The other tests pass: they grep the raw file, where the
functions are still there as text. The browser was the only thing that knew,
and it said `typeof renderAccounts === "undefined"` while the declaration sat
in plain sight in the source.

A full tokenizer is not the answer here -- JavaScript's regex-versus-division
ambiguity makes a hand-rolled one wrong on a 360KB file in ways that produce
false alarms, which is worse than no test. This does something narrower and
reliable: for each named renderer, walk back to the nearest `/*` and check
that it closes before the declaration begins.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")

#: One per screen, plus the two that went down with Accounts. A blank panel is
#: the symptom every one of these would produce.
RENDERERS = (
    "renderAccounts", "renderDoctor", "renderHistory", "renderQueue",
    "renderBsView", "renderVerdict", "renderGrid", "renderStudioNav",
    "renderStudioView", "renderUnitChips", "renderChips", "renderRunNow",
    "checkAccount", "startLogin", "loadAccounts", "queueEdit", "setView",
)


def _decl(name: str) -> int:
    m = re.search(rf"^(?:async )?function {name}\(", PAGE, re.M)
    assert m, f"{name} is not declared in magi.html at all"
    return m.start()


def test_no_renderer_is_inside_a_comment():
    swallowed = []
    for name in RENDERERS:
        at = _decl(name)
        opened = PAGE.rfind("/*", 0, at)
        if opened == -1:
            continue
        closed = PAGE.find("*/", opened)
        if closed == -1 or closed > at:
            swallowed.append(name)
    assert not swallowed, (
        "these are written in magi.html but sit inside an unterminated block "
        f"comment, so the browser never defines them: {swallowed}"
    )


def test_every_renderer_is_declared_at_the_top_level():
    """In strict mode a function declared inside a block is block-scoped, so
    it exists in the file and nowhere the rest of the program can reach."""
    for name in RENDERERS:
        at = _decl(name)
        line_start = PAGE.rfind("\n", 0, at) + 1
        assert PAGE[line_start:at] == "", (
            f"{name} is indented, which means it is nested inside something"
        )
