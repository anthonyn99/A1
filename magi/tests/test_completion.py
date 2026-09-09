"""Completion-gate tests against a scripted fake page.

These exercise the logic that decides "the model is done", which is where the
expensive-to-debug bugs live -- especially the turn-count baseline, since
without it the scraper returns the PREVIOUS answer and the output looks
completely valid.

No browser required; a fake stands in for the parts of the Playwright Page API
the completion loop touches.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.browser import completion  # noqa: E402
from magi.browser.completion import CompletionReason  # noqa: E402
from magi.errors import FailureKind, ProviderError  # noqa: E402
from magi.settings import SiteSelectors  # noqa: E402


class FakeLocator:
    def __init__(self, texts: list[str]):
        self._texts = texts

    async def count(self) -> int:
        return len(self._texts)

    def nth(self, i: int) -> "FakeLocator":
        return FakeLocator([self._texts[i]])

    @property
    def first(self) -> "FakeLocator":
        return FakeLocator(self._texts[:1])

    async def inner_text(self) -> str:
        return self._texts[0]

    async def is_visible(self) -> bool:
        return bool(self._texts)

    async def wait_for(self, **kw):
        return None


class FakePage:
    """Replays a script of page states, advancing one frame per poll cycle.

    Each frame: {"turns": [...assistant texts...], "stop": bool,
                 "challenge": bool, "login": bool}
    The last frame repeats once exhausted.

    The completion loop queries several selectors within a single poll, so the
    frame advances on the CHALLENGE lookup -- the first query of each cycle --
    rather than on every locator() call.
    """

    def __init__(self, frames: list[dict]):
        self.frames = frames
        self.i = -1  # first challenge check advances to frame 0

    def _current(self) -> dict:
        return self.frames[min(max(self.i, 0), len(self.frames) - 1)]

    def locator(self, selector: str) -> FakeLocator:
        if selector == "CHALLENGE":
            self.i += 1  # new poll cycle begins
            f = self._current()
            return FakeLocator(["c"] if f.get("challenge") else [])
        f = self._current()
        if selector == "TURN":
            return FakeLocator(list(f.get("turns", [])))
        if selector == "STOP":
            return FakeLocator(["stop"] if f.get("stop") else [])
        if selector == "STREAMING":
            return FakeLocator(["s"] if f.get("streaming") else [])
        if selector == "LOGIN":
            return FakeLocator(["l"] if f.get("login") else [])
        return FakeLocator([])

    async def title(self) -> str:
        return self._current().get("title", "ChatGPT")


def make_site(**over) -> SiteSelectors:
    base = dict(
        id="fake",
        display_name="Fake",
        url="https://example.test",
        input=["INPUT"],
        submit=["SUBMIT"],
        assistant_turn=["TURN"],
        stop_button=["STOP"],
        streaming_marker=[],
        login_selectors=["LOGIN"],
        challenge_selectors=["CHALLENGE"],
        poll_ms=1,
        stability_samples=2,
        confirm_samples=1,
        stall_timeout_s=2,
        hard_timeout_s=5,
    )
    base.update(over)
    return SiteSelectors(**base)


@pytest.mark.asyncio
async def test_stop_button_is_clean_completion():
    page = FakePage([
        {"turns": ["old"], "stop": True},
        {"turns": ["old", "partial"], "stop": True},
        {"turns": ["old", "full answer"], "stop": True},
        {"turns": ["old", "full answer"], "stop": False},
    ])
    site = make_site()
    r = await completion.wait_for_completion(page, site, turns_before=1)
    assert r.text == "full answer"
    assert r.reason == CompletionReason.STOP_BUTTON
    assert r.is_clean and not r.low_confidence


@pytest.mark.asyncio
async def test_does_not_read_previous_answer_before_new_turn():
    """The critical gate: with no new turn, we must not return the old text."""
    page = FakePage([
        {"turns": ["PREVIOUS ANSWER"], "stop": False},
        {"turns": ["PREVIOUS ANSWER"], "stop": False},
        {"turns": ["PREVIOUS ANSWER"], "stop": False},
        {"turns": ["PREVIOUS ANSWER", "new answer"], "stop": True},
        {"turns": ["PREVIOUS ANSWER", "new answer"], "stop": False},
    ])
    site = make_site()
    r = await completion.wait_for_completion(page, site, turns_before=1)
    assert r.text == "new answer"
    assert "PREVIOUS" not in r.text


@pytest.mark.asyncio
async def test_stability_fallback_is_flagged_low_confidence():
    """On a site exposing NO semantic signal, stability is all we have.

    It still yields the answer, but flagged low-confidence so the UI can say
    the completion was inferred rather than confirmed.
    """
    page = FakePage([
        {"turns": ["a", "settled"]},
        {"turns": ["a", "settled"]},
        {"turns": ["a", "settled"]},
        {"turns": ["a", "settled"]},
    ])
    site = make_site(stop_button=[], streaming_marker=[])
    r = await completion.wait_for_completion(page, site, turns_before=1)
    assert r.text == "settled"
    assert r.reason == CompletionReason.STABILITY
    assert r.low_confidence


@pytest.mark.asyncio
async def test_stability_does_not_fire_when_a_semantic_signal_exists():
    """Regression guard for the preamble-truncation bug.

    With a stop button configured, steady text alone must NOT end the wait --
    the model may simply be thinking mid-answer.
    """
    page = FakePage([
        {"turns": ["a", "preamble"], "stop": True},
        {"turns": ["a", "preamble"], "stop": True},
        {"turns": ["a", "preamble"], "stop": True},
        {"turns": ["a", "preamble"], "stop": True},
        {"turns": ["a", "the full answer"], "stop": True},
        {"turns": ["a", "the full answer"], "stop": False},
        {"turns": ["a", "the full answer"], "stop": False},
    ])
    site = make_site(streaming_marker=[])
    r = await completion.wait_for_completion(page, site, turns_before=1)
    assert r.text == "the full answer"


@pytest.mark.asyncio
async def test_challenge_fails_fast_with_specific_kind():
    page = FakePage([{"turns": ["a"], "challenge": True}])
    site = make_site()
    with pytest.raises(ProviderError) as ei:
        await completion.wait_for_completion(page, site, turns_before=1)
    assert ei.value.kind == FailureKind.BOT_CHALLENGE


@pytest.mark.asyncio
async def test_visible_login_control_does_not_abort_a_healthy_run():
    """A login button on screen must NOT be treated as failure mid-answer.

    ChatGPT keeps a permanent "Log in" button in its sidebar while answering
    normally, so treating that as an expired session would abort every healthy
    run. A genuinely dead session shows up as a stall/timeout instead.
    """
    page = FakePage([
        {"turns": ["old", "answering"], "stop": True, "login": True},
        {"turns": ["old", "complete answer"], "stop": True, "login": True},
        {"turns": ["old", "complete answer"], "stop": False, "login": True},
    ])
    site = make_site()
    r = await completion.wait_for_completion(page, site, turns_before=1)
    assert r.text == "complete answer"
    assert r.reason == CompletionReason.STOP_BUTTON


@pytest.mark.asyncio
async def test_no_new_turn_times_out_rather_than_returning_stale_text():
    """Never hand back the answer that was already on screen before sending."""
    page = FakePage([{"turns": ["only the old one"], "stop": False}])
    site = make_site(stall_timeout_s=1, hard_timeout_s=3)
    baseline = completion.Baseline(turns=1, last_text="only the old one")
    with pytest.raises(ProviderError) as ei:
        await completion.wait_for_completion(page, site, baseline=baseline)
    assert ei.value.kind == FailureKind.TIMEOUT


@pytest.mark.asyncio
async def test_empty_turn_reports_empty_response_not_success():
    """A matched-but-empty turn means a bad selector, not a valid empty answer."""
    page = FakePage([{"turns": ["old", "   "], "stop": False}])
    site = make_site(stall_timeout_s=1, hard_timeout_s=3)
    with pytest.raises(ProviderError) as ei:
        await completion.wait_for_completion(page, site, turns_before=1)
    assert ei.value.kind == FailureKind.EMPTY_RESPONSE


@pytest.mark.asyncio
async def test_streaming_marker_clearing_is_clean_completion():
    """ChatGPT's data-message-streaming dropping is the strongest 'done' signal."""
    page = FakePage([
        {"turns": ["old", "part"], "streaming": True},
        {"turns": ["old", "fuller"], "streaming": True},
        {"turns": ["old", "final text"], "streaming": False},
    ])
    site = make_site(streaming_marker=["STREAMING"])
    r = await completion.wait_for_completion(page, site, turns_before=1)
    assert r.text == "final text"
    assert r.reason == CompletionReason.STREAM_MARKER
    assert r.is_clean


@pytest.mark.asyncio
async def test_transforming_submit_button_is_handled():
    """ChatGPT's one button flips send<->stop instead of appearing/disappearing.

    Config matches only its stop STATE, so 'no longer matched' means finished
    even though the element itself never leaves the DOM.
    """
    page = FakePage([
        {"turns": ["old", "writing"], "stop": True},
        {"turns": ["old", "done now"], "stop": True},
        {"turns": ["old", "done now"], "stop": False},
    ])
    site = make_site()
    r = await completion.wait_for_completion(page, site, turns_before=1)
    assert r.text == "done now"
    assert r.reason == CompletionReason.STOP_BUTTON


@pytest.mark.asyncio
async def test_cloudflare_interstitial_detected_by_title():
    """Headless Chrome sits on 'Just a moment...' with no matchable selectors."""
    page = FakePage([{"turns": [], "title": "Just a moment..."}])
    site = make_site(challenge_selectors=["CHALLENGE"])
    with pytest.raises(ProviderError) as ei:
        await completion.wait_for_completion(page, site, turns_before=0)
    assert ei.value.kind == FailureKind.BOT_CHALLENGE


@pytest.mark.asyncio
async def test_preamble_pause_does_not_truncate_the_real_answer():
    """Regression: models pause between a preamble and the actual answer.

    Observed live -- ChatGPT answered a long synthesis prompt with "Yes. I'll
    distinguish genuine consensus...", dropped the streaming flag while
    thinking, then streamed the real verdict into the SAME node. Trusting the
    first done-signal captured the preamble and discarded the verdict.
    """
    page = FakePage([
        {"turns": ["old", "Yes. I'll do that."], "streaming": True},
        {"turns": ["old", "Yes. I'll do that."], "streaming": False},   # pause
        {"turns": ["old", "Yes. I'll do that."], "streaming": False},   # still paused
        {"turns": ["old", "AGREEMENTS\n- the real verdict"], "streaming": True},
        {"turns": ["old", "AGREEMENTS\n- the real verdict"], "streaming": False},
        {"turns": ["old", "AGREEMENTS\n- the real verdict"], "streaming": False},
        {"turns": ["old", "AGREEMENTS\n- the real verdict"], "streaming": False},
        {"turns": ["old", "AGREEMENTS\n- the real verdict"], "streaming": False},
    ])
    site = make_site(streaming_marker=["STREAMING"], confirm_samples=3)
    r = await completion.wait_for_completion(page, site, turns_before=1)
    assert "real verdict" in r.text
    assert "Yes. I'll do that." != r.text


@pytest.mark.asyncio
async def test_very_short_answer_does_not_wait_for_the_stall_timeout():
    """Regression: a reply so short it finishes between polls.

    The streaming marker is never observed, so the run used to fall through to
    the 45s stall timeout. Measured live: a 2-character answer ("OK") took 68s.
    Stability should close it out once no signal is pending.
    """
    frames = [{"turns": ["old", "OK"], "streaming": False} for _ in range(30)]
    page = FakePage(frames)
    site = make_site(streaming_marker=["STREAMING"], stability_samples=2,
                     stall_timeout_s=30, hard_timeout_s=60)
    r = await completion.wait_for_completion(page, site, turns_before=1)
    assert r.text == "OK"
    assert r.reason == CompletionReason.STABILITY
    # It resolved on stability, not by burning the stall timeout.
    assert r.low_confidence


@pytest.mark.asyncio
async def test_stability_still_waits_while_generation_is_visibly_running():
    """The short-answer fix must not resurrect the preamble-truncation bug."""
    page = FakePage([
        {"turns": ["a", "preamble"], "stop": True},
        {"turns": ["a", "preamble"], "stop": True},
        {"turns": ["a", "preamble"], "stop": True},
        {"turns": ["a", "preamble"], "stop": True},
        {"turns": ["a", "preamble"], "stop": True},
        {"turns": ["a", "preamble"], "stop": True},
        {"turns": ["a", "the full answer"], "stop": True},
        {"turns": ["a", "the full answer"], "stop": False},
        {"turns": ["a", "the full answer"], "stop": False},
    ])
    site = make_site(streaming_marker=[], stability_samples=2)
    r = await completion.wait_for_completion(page, site, turns_before=1)
    assert r.text == "the full answer"


@pytest.mark.asyncio
async def test_cancel_is_honoured():
    page = FakePage([{"turns": ["a"], "stop": True}])
    site = make_site()
    cancel = asyncio.Event()
    cancel.set()
    with pytest.raises(ProviderError) as ei:
        await completion.wait_for_completion(page, site, turns_before=0, cancel=cancel)
    assert ei.value.kind == FailureKind.CANCELLED


@pytest.mark.asyncio
async def test_claude_framing_question_is_not_captured_as_the_answer():
    """The dominant real-world failure, reproduced.

    Measured over 21 archived runs: Claude opened a long answer with a
    one-line framing QUESTION, dropped data-is-streaming while it thought,
    then streamed the real answer into the same node. This hit 10 out of 10
    long-prompt runs (23-53 chars captured against 4k-26k for the other
    units), always with completion_reason=stream_marker.

    The pause is longer than the default confirm window, so the fix is a
    site-level confirm_samples raise -- this proves the loop actually waits
    it out instead of returning the preamble.
    """
    preamble = "What should actually drive the long/short call?"
    answer = "THE REAL ANSWER, at length."
    page = FakePage([
        {"turns": [""], "streaming": True},
        {"turns": [preamble], "streaming": True},
        # Marker clears while Claude thinks -- the trap. Nine quiet polls is
        # longer than the old 3-poll confirm window, so this is exactly the
        # pause that used to end the wait and return the question.
        *[{"turns": [preamble], "streaming": False} for _ in range(9)],
        # The real answer then streams into the SAME node.
        {"turns": [answer], "streaming": True},
        *[{"turns": [answer], "streaming": False} for _ in range(20)],
    ])
    site = make_site(
        streaming_marker=["STREAMING"], stop_button=[],
        confirm_samples=14, stability_samples=4,
    )
    r = await completion.wait_for_completion(page, site, turns_before=0)
    assert r.text == answer
    assert "long/short call" not in r.text


@pytest.mark.asyncio
async def test_stability_gate_cannot_undercut_the_confirm_window():
    """The weakest gate must not fire before the site's tuned confirm window.

    Raising confirm_samples alone is not enough: with the default rule,
    stability needed only stability_samples*2 polls, so the very pause that
    confirm_samples exists to outlast would satisfy stability first and
    capture the preamble anyway.
    """
    page = FakePage([
        {"turns": ["preamble?"], "streaming": True},
        *[{"turns": ["preamble?"], "streaming": False} for _ in range(10)],
        {"turns": ["the real answer"], "streaming": True},
        *[{"turns": ["the real answer"], "streaming": False} for _ in range(20)],
    ])
    site = make_site(
        streaming_marker=["STREAMING"], stop_button=[],
        confirm_samples=14, stability_samples=2,   # 2*2=4 polls, far too few
    )
    r = await completion.wait_for_completion(page, site, turns_before=0)
    assert r.text == "the real answer"
