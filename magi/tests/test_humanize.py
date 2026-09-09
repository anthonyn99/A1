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


@pytest.mark.asyncio
async def test_crlf_never_reaches_the_keyboard():
    r"""A textarea gives CRLF, and Playwright types "\r" as the ENTER KEY.

    This is the SAME bug as the "\n" case above, by a route that fix did not
    cover. magi.html's composer is an HTML <textarea>, whose value normalises
    to CRLF, so a three-line question arrived as
    "...single-user\r\nweb app...\r\nsupport..." -- type_text split on "\n",
    leaving a "\r" at the end of each line, and typing it SUBMITTED the
    fragment before Shift+Enter ever ran.

    Caught on the first real council run: Claude answered "it looks like your
    question got cut off" and Gemini returned "Searching the web" -- both were
    scored as resolved, and the verdict reported HIGH confidence over four
    members when only two had actually seen the question.
    """
    page, pacing = FakePage(), Pacing(typing_delay_ms=(0, 0))
    await humanize.type_text(page, FakeTarget(), "alpha\r\nbeta\rgamma", pacing)

    typed = "".join(page.keyboard.typed)
    assert "\r" not in typed, "a bare CR is an Enter press -- it submits the prompt"
    assert "\n" not in typed
    assert typed == "alphabetagamma"
    assert page.keyboard.pressed.count("Shift+Enter") == 2
    assert "Enter" not in page.keyboard.pressed


def test_normalise_newlines_handles_every_line_ending():
    assert humanize.normalise_newlines("a\r\nb") == "a\nb"
    assert humanize.normalise_newlines("a\rb") == "a\nb"
    assert humanize.normalise_newlines("a\nb") == "a\nb"
    # Blank lines survive: the synthesis prompt's paragraph breaks depend on it.
    assert humanize.normalise_newlines("a\r\n\r\nb") == "a\n\nb"


class FakeSubmit:
    """A send button. `inert` clicks cleanly but does not actually send."""

    def __init__(self, inert: bool = False, raises: bool = False):
        self.inert, self.raises, self.clicks = inert, raises, 0

    async def click(self, timeout: int = 0) -> None:
        self.clicks += 1
        if self.raises:
            raise RuntimeError("not clickable")


class FakeComposer:
    """Empties when the send registers, the way these UIs acknowledge one."""

    def __init__(self, submit: FakeSubmit, text: str = "the prompt"):
        self.submit, self.text = submit, text

    async def inner_text(self) -> str:
        sent = self.submit.clicks > 0 and not self.submit.inert
        return "" if sent else self.text


@pytest.mark.asyncio
async def test_a_working_send_button_is_not_double_sent():
    page, pacing = FakePage(), Pacing(pre_send_pause_s=(0, 0))
    submit = FakeSubmit()
    await humanize.send(page, submit, "Enter", pacing, composer=FakeComposer(submit))
    assert submit.clicks == 1
    assert "Enter" not in page.keyboard.pressed, "the click worked; Enter would send twice"


@pytest.mark.asyncio
async def test_an_inert_send_button_falls_back_to_enter():
    """A click can succeed and still not send.

    Playwright resolves a click as soon as the event is dispatched, so a button
    whose handler is not wired yet reports success while the prompt stays in the
    box. Gemini timed out this way -- "0 turns, text unchanged" after 45s -- and
    it only surfaced once a CRLF prompt stopped pressing Enter by accident.
    """
    page, pacing = FakePage(), Pacing(pre_send_pause_s=(0, 0))
    submit = FakeSubmit(inert=True)
    await humanize.send(page, submit, "Enter", pacing, composer=FakeComposer(submit))
    assert submit.clicks == 1
    assert page.keyboard.pressed == ["Enter"], "an unsent prompt must fall back to Enter"


@pytest.mark.asyncio
async def test_a_click_that_raises_still_falls_back_to_enter():
    page, pacing = FakePage(), Pacing(pre_send_pause_s=(0, 0))
    submit = FakeSubmit(raises=True)
    await humanize.send(page, submit, "Enter", pacing, composer=FakeComposer(submit))
    assert page.keyboard.pressed == ["Enter"]


@pytest.mark.asyncio
async def test_no_send_button_presses_enter():
    page, pacing = FakePage(), Pacing(pre_send_pause_s=(0, 0))
    await humanize.send(page, None, "Enter", pacing, composer=None)
    assert page.keyboard.pressed == ["Enter"]
