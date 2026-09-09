"""Human-paced interaction.

The original sketch fired four simultaneous requests and typed with a fixed
15ms delay. Both are recognisable patterns. Everything here is sampled from a
range instead, so timing never looks metronomic.

This is about not looking like a bot to rate limiters. It is not an attempt to
defeat detection -- if a site presents a challenge, MAGI reports it plainly
rather than trying to slip past.
"""

from __future__ import annotations

import asyncio
import random

from playwright.async_api import Locator, Page

from ..settings import Pacing


async def pause(lo: float, hi: float) -> None:
    await asyncio.sleep(random.uniform(lo, hi))


async def _clear_composer(page: Page) -> None:
    """Wipe any leftover draft before entering a new prompt.

    These composers persist unsent text across navigations (ChatGPT restores it
    via data-composer-draft-react), so a previous run's abandoned prompt would
    otherwise be prepended to this one.
    """
    await page.keyboard.press("ControlOrMeta+a")
    await pause(0.05, 0.15)
    await page.keyboard.press("Delete")
    await pause(0.05, 0.15)


async def insert_text(page: Page, target: Locator, text: str, pacing: Pacing) -> None:
    """Put `text` into the composer, choosing the method by length.

    Character-by-character typing is what makes short prompts look human, but
    it costs ~36ms per character. The synthesis prompt carries every member's
    full answer -- 2,372 chars in a measured 4-member run -- so typing it took
    **86 seconds**, more than a third of the whole run, purely in keystrokes.

    Above `paste_threshold` we use CDP's Input.insertText instead, which lands
    the whole string in one operation while still firing the input events that
    React/ProseMirror/Quill need. There is no human-plausibility argument for
    typing a 2,000-character prompt at human speed anyway -- a person pasting
    that much text is exactly what this looks like.
    """
    if len(text) >= pacing.paste_threshold:
        await _paste_text(page, target, text)
    else:
        await type_text(page, target, text, pacing)


async def _paste_text(page: Page, target: Locator, text: str) -> None:
    """Insert text in one shot via CDP, then verify it landed."""
    await target.click()
    await pause(0.15, 0.35)
    await _clear_composer(page)

    session = await page.context.new_cdp_session(page)
    try:
        # insertText behaves like a paste: one input event, full string, and
        # the editor's own model is updated (unlike setting .value directly,
        # which leaves React unaware and the send button disabled).
        await session.send("Input.insertText", {"text": text})
    finally:
        await session.detach()
    await pause(0.2, 0.45)


async def type_text(page: Page, target: Locator, text: str, pacing: Pacing) -> None:
    """Type into a field at a varying, human-ish rate.

    Uses real keyboard events (never value assignment) because these editors are
    React/ProseMirror/Quill -- they listen for input events, and a directly-set
    value leaves their internal state empty, so the send button stays disabled.

    CRITICAL: newlines are typed as Shift+Enter, never as a raw "\\n".
    In these composers Enter SENDS. Typing a multi-line prompt literally
    submits the first line and abandons the rest -- which silently turned the
    multi-paragraph synthesis prompt into a one-line question and made the
    chairman answer something nobody asked. Verified live on chatgpt.com:
    typing "a\\nb\\nc" sent "a" and left "bc" in the box.
    """
    await target.click()
    await pause(0.15, 0.4)
    await _clear_composer(page)

    # Split on newlines and re-insert them as Shift+Enter.
    for i, line in enumerate(text.split("\n")):
        if i > 0:
            await page.keyboard.press("Shift+Enter")
            await pause(0.03, 0.1)
        # Type each line in short bursts with a beat between them, the way a
        # person does, rather than one uniform stream of keystrokes.
        for chunk in _chunks(line):
            await page.keyboard.type(chunk, delay=pacing.sample_typing_delay())
            if random.random() < 0.25:
                await pause(0.12, 0.45)


def _chunks(text: str, lo: int = 18, hi: int = 60):
    i = 0
    while i < len(text):
        n = random.randint(lo, hi)
        yield text[i : i + n]
        i += n


async def send(page: Page, submit: Locator | None, send_key: str, pacing: Pacing) -> None:
    """Submit the prompt, preferring a real click on the send button.

    Enter is the fallback: on several of these sites Enter inserts a newline
    when a composer plugin is active, so a visible send button is more reliable
    when one is present.
    """
    await asyncio.sleep(pacing.sample_pre_send())
    if submit is not None:
        try:
            await submit.click(timeout=5000)
            return
        except Exception:
            pass  # fall through to the key press
    await page.keyboard.press(send_key)
