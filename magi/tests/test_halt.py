"""Halt stops the run on the FIRST click.

Two halves, and both were broken in the same way -- by being slow enough to
look like nothing had happened.

THE ENGINE. Cancelling is cooperative: the orchestrator sets an event and a
provider acts on it where it safely can, which is before sending and on every
poll while it waits for an answer. That covers the long middle of a run and
nothing else. Launching Chrome, navigating, clearing a dialog and pasting the
prompt are all uninterruptible, and together they are most of the first thirty
seconds -- exactly when somebody presses Halt. So a halted four-member fan-out
meant waiting for four browsers to finish whatever phase they were in.

THE CONSOLE. It posted the cancel, awaited the response, and changed nothing:
units still said "thinking", the tone still pulsed, and the button still
offered to do the thing you had just asked for. The click looked like it had
missed, so people clicked again -- which is the report this fixes.
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.engine.orchestrator import Orchestrator  # noqa: E402
from magi.errors import FailureKind  # noqa: E402
from magi.providers.base import Answer  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")


class StubbornProvider:
    """A member in a phase that does not look at `cancel` -- a browser launch.

    This is not a strawman: browser_base checks the event before sending and
    then inside the completion poll, and nowhere in between.
    """

    id = "stubborn"
    display_name = "Stubborn"

    def __init__(self, seconds: float = 30.0):
        self.seconds = seconds
        self.started = asyncio.Event()
        self.finished = False
        self.cancelled = False

    async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
        self.started.set()
        try:
            await asyncio.sleep(self.seconds)
        except asyncio.CancelledError:
            # What tearing down the browser context looks like from here.
            self.cancelled = True
            raise
        self.finished = True
        return Answer.ok_answer("stubborn", "Stubborn", "late") \
            if hasattr(Answer, "ok_answer") else Answer.failed(
                "stubborn", "Stubborn", FailureKind.UNKNOWN, "unreachable")


@pytest.mark.asyncio
async def test_a_halt_interrupts_a_member_that_is_not_watching_for_it():
    cancel = asyncio.Event()
    p = StubbornProvider()
    task = asyncio.create_task(Orchestrator._ask(p, "q", None, None, cancel))
    await asyncio.wait_for(p.started.wait(), timeout=2)

    t0 = time.monotonic()
    cancel.set()
    answer = await asyncio.wait_for(task, timeout=2)
    took = time.monotonic() - t0

    assert took < 1.0, f"halting took {took:.2f}s; it must be immediate"
    assert p.cancelled, "the member's task was never actually cancelled"
    assert not p.finished, "it was allowed to run to the end of its phase"
    assert answer.ok is False
    assert answer.failure == FailureKind.CANCELLED


@pytest.mark.asyncio
async def test_a_halted_member_still_reports_what_happened_to_it():
    """A gap in the grid is worse than a unit that says it was halted."""
    cancel = asyncio.Event()
    cancel.set()
    answer = await asyncio.wait_for(
        Orchestrator._ask(StubbornProvider(), "q", None, None, cancel), timeout=2
    )
    assert answer.provider_id == "stubborn"
    assert "Halted" in (answer.error_detail or "") or "Halted" in (answer.text or "")


@pytest.mark.asyncio
async def test_a_member_that_finishes_first_is_untouched():
    """The race must not cost an answer that was already on its way."""
    class Quick(StubbornProvider):
        async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
            self.started.set()
            await asyncio.sleep(0.01)
            self.finished = True
            return Answer.failed("quick", "Quick", FailureKind.UNKNOWN, "done")

    p = Quick()
    answer = await asyncio.wait_for(
        Orchestrator._ask(p, "q", None, None, asyncio.Event()), timeout=2
    )
    assert p.finished and not p.cancelled
    assert answer.error_detail == "done", "the real answer came back, not a halt"


@pytest.mark.asyncio
async def test_the_waiter_never_outlives_the_ask():
    """A cancel-waiter left running per member is a leak per member."""
    before = len(asyncio.all_tasks())
    for _ in range(5):
        class Quick(StubbornProvider):
            async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
                return Answer.failed("q", "Q", FailureKind.UNKNOWN, "done")
        await Orchestrator._ask(Quick(), "q", None, None, asyncio.Event())
    await asyncio.sleep(0.05)
    assert len(asyncio.all_tasks()) <= before + 1


def test_both_fan_out_paths_go_through_it():
    """Sequential and concurrent -- a fix in one path only is half a fix."""
    src = (REPO / "magi" / "engine" / "orchestrator.py").read_text(encoding="utf-8")
    assert src.count("self._ask(p, question, ctx, emit, cancel)") == 2
    assert "await p.ask(question, ctx=ctx, on_event=emit, cancel=cancel)" in src, (
        "the uncancellable call should survive exactly once, inside _ask's "
        "no-cancel-event shortcut"
    )
    assert src.count("await p.ask(") == 1


# ── the console ──────────────────────────────────────────────────────────────

def _fn(name: str) -> str:
    at = PAGE.index(f"function {name}(")
    depth, start = 0, PAGE.index("{", PAGE.index(")", at))
    for i in range(start, len(PAGE)):
        if PAGE[i] == "{":
            depth += 1
        elif PAGE[i] == "}":
            depth -= 1
            if depth == 0:
                return PAGE[at:i + 1]
    raise AssertionError(name)


def test_the_click_does_not_wait_on_the_network():
    """Awaiting the POST is what made the first click look like a miss."""
    body = _fn("cancelRun")
    assert "await fetch" not in body, "the UI must not block on a round trip"
    assert "fetch(" in body and "/cancel" in body


def test_the_click_changes_the_console_immediately():
    body = _fn("cancelRun")
    assert "stopProcessingTone()" in body, "the tone stops with the click"
    assert 'p.state = "halted"' in body, "working units stop claiming to think"
    assert "updateEnabled()" in body


def test_a_second_click_is_not_needed_and_not_harmful():
    body = _fn("cancelRun")
    assert "if (!S.running || S.halting) return;" in body


def test_the_console_ends_the_run_even_if_the_engine_never_answers():
    body = _fn("cancelRun")
    assert "haltFallback" in body and "endRun()" in body
    assert _fn("endRun").count("clearTimeout(haltFallback)") == 1


def test_the_button_says_it_heard_you():
    src = PAGE[PAGE.index('show($("navHalt"), S.running);'):][:600]
    assert 'navHalt").disabled = S.halting' in src
    assert "Halting" in src


def test_halted_is_its_own_word():
    """Not "offline" (it was fine) and not "skipped" (it had started)."""
    assert 'halted: "halted"' in PAGE
