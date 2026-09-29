"""Brainstorm's phase line: what step a round or finalise job is on.

Phase S3 (2026-09-28). The console used to flip to "Merging…" on any state
event with a message, never showed the critique step, and went back to
"council" on reload. Now the engine says which step it is on -- a `phase`
event each time it moves, and the current one in the stream's `init`, so a
reload replays it. Pinned here on the real round and finalise routes with fake
units.
"""

from __future__ import annotations

import asyncio
import json
import time

from magi.engine import orchestrator as orch_mod
from magi.providers.base import Answer, ProviderState


class Quick:
    kind = "fake"
    accent = "#888"

    def __init__(self, pid, delay=0.01):
        self.id = self.display_name = pid
        self.delay = delay

    async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
        await asyncio.sleep(self.delay)
        return Answer(self.id, self.id, "an answer", True, ProviderState.DONE, chars=9)


def _setup(monkeypatch, tmp_path, members, seen):
    from magi import app as app_mod
    from magi.db import Database

    db = Database(tmp_path / "magi.db")

    async def init_frame(job_id):
        """What a console reloading right now would be told first."""
        resp = await app_mod.stream_brainstorm_job("s1", job_id)
        it = resp.body_iterator
        first = await it.__anext__()
        await it.aclose()
        return json.loads(first[len("data: "):])

    def job_id_now():
        return next(j for j, st in app_mod._brainstorm_jobs.items() if not st["done"])

    async def fake_merge(chair, topic, turns, answers, ctx, *, critiques=None, cancel=None):
        seen["merge_init"] = await init_frame(job_id_now())
        return "raw", {"questions": [], "blocking": []}, True, None, 5

    async def fake_write(chair, topic, turns, answers, ctx, *, critiques=None, cancel=None):
        seen["write_init"] = await init_frame(job_id_now())
        return "the plan", True, None, 5

    async def fake_review(chair, body, turns, answers, ctx, *, cancel=None):
        seen["review_init"] = await init_frame(job_id_now())
        return body, True, "", 5

    monkeypatch.setattr(app_mod, "db", db)
    monkeypatch.setattr(app_mod, "_reload_settings", lambda: None)
    monkeypatch.setattr(app_mod, "build_providers", lambda st, ids: members)
    monkeypatch.setattr(app_mod, "_session_attachments", lambda sid: [])
    monkeypatch.setattr(app_mod.brainstorm_engine, "merge_round", fake_merge)
    monkeypatch.setattr(app_mod.brainstorm_engine, "write_plan", fake_write)
    monkeypatch.setattr(app_mod.brainstorm_engine, "review_plan", fake_review)
    monkeypatch.setattr(app_mod.settings.pacing, "mode", "parallel")
    monkeypatch.setattr(app_mod.settings.pacing, "max_concurrency", 8)
    monkeypatch.setattr(app_mod.settings.pacing, "inter_provider_delay_s", (0.0, 0.0))
    monkeypatch.setattr(orch_mod, "CONTENTION_GAP_S", 0.0)

    async def no_wait(self, chair, timeout_s=8.0):
        return None

    monkeypatch.setattr(orch_mod.Orchestrator, "_await_profile_release", no_wait)
    return app_mod, db


async def _run_job(app_mod, start):
    """Start a job and collect every event it sends, as a live console would."""
    res = await start()
    job = app_mod._brainstorm_jobs[res["job_id"]]
    # The work task has not run yet (no await since create_task), so a
    # subscriber made here sees every event.
    sub = job["queue"].subscribe()
    events, t0 = [], time.monotonic()
    while True:
        item = await asyncio.wait_for(sub.get(), 10)
        if item.get("type") == "__eof__":
            break
        events.append(item)
        assert time.monotonic() - t0 < 10
    return job, events


def test_round_and_finalise_announce_every_step_and_replay_it(monkeypatch, tmp_path):
    members = [Quick("chatgpt"), Quick("claude"), Quick("gemini")]
    seen: dict = {}
    app_mod, db = _setup(monkeypatch, tmp_path, members, seen)

    async def go():
        await db.init()
        await db.create_session("s1", "plan a trip", [m.id for m in members])
        rj, rev = await _run_job(
            app_mod, lambda: app_mod.create_brainstorm_round("s1", reply="", answers=""))
        fj, fev = await _run_job(
            app_mod, lambda: app_mod.finalize_brainstorm("s1", reply="", answers=""))
        return rj, rev, fj, fev

    rj, rev, fj, fev = asyncio.run(go())
    assert rj["result"] and fj["result"], (rev[-1:], fev[-1:])

    phases = lambda evs: [e["phase"] for e in evs if e.get("type") == "phase"]
    assert phases(rev) == ["critique", "merging"]
    assert phases(fev) == ["critique", "writing", "reviewing"]

    # Every phase event comes before the step's own work: the merge phase is
    # announced before the chairman's "is merging" line.
    kinds = [e.get("phase") or e.get("message") for e in rev]
    assert kinds.index("merging") < next(
        i for i, k in enumerate(kinds) if isinstance(k, str) and "is merging" in k)

    # A reload mid-step is told the step it is really on.
    assert seen["merge_init"]["phase"] == "merging"
    assert seen["write_init"]["phase"] == "writing"
    assert seen["review_init"]["phase"] == "reviewing"
    assert rj["phase"] == "merging" and fj["phase"] == "reviewing"


def test_a_job_starts_in_the_council_phase(monkeypatch, tmp_path):
    """Before any member answers, a reload shows the members at work."""
    members = [Quick("chatgpt", delay=0.3), Quick("claude", delay=0.3)]
    seen: dict = {}
    app_mod, db = _setup(monkeypatch, tmp_path, members, seen)

    async def go():
        await db.init()
        await db.create_session("s1", "plan a trip", [m.id for m in members])
        res = await app_mod.create_brainstorm_round("s1", reply="", answers="")
        await asyncio.sleep(0.05)
        resp = await app_mod.stream_brainstorm_job("s1", res["job_id"])
        it = resp.body_iterator
        first = json.loads((await it.__anext__())[len("data: "):])
        await it.aclose()
        job = app_mod._brainstorm_jobs[res["job_id"]]
        while not job["done"]:
            await asyncio.sleep(0.02)
        return first

    first = asyncio.run(go())
    assert first["type"] == "init" and first["phase"] == "council"
