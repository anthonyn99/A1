"""Deciding when a model has finished answering.

No single signal survives UI churn, so four gates run in layers:

  1. Turn-count baseline. Count assistant turns BEFORE sending; require the
     count to grow before reading anything. Without this the scraper happily
     returns the *previous* answer -- the single nastiest failure mode here,
     because the output looks perfectly valid.

  2. Stop-button transition (primary). While generating, these UIs swap Send
     for Stop. Stop appearing then disappearing is the most semantically
     meaningful "done" signal available.

  3. Text stability (fallback). Poll the text; require N identical consecutive
     non-empty samples. Works anywhere but can fire early during a long pause
     mid-generation, so a result that rests only on this is marked
     low-confidence rather than passed off as clean.

  4. Idle + hard timeouts, so nothing hangs forever.

A challenge/login sentinel runs on every poll: hitting a Cloudflare wall should
fail in seconds with a clear cause, not burn the full 5-minute timeout.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from enum import StrEnum

from playwright.async_api import Page

from ..errors import FailureKind, ProviderError
from ..settings import SiteSelectors
from . import resolve
from .markdown import DOM_TO_MARKDOWN_JS


class CompletionReason(StrEnum):
    STOP_BUTTON = "stop_button"      # clean: generation visibly ended
    STREAM_MARKER = "stream_marker"  # clean: streaming class cleared
    STABILITY = "stability"          # fallback: text stopped changing
    STALL_TIMEOUT = "stall_timeout"  # degraded: no growth, gave up
    HARD_TIMEOUT = "hard_timeout"    # degraded: absolute ceiling hit


# Reasons we consider trustworthy enough not to caveat in the UI.
CLEAN_REASONS = {CompletionReason.STOP_BUTTON, CompletionReason.STREAM_MARKER}


@dataclass
class CompletionResult:
    text: str
    reason: CompletionReason
    elapsed_ms: int
    chars: int
    turns_before: int
    turns_after: int

    @property
    def is_clean(self) -> bool:
        return self.reason in CLEAN_REASONS

    @property
    def low_confidence(self) -> bool:
        """True when we never saw a semantic end-of-generation signal.

        The text is probably fine, but the UI should say so rather than imply
        the same certainty as a stop-button confirmation.
        """
        return not self.is_clean


@dataclass
class Baseline:
    """Page state captured immediately BEFORE sending.

    Two shapes of chat UI exist and they need different "is this a new answer?"
    tests:

      * append-style: a fresh assistant node is added per answer, so a growing
        turn count means a new answer.

      * fill-style: the shell pre-renders an EMPTY assistant node (ChatGPT's
        logged-out web-mobile shell ships a hidden "Write-only optimistic
        message" user node plus a blank assistant node), and the answer streams
        into that existing node. The count never changes.

    Counting alone silently returns the previous answer on fill-style UIs, so
    the baseline also records the last turn's text and treats a CHANGE from it
    as the real signal.
    """

    turns: int
    last_text: str


async def capture_baseline(page: Page, site: SiteSelectors) -> Baseline:
    """Snapshot turn count and last-turn text before sending."""
    text, count = await _read_latest(page, site)
    return Baseline(turns=count, last_text=text)


async def count_turns(page: Page, site: SiteSelectors) -> int:
    """How many assistant turns are on the page right now."""
    r = await resolve.resolve(page, site.assistant_turn, timeout_ms=0, require_visible=False)
    return r.count if r else 0


async def _check_sentinels(page: Page, site: SiteSelectors) -> None:
    """Fail fast on a login wall or bot challenge instead of waiting it out."""
    if await resolve.is_challenge_page(page, site.challenge_selectors):
        raise ProviderError(
            FailureKind.BOT_CHALLENGE,
            "A human-verification challenge appeared during generation.",
        )
    # Deliberately NOT treating a visible login control as a failure mid-answer.
    # ChatGPT shows a permanent "Log in" button in the sidebar even while
    # happily answering, so that check would abort every healthy run. A session
    # that genuinely dies mid-generation surfaces as a stall/timeout instead.


async def _read_latest(page: Page, site: SiteSelectors) -> tuple[str, int]:
    """Markdown of the last assistant turn, plus the current turn count.

    Serialised from the DOM rather than read with inner_text(): the UI has
    already rendered the model's markdown into real elements, and reading the
    text flattens headings, bullets and tables back into anonymous prose that
    nothing downstream can tell apart. See browser/markdown.py.
    """
    r = await resolve.resolve(page, site.assistant_turn, timeout_ms=0, require_visible=False)
    if not r or r.count == 0:
        return "", 0
    node = r.locator.nth(r.count - 1)
    try:
        text = await node.evaluate(DOM_TO_MARKDOWN_JS)
        return (text or "").strip(), r.count
    except Exception:
        # The node can be swapped out mid-read while React re-renders; treat as
        # "not ready yet" and let the next poll pick it up. Fall back to plain
        # text so a serializer failure degrades to the old behaviour rather
        # than losing the answer.
        try:
            return (await node.inner_text()).strip(), r.count
        except Exception:
            return "", r.count


async def wait_for_completion(
    page: Page,
    site: SiteSelectors,
    *,
    turns_before: int | None = None,
    baseline: Baseline | None = None,
    on_progress=None,
    cancel: asyncio.Event | None = None,
) -> CompletionResult:
    """Block until the answer is complete. Raises ProviderError on failure.

    Pass `baseline` (from capture_baseline) so fill-style UIs are handled.
    `turns_before` is the older count-only form, kept for callers that only
    have a count.
    """
    if baseline is None:
        baseline = Baseline(turns=turns_before or 0, last_text="")
    turns_before = baseline.turns
    start = time.monotonic()
    poll_s = site.poll_ms / 1000.0

    stop_seen = False
    marker_seen = False
    idle_polls = 0        # polls since the streaming marker cleared
    stop_idle_polls = 0   # polls since the stop button left its stop state
    confirm_samples = max(1, site.confirm_samples)
    stable_count = 0
    last_text = ""
    last_growth = start

    while True:
        if cancel is not None and cancel.is_set():
            raise ProviderError(FailureKind.CANCELLED, "Cancelled by user.")

        elapsed = time.monotonic() - start
        if elapsed > site.hard_timeout_s:
            if last_text:
                return CompletionResult(
                    text=last_text,
                    reason=CompletionReason.HARD_TIMEOUT,
                    elapsed_ms=int(elapsed * 1000),
                    chars=len(last_text),
                    turns_before=turns_before,
                    turns_after=turns_before + 1,
                )
            raise ProviderError(
                FailureKind.TIMEOUT,
                f"No answer after {site.hard_timeout_s}s (hard timeout).",
            )

        await _check_sentinels(page, site)

        # Gate 1: don't read anything until this is demonstrably a NEW answer.
        #
        # Either a turn was appended (append-style UIs) or the last turn's text
        # changed from what was there before we sent (fill-style UIs, where the
        # answer streams into a pre-rendered empty node). Without this, the
        # previous answer gets returned and looks entirely valid.
        text, turns_now = await _read_latest(page, site)
        is_new_turn = turns_now > turns_before
        is_changed = bool(text) and text != baseline.last_text
        if not (is_new_turn or is_changed):
            if time.monotonic() - last_growth > site.stall_timeout_s:
                raise ProviderError(
                    FailureKind.TIMEOUT,
                    f"No new answer appeared within {site.stall_timeout_s}s "
                    f"({turns_now} turns, text unchanged). The send may not have "
                    f"registered, or the assistant_turn selector is wrong.",
                )
            await asyncio.sleep(poll_s)
            continue

        # Gate 2: explicit streaming marker. Where a site exposes one (ChatGPT's
        # data-message-streaming), this is the best signal available -- the site
        # is telling us directly whether it is still generating. Checked before
        # the stop button because it is unambiguous.
        #
        # IMPORTANT: a semantic "finished" signal is necessary but NOT
        # sufficient. On long prompts ChatGPT emits a short preamble, drops the
        # streaming flag while it thinks, then streams the real answer into the
        # same node. Trusting the first clear signal captured the preamble and
        # threw the actual verdict away. So a done-signal only counts once the
        # text has also held still for `confirm_samples` polls.
        if site.streaming_marker:
            streaming_now = await resolve.present(page, site.streaming_marker)
            if streaming_now:
                marker_seen = True
                idle_polls = 0
            elif marker_seen and text:
                idle_polls += 1
                if idle_polls >= confirm_samples and text == last_text:
                    return CompletionResult(
                        text=text,
                        reason=CompletionReason.STREAM_MARKER,
                        elapsed_ms=int((time.monotonic() - start) * 1000),
                        chars=len(text),
                        turns_before=turns_before,
                        turns_after=turns_now,
                    )

        # Gate 2b: stop-button state.
        #
        # Two shapes in the wild, and the difference matters:
        #   (a) a separate stop button that appears then disappears;
        #   (b) ONE submit button that flips between send and stop states
        #       (ChatGPT's data-action-mode / data-stop-label).
        # For (b) the element never goes away, so "disappeared" is the wrong
        # test -- the stop_button selectors in config are written to match only
        # the button's stop STATE, which makes both shapes behave identically
        # here: matched => generating, no longer matched => finished.
        # Same confirmation rule as the streaming marker above: the button can
        # briefly return to its send state between a preamble and the real
        # answer, so require the text to have settled too.
        stop_now = await resolve.present(page, site.stop_button)
        if stop_now:
            stop_seen = True
            stop_idle_polls = 0
        elif stop_seen and text:
            stop_idle_polls += 1
            if stop_idle_polls >= confirm_samples and text == last_text:
                return CompletionResult(
                    text=text,
                    reason=CompletionReason.STOP_BUTTON,
                    elapsed_ms=int((time.monotonic() - start) * 1000),
                    chars=len(text),
                    turns_before=turns_before,
                    turns_after=turns_now,
                )

        # Gate 3: text stability.
        if text and text == last_text:
            stable_count += 1
        else:
            if len(text) > len(last_text):
                last_growth = time.monotonic()
            stable_count = 0
            last_text = text
            if on_progress is not None and text:
                await on_progress(text)

        # The stability fallback is the weakest gate: identical text for a few
        # polls can just mean the model is thinking mid-answer. It therefore
        # stands down while a semantic signal is ACTIVELY in play -- generation
        # is visibly running, or was seen running and we are waiting for the
        # confirm window. That is what stops a pause between a preamble and the
        # real answer from being mistaken for completion.
        #
        # But it must NOT stand down merely because the site *has* such signals.
        # A very short reply ("OK") can finish between two polls, so the marker
        # is never observed at all; with the old rule those answers fell through
        # to the 45s stall timeout. Measured: a 2-character answer took 68s.
        # Once text is present and has held still, and no signal is pending,
        # stability is the best evidence available -- use it.
        signal_pending = stop_now or (marker_seen and idle_polls < confirm_samples) \
            or (stop_seen and stop_idle_polls < confirm_samples)
        # Require a longer quiet run when the site normally has a signal we
        # never saw, since that is the less certain situation.
        has_semantic_signal = bool(site.streaming_marker) or bool(site.stop_button)
        needed = site.stability_samples * (2 if has_semantic_signal else 1)
        # Never let the weakest gate fire sooner than the confirm window the
        # site was tuned for. Claude needs ~10s of quiet to outlast the pause
        # between its opening question and the real answer; with the default
        # stability rule that pause would satisfy this gate first and capture
        # the preamble anyway -- defeating the point of raising confirm_samples.
        if has_semantic_signal:
            needed = max(needed, confirm_samples + 1)
        if (
            text
            and stable_count >= needed
            and not signal_pending
        ):
            return CompletionResult(
                text=text,
                reason=CompletionReason.STABILITY,
                elapsed_ms=int((time.monotonic() - start) * 1000),
                chars=len(text),
                turns_before=turns_before,
                turns_after=turns_now,
            )

        # Gate 4: stalled with partial text.
        if time.monotonic() - last_growth > site.stall_timeout_s:
            # Only return text that is demonstrably NEW. If it still matches the
            # pre-send baseline, this is the previous answer and returning it
            # would be worse than failing -- it looks completely valid.
            if text and (turns_now > turns_before or text != baseline.last_text):
                return CompletionResult(
                    text=text,
                    reason=CompletionReason.STALL_TIMEOUT,
                    elapsed_ms=int((time.monotonic() - start) * 1000),
                    chars=len(text),
                    turns_before=turns_before,
                    turns_after=turns_now,
                )
            if text:
                raise ProviderError(
                    FailureKind.TIMEOUT,
                    f"The answer never changed from what was on screen before "
                    f"sending ({site.stall_timeout_s}s). The send may not have "
                    f"registered.",
                )
            raise ProviderError(
                FailureKind.EMPTY_RESPONSE,
                f"An assistant turn appeared but stayed empty for {site.stall_timeout_s}s. "
                f"The assistant_turn selector is probably matching a wrapper element.",
            )

        await asyncio.sleep(poll_s)
