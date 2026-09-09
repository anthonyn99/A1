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


def normalise_newlines(text: str) -> str:
    r"""Collapse CRLF and lone CR to LF before anything is typed.

    Playwright types "\r" as the ENTER KEY, and in these composers Enter SENDS.
    An HTML <textarea> normalises its value to CRLF, so every question typed
    into magi.html arrives here with a "\r" ending each line -- and type_text,
    which correctly turns "\n" into Shift+Enter, was pressing Enter on the
    stray "\r" immediately before it. The prompt reached the model in
    FRAGMENTS: one submitted message per line.

    Observed on the first real run. Claude replied "it looks like your question
    got cut off" and reasoned from "what we've established" -- it had received
    several separate messages -- while Gemini returned the string "Searching
    the web", a loading state captured after an early submit. Both were still
    recorded as resolved, and the verdict claimed HIGH confidence over "three
    of four members" that nothing in the transcript supported.

    This is the same defect test_humanize.py already guards ("in these chat
    composers Enter SENDS"); the "\n" route was fixed and the "\r" route was
    not. Normalising here rather than at the API boundary covers every caller:
    council questions, the synthesis prompt, brainstorm rounds and studio jobs
    all reach a composer through this module.
    """
    return text.replace("\r\n", "\n").replace("\r", "\n")


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
    # Before the length test, so a CRLF prompt cannot change branch on the two
    # extra bytes per line either.
    text = normalise_newlines(text)
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

    # Normalised again here, not only in insert_text: this is public and called
    # directly, and a single stray "\r" reaching page.keyboard.type() IS an
    # Enter press, which submits the half-written prompt.
    text = normalise_newlines(text)

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


async def _composer_emptied(composer: Locator, timeout_s: float = 2.5) -> bool:
    """True if the composer cleared, which is how these UIs acknowledge a send.

    Site-agnostic on purpose: ChatGPT, Claude, Gemini and DeepSeek all empty the
    box on submit, and none of them exposes a "sent" event we could read.
    """
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        try:
            if not (await composer.inner_text()).strip():
                return True
        except Exception:
            # The composer can be re-rendered out from under us on submit,
            # which is itself a sign the send landed.
            return True
        await asyncio.sleep(0.2)
    return False


async def send(
    page: Page,
    submit: Locator | None,
    send_key: str,
    pacing: Pacing,
    composer: Locator | None = None,
) -> None:
    """Submit the prompt, preferring a real click on the send button.

    Enter is the fallback: on several of these sites Enter inserts a newline
    when a composer plugin is active, so a visible send button is more reliable
    when one is present.

    A click that raises is not the only way sending fails. Playwright's click
    resolves as soon as the event is dispatched, so a button that is present but
    inert -- Angular has not wired its handler yet, an overlay swallowed the
    event, the framework re-rendered mid-click -- reports SUCCESS while the
    prompt just sits in the box. The old code returned there and never tried
    Enter, so the run waited out its 45s stall timeout and failed with "0 turns,
    text unchanged".

    That went unnoticed for as long as it did because a CRLF prompt was pressing
    Enter on its own (see normalise_newlines): fixing that removed the accidental
    send this path had been leaning on, and Gemini started timing out. So the
    click is now CONFIRMED against the composer emptying, and Enter still runs
    when it did not.
    """
    await asyncio.sleep(pacing.sample_pre_send())
    if submit is not None:
        try:
            await submit.click(timeout=5000)
            if composer is None or await _composer_emptied(composer):
                return
            # Click landed but the prompt is still sitting there -- fall through.
        except Exception:
            pass  # fall through to the key press
    await page.keyboard.press(send_key)
