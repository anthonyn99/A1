"""The straggler rule, and the one fan-out the council and Brainstorm share.

Phase S2 (2026-09-28). Three changes, each pinned here:

  * a short prompt gets a 90s grace floor instead of 180s -- replaying every
    stored run, that floor would have cut no real answer;
  * a unit whose text is still growing is never cut, whatever the grace says;
  * Brainstorm fans out through Orchestrator.gather, so a stuck member is cut
    and the round merges instead of waiting out a 20-minute hard timeout.

Timings are patched down to fractions of a second; the logic is the same.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from magi.engine import orchestrator as orch_mod
from magi.providers.base import Answer, ProviderEvent, ProviderState


class _Pacing:
    mode = "parallel"
    max_concurrency = 8

    def sample_inter_provider(self):
        return 0.0


class _Settings:
    pacing = _Pacing()


def _orch():
    o = orch_mod.Orchestrator.__new__(orch_mod.Orchestrator)
    o.settings = _Settings()
    o.db = None
    return o


def _ok(pid, text="an answer"):
    return Answer(pid, pid, text, True, ProviderState.DONE, chars=len(text))


class Quick:
    kind = "fake"
    accent = "#888"

    def __init__(self, pid, delay=0.01):
        self.id = self.display_name = pid
        self.delay = delay
        self.prompts = []

    async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
        self.prompts.append(question)
        await asyncio.sleep(self.delay)
        return _ok(self.id)


class Silent(Quick):
    """Thinks for ever and never shows a word -- the case the cut is for."""

    async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
        self.prompts.append(question)
        await asyncio.sleep(3600)


class Writing(Quick):
    """Slow, but its text keeps growing until it finishes."""

    def __init__(self, pid, write_for, step=0.05):
        super().__init__(pid)
        self.write_for, self.step = write_for, step

    async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
        self.prompts.append(question)
        text, end = "", time.monotonic() + self.write_for
        while time.monotonic() < end:
            await asyncio.sleep(self.step)
            text += "word "
            if on_event:
                await on_event(ProviderEvent(
                    provider_id=self.id, state=ProviderState.STREAMING,
                    partial_text=text, chars=len(text),
                ))
        return _ok(self.id, text)


@pytest.fixture
def fast(monkeypatch):
    monkeypatch.setattr(orch_mod, "CONTENTION_GAP_S", 0.0)
    monkeypatch.setattr(orch_mod, "STRAGGLER_GRACE_S", 0.3)
    monkeypatch.setattr(orch_mod, "STRAGGLER_GRACE_SHORT_S", 0.3)
    monkeypatch.setattr(orch_mod, "STILL_WRITING_S", 0.25)


def _gather(providers, prompts, events=None):
    async def emit(ev):
        if events is not None:
            events.append(ev)

    async def go():
        t0 = time.monotonic()
        out = await _orch().gather(providers, prompts, None, emit, asyncio.Event())
        return out, time.monotonic() - t0

    return asyncio.run(go())


def test_a_silent_straggler_is_cut(fast):
    events = []
    out, took = _gather([Quick("a"), Quick("b"), Silent("gemini")], "q", events)
    assert took < 1.5
    assert [a.ok for a in out] == [True, True, False]
    assert "Cut off" in out[2].error_detail
    assert [e.provider_id for e in events if e.state == ProviderState.FAILED] == ["gemini"]


def test_a_straggler_that_is_still_writing_is_not_cut(fast):
    """Grace 0.3s; the unit writes for 1.2s -- well past it -- and is kept."""
    out, took = _gather([Quick("a"), Quick("b"), Writing("chatgpt", 1.2)], "q")
    assert all(a.ok for a in out), [a.error_detail for a in out]
    assert out[2].text.count("word") > 10
    assert took >= 1.2


def test_a_unit_that_stops_writing_is_cut_after_the_extension(fast):
    """Growth buys STILL_WRITING_S at a time, not the rest of the run."""

    class Stalls(Writing):
        async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
            await super().ask(question, ctx=ctx, on_event=on_event, cancel=cancel)
            await asyncio.sleep(3600)

    out, took = _gather([Quick("a"), Quick("b"), Stalls("grok", 0.6)], "q")
    assert not out[2].ok and "Cut off" in out[2].error_detail
    assert 0.6 <= took < 2.0


def test_a_short_prompt_gets_the_short_floor(monkeypatch, fast):
    monkeypatch.setattr(orch_mod, "STRAGGLER_GRACE_S", 30.0)
    monkeypatch.setattr(orch_mod, "STRAGGLER_GRACE_SHORT_S", 0.3)
    out, took = _gather([Quick("a"), Silent("gemini")], "rank the top 5 mid laners")
    assert took < 1.5 and not out[1].ok


def test_a_long_prompt_keeps_the_long_floor(monkeypatch, fast):
    monkeypatch.setattr(orch_mod, "STRAGGLER_GRACE_S", 0.8)
    monkeypatch.setattr(orch_mod, "STRAGGLER_GRACE_SHORT_S", 0.1)
    long_prompt = "x" * orch_mod.SHORT_PROMPT_CHARS
    out, took = _gather([Quick("a"), Silent("gemini")], long_prompt)
    assert took >= 0.8 and not out[1].ok


def test_the_real_floors():
    assert orch_mod.STRAGGLER_GRACE_SHORT_S == 90.0
    assert orch_mod.STRAGGLER_GRACE_S == 180.0
    assert orch_mod.SHORT_PROMPT_CHARS == 600
    assert orch_mod.STILL_WRITING_S == 20.0


def test_each_member_gets_its_own_prompt(fast):
    a, b = Quick("a"), Quick("b")
    out, _ = _gather([a, b], {"a": "prompt for a", "b": "prompt for b"})
    assert a.prompts == ["prompt for a"] and b.prompts == ["prompt for b"]
    assert [x.provider_id for x in out] == ["a", "b"]


def test_per_member_prompts_use_the_longest_for_the_floor(monkeypatch, fast):
    """One long per-member prompt is enough to earn the long floor."""
    monkeypatch.setattr(orch_mod, "STRAGGLER_GRACE_S", 0.8)
    monkeypatch.setattr(orch_mod, "STRAGGLER_GRACE_SHORT_S", 0.1)
    prompts = {"a": "short", "gemini": "x" * 700}
    out, took = _gather([Quick("a"), Silent("gemini")], prompts)
    assert took >= 0.8


def test_a_member_that_raises_becomes_a_failed_answer(fast):
    class Boom(Quick):
        async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
            raise RuntimeError("browser crashed")

    out, _ = _gather([Quick("a"), Boom("b")], "q")
    assert out[0].ok and not out[1].ok
    assert "browser crashed" in out[1].error_detail


def test_on_answer_sees_every_answer_in_member_order(fast):
    seen = []

    async def go():
        async def on_answer(a):
            seen.append(a.provider_id)

        await _orch().gather(
            [Quick("a", 0.2), Quick("b", 0.01)], "q", None, None, None,
            on_answer=on_answer,
        )

    asyncio.run(go())
    assert seen == ["a", "b"]


# ── Brainstorm goes through it ───────────────────────────────────────────────

def test_a_stuck_brainstorm_member_is_cut_and_the_round_merges(
    monkeypatch, tmp_path, fast
):
    """The whole round route, with fake units: one never answers.

    Before S2 Brainstorm had its own fan-out with no straggler cut, so this
    round would have waited for the stuck unit's hard timeout.
    """
    from magi import app as app_mod
    from magi.db import Database

    members = [Quick("chatgpt"), Quick("claude"), Silent("gemini")]
    merged = {}

    async def fake_merge(chair, topic, turns, answers, ctx, *, critiques=None, cancel=None):
        merged["chair"] = chair.id
        merged["answers"] = [(a.provider_id, a.ok) for a in answers]
        merged["critics"] = sorted(c["provider_id"] for c in critiques or [])
        return "raw", {"questions": [], "blocking": []}, True, None, 5

    db = Database(tmp_path / "magi.db")

    async def go():
        await db.init()
        await db.create_session("s1", "plan a trip", [m.id for m in members])
        monkeypatch.setattr(app_mod, "db", db)
        monkeypatch.setattr(app_mod, "_reload_settings", lambda: None)
        monkeypatch.setattr(app_mod, "build_providers", lambda st, ids: members)
        monkeypatch.setattr(app_mod, "_session_attachments", lambda sid: [])
        monkeypatch.setattr(app_mod.brainstorm_engine, "merge_round", fake_merge)
        monkeypatch.setattr(app_mod.settings.pacing, "mode", "parallel")
        monkeypatch.setattr(app_mod.settings.pacing, "max_concurrency", 8)
        monkeypatch.setattr(app_mod.settings.pacing, "inter_provider_delay_s", (0.0, 0.0))

        async def no_wait(chair, timeout_s=8.0):
            return None

        monkeypatch.setattr(orch_mod.Orchestrator, "_await_profile_release",
                            lambda self, chair, timeout_s=8.0: no_wait(chair))

        t0 = time.monotonic()
        res = await app_mod.create_brainstorm_round("s1", reply="", answers="")
        job = app_mod._brainstorm_jobs[res["job_id"]]
        while not job["done"]:
            await asyncio.sleep(0.02)
            assert time.monotonic() - t0 < 10, "the round never finished"
        return job

    job = asyncio.run(go())
    assert job["result"] is not None, "the round merged"
    assert job["result"]["responded"] == 2 and job["result"]["total"] == 3
    assert merged["answers"] == [("chatgpt", True), ("claude", True), ("gemini", False)]
    assert merged["critics"] == ["chatgpt", "claude"], "the critique round ran too"
    assert job["providers"]["gemini"]["state"] == "failed"
