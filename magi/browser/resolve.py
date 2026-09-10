"""Selector resolution with fallbacks.

Every selector in config is a list. This module tries them in order and reports
which one won, so `magi doctor` can tell the user exactly which alternative is
currently carrying a site and which have gone stale.

Nothing here guesses or repairs selectors on its own -- a miss is reported as a
miss. Silently substituting a "close enough" element is how you end up scraping
the wrong text and presenting it as a model's answer.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from playwright.async_api import Locator, Page


@dataclass
class Resolved:
    """Which selector matched, and the locator for it."""

    selector: str
    locator: Locator
    count: int
    index: int  # position in the candidate list; 0 means the preferred one won


# Fields that CANNOT match on an idle chat, and whose absence therefore proves
# nothing. There is no answer on screen to match `assistant_turn`, and nothing
# is generating, so `stop_button` and `streaming_marker` have nothing to find.
#
# Reporting these as MISS is what made a healthy install look broken: a Doctor
# table showing 3 of 4 units failing on 4 fields each sent a bug report chasing
# a selector rewrite, when the selectors were correct and verified live.
IDLE_INVISIBLE_FIELDS = frozenset({
    "assistant_turn",
    "stop_button",
    "streaming_marker",
})

# Fields whose element is only created once the composer has text. Verified
# live 2026-08-13: on both claude.ai and gemini.google.com the send button does
# not exist on an empty composer and appears on the first keystroke
# (count 0 -> 1). Probing an idle page therefore says nothing about whether the
# selector is right.
TYPING_GATED_FIELDS = frozenset({"submit"})

# Sentinel fields whose ABSENCE is the healthy outcome: no login control means
# the session is live, no challenge control means we are not blocked. A miss
# here is good news and must never be reported as a fault.
ABSENCE_IS_HEALTHY_FIELDS = frozenset({"login_selectors", "challenge_selectors"})


class ProbeStatus(StrEnum):
    OK = "ok"                  # matched on the page
    MISS = "miss"              # did not match, and should have -- a real fault
    NOT_APPLICABLE = "n/a"     # cannot match in this page state; proves nothing
    UNSET = "unset"            # no candidates configured; deliberate


@dataclass
class Probe:
    """Diagnostic result for one selector field (used by `magi doctor`)."""

    field: str
    matched: str | None
    count: int
    tried: list[str]
    # Set when the probe created the conditions under which this field SHOULD
    # have matched (typed into the composer) and it still did not. That turns
    # an inconclusive result into a genuine fault.
    verified_absent: bool = False

    @property
    def ok(self) -> bool:
        return self.matched is not None

    @property
    def status(self) -> ProbeStatus:
        """How this result should be READ, not merely whether it matched.

        A miss only means something when the element could have been there. The
        three other cases are normal and must not be shown as faults.
        """
        if self.matched is not None:
            return ProbeStatus.OK
        if not self.tried:
            # An empty list is a deliberate choice, not a failure: DeepSeek has
            # no stable send button and is driven by the Enter key instead.
            return ProbeStatus.UNSET
        if self.field in ABSENCE_IS_HEALTHY_FIELDS:
            return ProbeStatus.NOT_APPLICABLE
        if self.verified_absent:
            return ProbeStatus.MISS
        if self.field in IDLE_INVISIBLE_FIELDS or self.field in TYPING_GATED_FIELDS:
            return ProbeStatus.NOT_APPLICABLE
        return ProbeStatus.MISS

    @property
    def note(self) -> str:
        """Why a non-OK result is not a fault, for the Doctor table."""
        if self.status is ProbeStatus.UNSET:
            return "not configured — this site is driven by the Enter key"
        if self.status is ProbeStatus.NOT_APPLICABLE:
            if self.field in ABSENCE_IS_HEALTHY_FIELDS:
                return "absent, which is the healthy case"
            if self.field in TYPING_GATED_FIELDS:
                return "appears only once the composer has text"
            return "nothing to match while the chat is idle"
        return ""


async def resolve(
    page: Page,
    candidates: list[str],
    *,
    timeout_ms: int = 0,
    require_visible: bool = True,
) -> Resolved | None:
    """Return the first candidate selector that matches, or None.

    timeout_ms applies to the FIRST candidate only -- that's the one we expect
    to work, so it's worth waiting for. Later candidates are checked instantly,
    since if we're falling back at all we're already in degraded territory and
    shouldn't pay the full timeout per alternative.
    """
    for i, sel in enumerate(candidates):
        loc = page.locator(sel)
        try:
            if i == 0 and timeout_ms > 0:
                await loc.first.wait_for(
                    state="visible" if require_visible else "attached",
                    timeout=timeout_ms,
                )
            count = await loc.count()
            if count == 0:
                continue
            if require_visible and not await loc.first.is_visible():
                continue
            return Resolved(selector=sel, locator=loc, count=count, index=i)
        except Exception:
            continue
    return None


async def present(page: Page, candidates: list[str]) -> bool:
    """True if any candidate matches a visible element. Used for sentinels."""
    if not candidates:
        return False
    return await resolve(page, candidates, timeout_ms=0) is not None


async def rate_limited(page: Page, candidates: list[str]) -> str:
    """The site's own "you have used your quota" notice, or "".

    A DIFFERENT failure from a timeout, and the distinction is the whole point
    of the taxonomy. Verified on claude.ai: hitting the 5-hour limit leaves the
    composer present and the send apparently accepted, but no answer ever
    streams -- so completion detection reported "No new answer appeared within
    45s ... the send may not have registered, or the assistant_turn selector is
    wrong", and the remedy it suggested was editing selectors.yaml. The real
    remedy was to wait until 5pm.

    Returns the notice TEXT, not just a boolean, because it usually carries the
    reset time and that is the one thing the user actually needs.
    """
    for sel in candidates:
        try:
            loc = page.locator(sel).first
            if await loc.count() and await loc.is_visible():
                txt = (await loc.inner_text() or "").strip()
                return " ".join(txt.split())[:200] or "usage limit reached"
        except Exception:
            continue
    return ""


async def signed_out(page: Page, login_candidates: list[str]) -> bool:
    """True if a "you are not signed in" control is in the DOM.

    Deliberately does NOT require visibility, which is what `present` does and
    why it was the wrong tool here. Measured on a logged-OUT Gemini: the
    ServiceLogin anchor is attached (count=1) but `is_visible()` returns False,
    so a visibility test called it signed in. Attachment separates the four
    cleanly -- signed-out Gemini attached=1, and signed-in ChatGPT, Claude and
    DeepSeek attached=0 -- while visibility was False for all four and
    therefore carried no information at all.

    The risk of the looser test is a logged-IN page keeping a hidden login link
    somewhere; the measurement above is what rules that out for these four, and
    a site that starts doing it shows up as a permanent NOT_LOGGED_IN rather
    than as a silent wrong answer.
    """
    if not login_candidates:
        return False
    return await resolve(
        page, login_candidates, timeout_ms=0, require_visible=False
    ) is not None


# Interstitial page titles that mean "you are not looking at the real site".
# Verified: headless Chrome on chatgpt.com sits on a Cloudflare page titled
# "Just a moment..." indefinitely, and the challenge markup lives inside a
# cross-origin iframe that CSS selectors on the top document never see. The
# title is the reliable tell.
CHALLENGE_TITLES = (
    "just a moment",
    "attention required",
    "security check",
    "verifying you are human",
    "checking your browser",
)


async def is_challenge_page(page: Page, candidates: list[str] | None = None) -> bool:
    """True if the page looks like a bot-check interstitial.

    Checks the document title first (catches cross-origin challenge frames that
    selectors miss), then any configured challenge selectors.
    """
    try:
        title = (await page.title() or "").strip().lower()
        if any(t in title for t in CHALLENGE_TITLES):
            return True
    except Exception:
        pass
    return await present(page, candidates or [])


async def prime_composer(page: Page, input_candidates: list[str]) -> bool:
    """Type a character into the composer so typing-gated controls appear.

    The send button on claude.ai and gemini.google.com does not exist until the
    composer has text (verified live: count goes 0 -> 1 on the first keystroke).
    Probing an idle page therefore reports a perfectly good `submit` selector as
    MISS, which is exactly the false alarm this avoids.

    Types only -- never sends. The text is cleared afterwards so the probe
    leaves the page as it found it. Returns whether priming succeeded.
    """
    box = await resolve(page, input_candidates, timeout_ms=2000)
    if box is None:
        return False
    try:
        await box.locator.first.click(timeout=3000)
        # A single character is enough to flip the button into existence, and
        # keeps the composer trivially clearable afterwards.
        await page.keyboard.type(".")
        # The button is rendered by a framework re-render, not synchronously.
        await page.wait_for_timeout(600)
        return True
    except Exception:
        return False


async def clear_composer(page: Page, input_candidates: list[str]) -> None:
    """Undo `prime_composer`, so a health check leaves no draft behind.

    Matters more than it looks: these UIs restore unsent drafts, so a stray
    character left here gets prepended to the next real question.
    """
    box = await resolve(page, input_candidates, timeout_ms=0)
    if box is None:
        return
    try:
        await box.locator.first.click(timeout=3000)
        await page.keyboard.press("ControlOrMeta+a")
        await page.keyboard.press("Delete")
    except Exception:
        pass


async def probe_all(
    page: Page,
    fields: dict[str, list[str]],
    *,
    prime: bool = False,
) -> list[Probe]:
    """Check every selector field on the current page. Powers `magi doctor`.

    With `prime`, the composer is given a character first so that typing-gated
    controls (the send button) are actually present to be probed. Without it,
    those fields can only be reported as "not applicable".
    """
    primed = False
    if prime:
        primed = await prime_composer(page, fields.get("input") or [])

    try:
        out: list[Probe] = []
        for name, cands in fields.items():
            if not cands:
                out.append(Probe(field=name, matched=None, count=0, tried=[]))
                continue
            r = await resolve(page, cands, timeout_ms=0, require_visible=False)
            probe = Probe(
                field=name,
                matched=r.selector if r else None,
                count=r.count if r else 0,
                tried=cands,
            )
            # A primed run genuinely tested the send button, so a miss here is
            # a real fault rather than an artefact of the page being idle.
            if primed and name in TYPING_GATED_FIELDS and probe.matched is None:
                probe.verified_absent = True
            out.append(probe)
        return out
    finally:
        if primed:
            await clear_composer(page, fields.get("input") or [])
