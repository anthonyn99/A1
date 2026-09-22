"""The three things that broke the 2026-09-22 morning report.

1. Two streams on one run split its events (one asyncio.Queue, two readers).
2. The same prompt started a second council while the first was running.
3. ChatGPT refused a 78k-character synthesis as "too long", and that line
   became the verdict.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from magi.engine import chairman, validate  # noqa: E402
from magi.fanout import Broadcast  # noqa: E402
from magi.providers.base import Answer  # noqa: E402


def test_every_listener_gets_every_event():
    async def go():
        b = Broadcast()
        a, c = b.subscribe(), b.subscribe()
        for i in range(3):
            await b.put({"i": i})
        got_a = [a.get_nowait()["i"] for _ in range(3)]
        got_c = [c.get_nowait()["i"] for _ in range(3)]
        b.unsubscribe(a)
        await b.put({"i": 9})
        assert a.empty() and c.get_nowait()["i"] == 9
        return got_a, got_c

    got_a, got_c = asyncio.run(go())
    assert got_a == got_c == [0, 1, 2]


def test_no_stream_reads_the_shared_queue_directly():
    src = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")
    assert 'state["queue"].get()' not in src
    assert "asyncio.Queue()" not in src.split("def _live_twin")[1].split("@app.get(\"/api/runs/{run_id}/stream\")")[0]


def test_a_live_identical_run_is_joined():
    from magi import app as app_mod

    async def go():
        app_mod._runs.clear()
        app_mod._runs["r1"] = {
            "done": False, "cancel": asyncio.Event(), "question": "Q",
            "providers": {"chatgpt": {}, "grok": {}},
        }
        hit = app_mod._live_twin("Q", ["grok", "chatgpt"])
        other_units = app_mod._live_twin("Q", ["grok"])
        other_q = app_mod._live_twin("Q2", ["grok", "chatgpt"])
        app_mod._runs["r1"]["done"] = True
        finished = app_mod._live_twin("Q", ["grok", "chatgpt"])
        app_mod._runs.clear()
        return hit, other_units, other_q, finished

    assert asyncio.run(go()) == ("r1", None, None, None)


def _ans(pid, n):
    body = "\n".join(f"line {i} " + "x" * 60 for i in range(n // 68 + 1))[:n]
    return Answer(provider_id=pid, display_name=pid, text=body + "\nFINAL TIER LIST",
                  ok=True, state="done")


def test_synthesis_fits_the_chair_and_keeps_every_conclusion():
    answers = [_ans(p, 20_000) for p in ("chatgpt", "deepseek", "perplexity", "grok")]
    answers.append(_ans("short", 1_500))
    q = "Q" * 5_600
    full = chairman.build_prompt(q, answers)
    fit = chairman.build_prompt(q, answers, max_chars=50_000)
    assert len(full) > 80_000
    assert len(fit) <= 50_000
    # The tail survives the cut: that is where a report's summary lives.
    assert fit.count("FINAL TIER LIST") == 5
    # A short answer is never trimmed to make room for the long ones.
    assert answers[-1].text in fit
    assert "characters trimmed for length" in fit


def test_small_syntheses_are_untouched():
    answers = [_ans(p, 3_000) for p in ("a", "b")]
    assert chairman.build_prompt("Q", answers, max_chars=50_000) == chairman.build_prompt("Q", answers)


def test_the_chair_budget_is_used():
    src = (Path(chairman.__file__)).read_text(encoding="utf-8")
    assert "max_chars=prompt_budget(chairman.id)" in src


def test_todays_stock_lines_are_refusals():
    for line in (
        "The message you submitted was too long, please edit it and resubmit.",
        "I seem to be encountering an error. Can I try something else for you?",
    ):
        v = validate.validate_answer(line, "Daily macro report", display_name="X")
        assert not v.ok and v.reason == validate.Rejection.REFUSAL, line


# -- nothing waits forever on a limit or a stock error line (2026-09-22) -----

import pytest  # noqa: E402

from magi.browser import completion  # noqa: E402
from magi.browser.completion import CompletionReason  # noqa: E402
from magi.errors import FailureKind, ProviderError  # noqa: E402
from tests.test_completion import FakeLocator, FakePage, make_site  # noqa: E402


class LimitPage(FakePage):
    def locator(self, selector):
        if selector == "LIMIT":
            f = self._current()
            return FakeLocator([f["limit"]] if f.get("limit") else [])
        return super().locator(selector)


@pytest.mark.asyncio
async def test_a_limit_notice_after_send_ends_the_wait(monkeypatch):
    """Grok: the answer is replaced by a quota card -- no text, no stop button."""
    monkeypatch.setattr(completion, "LIMIT_CHECK_S", 0.0)
    page = LimitPage([{"turns": ["old"]}, {"turns": ["old"], "limit": "7 hours 30 minutes before limit is gone"}])
    site = make_site(rate_limit_selectors=["LIMIT"], stall_timeout_s=60, hard_timeout_s=60)
    with pytest.raises(ProviderError) as e:
        await completion.wait_for_completion(page, site, turns_before=1)
    assert e.value.kind == FailureKind.RATE_LIMITED
    assert "limit is gone" in e.value.detail


@pytest.mark.asyncio
async def test_a_settled_error_line_ends_the_wait_despite_a_stop_button(monkeypatch):
    """Gemini: error line on screen, Stop button never went away."""
    monkeypatch.setattr(completion, "CANNED_SETTLE_S", 0.05)
    line = "I encountered an error doing what you asked. Could you try again?"
    page = FakePage([{"turns": ["old"], "stop": True}] + [{"turns": ["old", line], "stop": True}])
    site = make_site(stall_timeout_s=60, hard_timeout_s=60)
    r = await completion.wait_for_completion(page, site, turns_before=1)
    assert r.text == line and r.reason == CompletionReason.CANNED_LINE


@pytest.mark.asyncio
async def test_a_real_answer_is_not_cut_short_by_the_error_rule(monkeypatch):
    monkeypatch.setattr(completion, "CANNED_SETTLE_S", 10.0)
    page = FakePage([
        {"turns": ["old", "Something went wrong"], "stop": True},
        {"turns": ["old", "Something went wrong in markets: " + "x" * 700], "stop": True},
        {"turns": ["old", "Something went wrong in markets: " + "x" * 700], "stop": False},
    ])
    r = await completion.wait_for_completion(page, make_site(), turns_before=1)
    assert r.reason == CompletionReason.STOP_BUTTON and len(r.text) > 700


def _run_ask(answers):
    from magi.engine.orchestrator import Orchestrator
    from magi.providers.base import ProviderState

    calls, events = [], []

    class P:
        id, display_name = "gemini", "Gemini"

        async def ask(self, q, ctx=None, on_event=None, cancel=None):
            calls.append(q)
            return answers[len(calls) - 1]

    async def emit(ev):
        events.append(ev)

    a = asyncio.run(Orchestrator._ask(P(), "Q", None, emit, None))
    return a, calls, [e.state for e in events if e.state == ProviderState.FAILED]


def test_an_error_line_is_not_retried():
    d = Answer.degraded_capture("gemini", "Gemini", "I'm having a hard time fulfilling your request.", "refusal")
    d.degraded_kind = "refusal"
    _, calls, _ = _run_ask([d, d])
    assert len(calls) == 1


def test_a_cant_search_refusal_still_gets_its_retry():
    d = Answer.degraded_capture("gemini", "Gemini", "I do not have access to real-time data or live web search.", "refusal")
    d.degraded_kind = "refusal"
    _, calls, _ = _run_ask([d, d])
    assert len(calls) == 2


def test_a_failure_is_announced_when_it_happens():
    f = Answer.failed("gemini", "Gemini", FailureKind.RATE_LIMITED, "Grok says: limit")
    a, _, failed_events = _run_ask([f])
    assert not a.ok and len(failed_events) == 1


def test_a_straggler_is_cut_off_once_everyone_else_is_done(monkeypatch):
    from magi.engine import orchestrator as orch_mod
    from magi.providers.base import ProviderState

    monkeypatch.setattr(orch_mod, "STRAGGLER_GRACE_S", 0.2)

    async def go():
        events = []

        async def emit(ev):
            events.append(ev)

        async def quick():
            await asyncio.sleep(0.01)
            return "a"

        async def stuck():
            await asyncio.sleep(3600)

        class P:
            def __init__(self, i):
                self.id = self.display_name = i

        o = orch_mod.Orchestrator.__new__(orch_mod.Orchestrator)
        tasks = [asyncio.create_task(quick()), asyncio.create_task(quick()),
                 asyncio.create_task(stuck())]
        t0 = asyncio.get_running_loop().time()
        import time as _t
        await o._gather_with_grace(tasks, [P("a"), P("b"), P("gemini")], _t.monotonic(), emit)
        took = asyncio.get_running_loop().time() - t0
        return tasks, events, took

    tasks, events, took = asyncio.run(go())
    assert took < 2
    assert tasks[2].cancelled() and tasks[0].result() == "a"
    assert [e.provider_id for e in events if e.state == ProviderState.FAILED] == ["gemini"]
