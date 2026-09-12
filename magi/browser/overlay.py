"""Things that land on top of a composer.

WHAT THIS IS FOR
A cookie banner cost a real run. Perplexity served its consent dialog -- a
fixed card pinned bottom-right, over the right half of the composer -- and the
unit failed after 30 seconds with:

    Could not type: Locator.click: Timeout 30000ms exceeded.
      waiting for locator("div[contenteditable='true']#ask-input").first
      locator resolved to <div id="ask-input" role="textbox" ...>

Read that carefully: the selector **matched**. Playwright found the composer,
scrolled to it, and then waited for it to pass the actionability checks -- and
one of those is a hit test, "does a click at this point actually land on this
element?" It never did, because the dialog was in front of it. MAGI reported
SELECTOR_MISS, whose remedy is "run the doctor and rewrite selectors.yaml",
and there was nothing whatsoever wrong with the selector.

So this module exists to make anything in front of the composer a non-event,
for every unit, whether or not we have seen that particular dialog before:

  1. `dismiss()` clicks the consent/notice buttons we know about, from config.
  2. `focus_composer()` does not depend on that having worked. A click is only
     the first of three routes, and the second one -- `focus()` -- does no hit
     testing at all, so an overlay we have never seen cannot stop it either.
  3. `blocker()` names what was in the way, so the failure that does get
     reported sends you at the actual problem.

WHY FOCUS IS ENOUGH
Every route into these composers after this point is keyboard-driven:
`Input.insertText` over CDP for long prompts, `keyboard.type` for short ones,
`ControlOrMeta+a` + `Delete` to clear a draft. All three go to whatever holds
focus -- none of them needs a pointer. The click is only there to *place* the
caret, and `focus()` places it just as well while being unstoppable by
anything painted on top.

It is verified rather than assumed. A `focus()` that silently no-ops would send
the whole prompt to the page body instead of the composer, which is a worse
failure than the one being fixed -- so focus is read back out of
`document.activeElement`, and a route that cannot prove it worked is not used.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence

from playwright.async_api import Locator, Page

# How long one click attempt may block. The old behaviour inherited
# Playwright's 30s default, so a covered composer cost half a minute before
# anything else was even tried; nothing that is genuinely clickable needs more
# than a few seconds once the page is loaded and idle.
CLICK_TIMEOUT_MS = 6000


async def _focused(target: Locator) -> bool:
    """Is the caret actually in there?

    `contains` as well as identity: some composers focus an inner node (a
    ProseMirror/Lexical text node) rather than the element the selector names.
    """
    try:
        return bool(
            await target.evaluate(
                "el => el === document.activeElement"
                " || el.contains(document.activeElement)"
            )
        )
    except Exception:
        return False


async def dismiss(page: Page, candidates: Sequence[str]) -> list[str]:
    """Click away every dismissal control that is actually on screen.

    Returns what it clicked, for the log and for the doctor's note.

    Cheap by construction: each candidate is a zero-timeout existence check, so
    the usual case -- nothing showing -- costs a handful of milliseconds per
    selector and nothing else. That is what makes it affordable to run before
    every single prompt rather than only after something has gone wrong.

    Deliberately tolerant: a dialog that vanishes between the check and the
    click, or a button that re-renders under us, is success, not an error.
    Nothing here is allowed to fail a run -- the worst case is that the click
    routes below deal with the overlay instead.
    """
    clicked: list[str] = []
    for sel in candidates:
        try:
            loc = page.locator(sel).first
            if not await loc.count():
                continue
            if not await loc.is_visible():
                continue
            label = ""
            try:
                label = " ".join((await loc.inner_text() or "").split())[:40]
            except Exception:
                pass
            await loc.click(timeout=2000)
            clicked.append(label or sel)
            # Let the dialog finish animating out before the next check, or the
            # element it uncovers is still "unstable" to the click that follows.
            await asyncio.sleep(0.35)
        except Exception:
            continue
    return clicked


async def blocker(target: Locator) -> str:
    """What is covering `target`, described in a way a person can act on.

    Asks the page the same question the click asks: at the point the click
    would land, which element is actually on top? Returns "" when the answer is
    the target itself (or something inside it), which is the healthy case.
    """
    try:
        return str(
            await target.evaluate(
                """el => {
                    const r = el.getBoundingClientRect();
                    if (!r.width || !r.height) return 'the composer has no size on screen';
                    const top = document.elementFromPoint(
                        Math.round(r.left + r.width / 2),
                        Math.round(r.top + r.height / 2));
                    if (!top || top === el || el.contains(top) || top.contains(el)) return '';
                    const dialog = top.closest('[role=dialog],[aria-modal=true],dialog') || top;
                    const name = (dialog.getAttribute('aria-label')
                        || dialog.getAttribute('data-testid')
                        || (dialog.innerText || '').trim().split('\\n')[0]
                        || dialog.tagName.toLowerCase());
                    return String(name).slice(0, 80);
                }"""
            )
        )
    except Exception:
        return ""


async def focus_composer(
    page: Page,
    target: Locator,
    *,
    dismiss_selectors: Sequence[str] = (),
    timeout_ms: int = CLICK_TIMEOUT_MS,
) -> str:
    """Put the caret in the composer. Returns the route that worked.

    Three routes, weakest assumption last:

      click            the normal one, and the only one that proves the
                       composer is genuinely interactive.
      dismiss + click  something we recognise was in the way; it is gone now.
      focus            no hit testing, so nothing painted on top matters. Read
                       back from document.activeElement before it is believed.
      force click      skips the actionability checks outright. Last, because a
                       forced click on an element that is genuinely covered
                       dispatches the event to the thing in front of it.

    Raises the click's own error if every route fails, so the caller reports a
    real message rather than a bare "focus failed".
    """
    try:
        await target.click(timeout=timeout_ms)
        return "click"
    except Exception as first:
        cleared = await dismiss(page, dismiss_selectors)
        if cleared:
            try:
                await target.click(timeout=timeout_ms)
                return "click, after dismissing " + ", ".join(cleared)
            except Exception:
                pass
        try:
            await target.focus(timeout=timeout_ms)
        except Exception:
            pass
        if await _focused(target):
            return "focus" + (", after dismissing " + ", ".join(cleared) if cleared else "")
        try:
            await target.click(timeout=timeout_ms, force=True)
            return "forced click"
        except Exception:
            pass
        raise first


async def enter_composer(page: Page, target: Locator) -> None:
    """Ensure the caret is in the composer, doing nothing if it already is.

    The typing helpers call this instead of clicking outright. A run has
    normally focused the composer already (browser_base does it with the site's
    dismissal list in hand, so it can report a good failure); when it has, this
    costs one `document.activeElement` read and no interaction at all.
    """
    if await _focused(target):
        return
    await focus_composer(page, target)
