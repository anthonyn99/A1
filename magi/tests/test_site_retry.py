"""A site that broke gets one more try, in a fresh chat (BrowserProvider.ask).

2026-10-13: Gemini answered a TradeHub market question with "Sorry, something
went wrong. Please try your request again." and was excluded from the verdict,
though it had answered the same question the night before. ask() is what
deliberations, the chairman, Brainstorm, Code Mode and Studio all call, so the
retry lives there. _ask_site (one real browser turn) is replaced by a script.
"""

from __future__ import annotations

import asyncio

import pytest

from magi.engine import validate
from magi.errors import FailureKind
from magi.providers import browser_base
from magi.providers.base import Answer, ProviderState, RunContext
from magi.providers.browser_base import BrowserProvider
from magi.settings import load_settings

GOOD = ("Stocks rose on Monday after the Fed signalled a pause; the S&P 500 "
        "gained 1.2% led by chip makers, and Treasury yields fell.")
HICCUP = "Sorry, something went wrong. Please try your request again."


def _degraded(text: str) -> Answer:
    a = Answer.degraded_capture("gemini", "Gemini", text, "refusal")
    a.degraded_kind = "refusal"
    return a


def _ok(text: str = GOOD) -> Answer:
    return Answer(provider_id="gemini", display_name="Gemini", text=text,
                  ok=True, state=ProviderState.DONE)


def _run(monkeypatch, script, *, cancel=None, interrupt=None, site="gemini",
         attachments=None, guests=None):
    monkeypatch.setattr(browser_base, "SITE_RETRY_PAUSE_S", 0.0)
    calls, events = [], []

    async def fake(self, question, *, ctx, on_event=None, cancel=None, guest=False):
        calls.append(question)
        if guests is not None:
            guests.append(guest)
        return script[len(calls) - 1]

    monkeypatch.setattr(BrowserProvider, "_ask_site", fake)
    s = load_settings()
    p = BrowserProvider(s.site(site), s)

    async def on_event(e):
        events.append(e)

    ctx = RunContext(run_id="t", question="What moved the market?", interrupt=interrupt,
                     attachments=attachments or [])
    a = asyncio.run(p.ask("What moved the market?", ctx=ctx, on_event=on_event, cancel=cancel))
    return a, calls, events


def test_something_went_wrong_is_asked_again_and_the_answer_counts(monkeypatch):
    a, calls, events = _run(monkeypatch, [_degraded(HICCUP), _ok()])
    assert a.ok and a.text == GOOD
    assert len(calls) == 2
    assert any(e.state is ProviderState.LAUNCHING and "again" in e.message for e in events)


def test_gemini_retries_signed_out(monkeypatch):
    """2026-10-13: the signed-in account failed every search question; the
    same question from a signed-out profile answered."""
    from magi.settings import load_settings
    assert load_settings().site("gemini").guest_retry
    guests = []
    a, _, events = _run(monkeypatch, [_degraded(HICCUP), _ok()], guests=guests)
    assert guests == [False, True] and a.ok
    assert any("signed out" in e.message for e in events)


def test_no_guest_retry_with_attachments_or_on_other_sites(monkeypatch, tmp_path):
    guests = []
    _run(monkeypatch, [_degraded(HICCUP), _ok()], guests=guests,
         attachments=[tmp_path / "chart.png"])
    assert guests == [False, False]
    guests.clear()
    _run(monkeypatch, [_degraded(HICCUP), _ok()], guests=guests, site="chatgpt")
    assert guests == [False, False]


def test_the_send_refused_toast_is_asked_again(monkeypatch):
    toast = Answer.failed("gemini", "Gemini", FailureKind.SITE_ERROR, "(1099)")
    a, calls, _ = _run(monkeypatch, [toast, _ok()])
    assert a.ok and len(calls) == 2


def test_only_one_retry(monkeypatch):
    a, calls, _ = _run(monkeypatch, [_degraded(HICCUP), _degraded(HICCUP), _ok()])
    assert len(calls) == 2
    assert a.degraded and not a.ok


@pytest.mark.parametrize("answer", [
    _ok(),
    _degraded("I can't help with that request."),
    Answer.failed("gemini", "Gemini", FailureKind.NOT_LOGGED_IN, "signed out"),
    Answer.failed("gemini", "Gemini", FailureKind.CANCELLED, "cancelled"),
])
def test_a_real_answer_or_a_refusal_is_not_retried(monkeypatch, answer):
    _, calls, _ = _run(monkeypatch, [answer, _ok()])
    assert len(calls) == 1


def test_a_cancelled_run_is_not_retried(monkeypatch):
    ev = asyncio.Event()
    ev.set()
    _, calls, _ = _run(monkeypatch, [_degraded(HICCUP), _ok()], cancel=ev)
    assert len(calls) == 1


def test_an_interrupted_run_is_not_retried(monkeypatch):
    ev = asyncio.Event()
    ev.set()
    _, calls, _ = _run(monkeypatch, [_degraded(HICCUP), _ok()], interrupt=ev)
    assert len(calls) == 1


def test_which_lines_are_the_site_failing():
    for line in (
        HICCUP,
        "Something went wrong (1099)",
        "I seem to be encountering an error. Can I try something else for you?",
        "I encountered an error doing what you asked. Could you try again?",
        "The server is busy. Please try again later.",
    ):
        assert validate.is_site_hiccup(line), line
    for line in (
        "I can't help with that.",
        "I'm having a hard time fulfilling your request. Can I help you with something else instead?",
        "I am unable to perform real-time web searches or access live market data.",
        "",
        # A real answer that mentions an error in passing is long.
        GOOD * 8 + " Something went wrong for bonds.",
    ):
        assert not validate.is_site_hiccup(line), line
