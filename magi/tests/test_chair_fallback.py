"""A chairman that fails hands the verdict to the next unit that answered.

Observed 2026-09-21: Gemini, as a member, returned "I'm having a hard time
fulfilling your request" and was counted RESOLVED in a 5/5 consensus; as
chairman it returned "I encountered an error doing what you asked. Could you
try again?" -- and that line was published as the verdict, because a chair
that failed had nobody to hand over to.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from magi.engine.orchestrator import Orchestrator
from magi.engine.validate import Rejection, validate_answer
from magi.errors import FailureKind
from magi.providers.base import Answer, Provider, ProviderState

GOOD = (
    "Oil fell sharply, pulling Treasury yields lower and lifting AI and "
    "semiconductor stocks. That moved the market most today, and the Nasdaq led. "
) * 8

VERDICT = "ANSWER\nOil fell and chips rallied.\n\nNOTES\nNone.\n\nCONFIDENCE\nHIGH -- they agree."


class Stub(Provider):
    kind = "api"

    def __init__(self, pid, member_text, chair_text=None, chair_ok=True, state=ProviderState.DONE):
        self.id = pid
        self.display_name = pid.title()
        self.member_text = member_text
        self.chair_text = chair_text
        self.chair_ok = chair_ok
        self.chaired = 0

    async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
        if question.startswith("You are the chairman"):
            self.chaired += 1
            if not self.chair_ok:
                return Answer.degraded_capture(
                    self.id, self.display_name, self.chair_text,
                    validate_answer(self.chair_text, "q", display_name=self.display_name).summary,
                )
            return Answer(provider_id=self.id, display_name=self.display_name,
                          text=self.chair_text or VERDICT, ok=True, state=ProviderState.DONE)
        if self.member_text is None:
            return Answer.failed(self.id, self.display_name, FailureKind.UNKNOWN, "boom")
        return Answer(provider_id=self.id, display_name=self.display_name,
                      text=self.member_text, ok=True, state=ProviderState.DONE)

    async def health_check(self, *, deep=False):
        raise NotImplementedError


def _orch(chair="gemini", fallback=()):
    settings = SimpleNamespace(
        chairman=SimpleNamespace(provider_id=chair, fallback_order=list(fallback), min_members=2),
        pacing=SimpleNamespace(mode="sequential", max_concurrency=1, sample_inter_provider=lambda: 0),
    )
    return Orchestrator(settings)


def _run(orch, providers):
    return asyncio.run(orch.run("What moved the market the most today?", providers))


def test_failed_chair_hands_the_verdict_to_the_next_unit():
    gemini = Stub("gemini", GOOD, "I encountered an error doing what you asked. Could you try again?", chair_ok=False)
    chatgpt = Stub("chatgpt", GOOD)
    out = _run(_orch("gemini", ["chatgpt"]), [gemini, chatgpt])
    assert out["synthesis_ok"]
    assert out["verdict"] == VERDICT
    assert out["chairman"] == "Chatgpt"
    assert gemini.chaired == 1 and chatgpt.chaired == 1


def test_fallback_reaches_members_outside_the_configured_order():
    """Whoever the chairman is, any unit that answered can take over."""
    a = Stub("grok", GOOD, "Something went wrong.", chair_ok=False)
    b = Stub("deepseek", GOOD)
    out = _run(_orch("grok", []), [a, b])
    assert out["synthesis_ok"] and out["chairman"] == "Deepseek"


def test_every_chair_failing_is_reported_not_published():
    a = Stub("gemini", GOOD, "Something went wrong.", chair_ok=False)
    b = Stub("chatgpt", GOOD, "I can't help with that.", chair_ok=False)
    out = _run(_orch("gemini", []), [a, b])
    assert not out["synthesis_ok"]
    assert out["verdict"] == ""
    assert "Gemini" in out["synthesis_error"] and "Chatgpt" in out["synthesis_error"]


def test_first_chair_that_works_is_the_only_one_driven():
    a = Stub("gemini", GOOD)
    b = Stub("chatgpt", GOOD)
    out = _run(_orch("gemini", ["chatgpt"]), [a, b])
    assert out["chairman"] == "Gemini" and b.chaired == 0


def test_a_failed_member_is_never_offered_the_chair():
    a = Stub("gemini", None)
    b = Stub("chatgpt", GOOD)
    c = Stub("grok", GOOD)
    chairs = _orch("gemini", []).chair_candidates(
        [a, b, c],
        [Answer.failed("gemini", "Gemini", FailureKind.UNKNOWN, "x"),
         Answer(provider_id="chatgpt", display_name="Chatgpt", text=GOOD, ok=True, state=ProviderState.DONE),
         Answer(provider_id="grok", display_name="Grok", text=GOOD, ok=True, state=ProviderState.DONE)],
    )
    assert [p.id for p in chairs] == ["chatgpt", "grok"]


# -- the stock lines themselves ------------------------------------------------

REFUSALS = [
    # Observed 2026-09-21 (Gemini member, Gemini chairman)
    "I'm having a hard time fulfilling your request. Can I help you with something else instead?",
    "I encountered an error doing what you asked. Could you try again?",
    # Gemini
    "I’m just a language model, so I can’t help you with that.",
    "Something went wrong. Please try again.",
    # ChatGPT / Claude / Grok
    "I can't help with that.",
    "Sorry, I can't assist with that request.",
    "Something went wrong while generating the response. If this issue persists please contact us.",
    # DeepSeek
    "Sorry, that's beyond my current scope. Let's talk about something else.",
    "The server is busy. Please try again later.",
    # Perplexity
    "An error occurred. Please try again later.",
    "You've reached your daily limit for Pro searches.",
]


def test_stock_refusals_and_errors_are_not_votes():
    for text in REFUSALS:
        v = validate_answer(text, "What moved the market the most today?", display_name="Gemini")
        assert not v.ok, text
        assert v.reason == Rejection.REFUSAL, (text, v.reason)


def test_real_answers_are_untouched():
    q = "What moved the market the most today?"
    for text in [
        GOOD,
        "Oil. Brent fell 3.4% and pulled yields down with it.",
        "No. Postgres handles this fine at your volume.",
        # A long answer that mentions an error in passing.
        "Markets rallied. " + GOOD + " One broker noted that something went wrong "
        "with its order routing in the first minutes, but it did not move prices.",
    ]:
        assert validate_answer(text, q).ok, text
