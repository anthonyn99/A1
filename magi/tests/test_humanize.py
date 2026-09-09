"""Typing behaviour.

Guards the single most damaging bug found while building this: in these chat
composers Enter SENDS, so typing a multi-line prompt literally submits the
first line and abandons the rest. The multi-paragraph synthesis prompt was
being chopped into fragments, and the chairman answered a question nobody had
asked -- while the output still looked like a plausible verdict.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.browser import humanize  # noqa: E402
from magi.settings import Pacing  # noqa: E402


class FakeKeyboard:
    def __init__(self):
        self.typed: list[str] = []
        self.pressed: list[str] = []

    async def type(self, text: str, delay: int = 0) -> None:
        self.typed.append(text)

    async def press(self, key: str) -> None:
        self.pressed.append(key)


class FakePage:
    def __init__(self):
        self.keyboard = FakeKeyboard()


class FakeTarget:
    async def click(self) -> None:
        return None


@pytest.mark.asyncio
async def test_newlines_are_shift_enter_never_bare_enter():
    """A raw Enter would submit mid-prompt."""
    page, pacing = FakePage(), Pacing(typing_delay_ms=(0, 0))
    await humanize.type_text(page, FakeTarget(), "alpha\nbeta\ngamma", pacing)

    assert page.keyboard.pressed.count("Shift+Enter") == 2
    assert "Enter" not in page.keyboard.pressed
    assert "\n" not in "".join(page.keyboard.typed)


@pytest.mark.asyncio
async def test_full_text_is_typed_in_order():
    page, pacing = FakePage(), Pacing(typing_delay_ms=(0, 0))
    text = "First line here.\n\nSecond paragraph follows.\nThird."
    await humanize.type_text(page, FakeTarget(), text, pacing)
    assert "".join(page.keyboard.typed) == text.replace("\n", "")


@pytest.mark.asyncio
async def test_composer_draft_is_cleared_before_typing():
    """These composers restore unsent drafts, which would prepend stale text."""
    page, pacing = FakePage(), Pacing(typing_delay_ms=(0, 0))
    await humanize.type_text(page, FakeTarget(), "hello", pacing)
    assert page.keyboard.pressed[0] == "ControlOrMeta+a"
    assert page.keyboard.pressed[1] == "Delete"


@pytest.mark.asyncio
async def test_blank_lines_are_preserved():
    """Paragraph breaks matter -- the synthesis prompt relies on them."""
    page, pacing = FakePage(), Pacing(typing_delay_ms=(0, 0))
    await humanize.type_text(page, FakeTarget(), "a\n\nb", pacing)
    assert page.keyboard.pressed.count("Shift+Enter") == 2
