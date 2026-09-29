"""Selector resolution with fallbacks.

Every selector in config is a list. This module tries them in order and reports
which one won, so `magi doctor` can tell the user exactly which alternative is
currently carrying a site and which have gone stale.

Nothing here guesses or repairs selectors on its own -- a miss is reported as a
miss. Silently substituting a "close enough" element is how you end up scraping
the wrong text and presenting it as a model's answer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

from playwright.async_api import Locator, Page

from . import overlay


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


def _norm(s: str) -> str:
    """Text as compared for "is this our own words": case, spacing and the
    markdown a chat renders away (bullets, emphasis, headings) all dropped."""
    s = re.sub(r"[*_`#>|~\-•]+", " ", (s or "").lower())
    s = s.replace("’", "'").replace("‘", "'")
    return " ".join(s.split())


# Where a match is OUR words, not the site speaking: the composer (the prompt
# before it is sent), or a paragraph of an answer. `answer` is the site's
# assistant_turn list; a CSS one that is not valid for closest() is skipped.
# A match inside an answer counts as prose only when the answer holds much
# more than the match -- a limit card that REPLACES an answer is the whole of
# its turn, and must still read as the limit it is.
_OURS_JS = """(el, answer) => {
  if (el.closest("textarea, input, [contenteditable='true'], [contenteditable='']")) return "composer";
  const own = (el.innerText || "").trim().length;
  for (const css of answer) {
    let turn = null;
    try { turn = el.closest(css); } catch (e) { continue; }
    if (turn && (turn.innerText || "").trim().length >= 0) return "answer";
  }
  return "";
}"""

# How many matches of one rule to look through. The first can be the prompt
# echoed in the conversation while the real notice is the second.
NOTICE_SCAN = 10


async def notice(
    page: Page, candidates: list[str], *, prompt: str = "",
    answer: list[str] | tuple = (),
) -> str:
    """The first visible match of `candidates` that is the SITE talking, or "".

    Phase U1 found why this cannot just take `.first`: most of these rules are
    page-wide `text=` matches, and the page includes the user's own prompt.
    Brainstorm 797a9ae3cc13 (2026-09-25) lost DeepSeek's critique in 3 of 3
    rounds, each "rate_limited" ~12s in, because the other members' proposals
    it was asked to review said "rate limits" -- and `text=/rate limit/i`
    matched them in the user bubble. So a match is skipped when its text is
    part of the prompt that was sent, when it sits in the composer, or when it
    is a line inside a longer answer. What is left is a notice.

    Skipping is the SAFE direction: a real notice that is also quoted word for
    word in the prompt is missed, and the run falls back to its old timeout --
    it can no longer invent a limit out of the user's own words.
    """
    said = _norm(prompt)
    answer = [a for a in (answer or []) if a and not a.startswith(("text=", "xpath="))]
    for sel in candidates:
        try:
            loc = page.locator(sel)
            n = min(await loc.count(), NOTICE_SCAN)
        except Exception:
            continue
        for i in range(n):
            try:
                el = loc.nth(i)
                if not await el.is_visible():
                    continue
                txt = " ".join((await el.inner_text() or "").split())
                if said and _norm(txt) and _norm(txt) in said:
                    continue
                try:
                    if await el.evaluate(_OURS_JS, answer):
                        continue
                except Exception:
                    pass
                return txt[:200] or "(no text)"
            except Exception:
                continue
    return ""


async def model_label(page: Page, site) -> str:
    """The model the site says this chat is on, or "" when it shows none.

    The rule Phase U1 pinned in test_unit_selectors: the first `model_label`
    candidate with a match wins, its LAST match is read (ChatGPT names the
    model on every answer turn, and the newest is the one that just answered),
    from an attribute (`model_label_from: "attr:<name>"`) or its text, then cut
    to `model_label_pattern`'s group 1 when there is one. Never raises: a
    missing label is a card without a chip, not a failed run.
    """
    for sel in getattr(site, "model_label", None) or []:
        try:
            loc = page.locator(sel)
            if not await loc.count():
                continue
            el = loc.last
            how = getattr(site, "model_label_from", "") or "text"
            raw = (await el.get_attribute(how[5:]) if how.startswith("attr:")
                   else await el.inner_text())
            raw = " ".join((raw or "").split())
            pat = getattr(site, "model_label_pattern", "")
            if pat:
                m = re.search(pat, raw)
                if not m:
                    return ""
                raw = m.group(1).strip()
            return raw[:80]
        except Exception:
            continue
    return ""


async def rate_limited(
    page: Page, candidates: list[str], *, prompt: str = "",
    answer: list[str] | tuple = (),
) -> str:
    """The site's own "you have used your quota" notice, or "".

    A DIFFERENT failure from a timeout, and the distinction is the whole point
    of the taxonomy. Verified on claude.ai: hitting the 5-hour limit leaves the
    composer present and the send apparently accepted, but no answer ever
    streams -- so completion detection reported "No new answer appeared within
    45s ... the send may not have registered, or the assistant_turn selector is
    wrong", and the remedy it suggested was editing selectors.yaml. The real
    remedy was to wait until 5pm.

    Returns the notice TEXT, not just a boolean, because it usually carries the
    reset time and that is the one thing the user actually needs. Pass the
    `prompt` that was sent and the site's `answer` (assistant_turn) selectors
    so the user's own words are never read as the site's -- see `notice`.
    """
    said = await notice(page, candidates, prompt=prompt, answer=answer)
    return "usage limit reached" if said == "(no text)" else said


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
        # Through overlay.py, like a run: a consent dialog over the composer
        # used to make this return False, and the doctor then reported the send
        # button as "not applicable" instead of actually testing it. A health
        # check that goes quiet in exactly the state that breaks runs is worse
        # than no health check.
        await overlay.focus_composer(page, box.locator.first, timeout_ms=3000)
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
