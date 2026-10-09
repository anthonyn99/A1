"""Track F1: Deliberation follow-ups and mid-run notes, engine side.

A follow-up carries the conversation so far (the console sends it; the engine
replays it into every unit's prompt and the chairman's), and a note typed
while a run is going lands in exactly one of two places: the verdict, if
synthesis has not started, or the next follow-up.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from types import SimpleNamespace

import pytest

from magi.db import Database
from magi.engine import chairman, session
from magi.engine import orchestrator as orch_mod
from magi.engine.orchestrator import Orchestrator
from magi.engine.validate import MAX_REFERENCE_WORDS, Rejection, _words, validate_answer
from magi.providers.base import Answer, Provider, ProviderState

VERDICT = "ANSWER\nThe merged answer.\n\nNOTES\nNone.\n\nCONFIDENCE\nHIGH -- they agree."
MEMBER = (
    "Uranus has thirteen known rings, darker and narrower than Saturn's, "
    "found in 1977 by stellar occultation and later imaged by Voyager 2. "
) * 3


def _turns(n, answer_len=200):
    return [
        {"q": f"question number {i + 1}", "answer": f"answer{i + 1} " + "x" * answer_len}
        for i in range(n)
    ]


# ── the context block ───────────────────────────────────────────────────────


def test_everything_fits_whole_in_order():
    out = session.build_context(_turns(3), 10_000)
    assert out.startswith(session.HEADER)
    assert out.index("question number 1") < out.index("question number 2") < out.index("question number 3")
    assert "omitted" not in out and "trimmed" not in out
    assert out.count("ANSWER:") == 3


def test_older_answers_are_trimmed_before_the_newest():
    turns = _turns(3, answer_len=9_000)
    out = session.build_context(turns, 16_000)
    assert len(out) <= 16_000
    newest = turns[-1]["answer"]
    assert newest in out, "the newest turn must be kept whole while anything can be"
    assert "characters trimmed for length" in out
    assert "question number 1" in out


def test_oldest_turns_drop_to_questions_then_are_omitted():
    turns = _turns(30, answer_len=3_000)
    out = session.build_context(turns, 3_800)
    assert len(out) <= 3_800
    assert turns[-1]["answer"] in out
    assert "earlier turns omitted]" in out
    assert "question number 30" in out
    assert "question number 1\n" not in out


@pytest.mark.parametrize("budget", [500, 2_500, 7_000, 24_000])
@pytest.mark.parametrize("n,alen", [(1, 50_000), (4, 20_000), (40, 800)])
def test_the_budget_always_holds(budget, n, alen):
    assert len(session.build_context(_turns(n, alen), budget)) <= budget


def test_no_turns_no_block():
    assert session.build_context([], 10_000) == ""
    assert session.prompt_with_context("hi", [], 10_000) == "hi"
    assert session.build_context(_turns(2), 0) == ""


def test_the_prompt_is_the_block_then_the_new_message():
    p = session.prompt_with_context("and the second one?", _turns(1), 10_000)
    assert p.startswith(session.HEADER)
    assert p.endswith(session.NEW_MESSAGE + "and the second one?")


def test_the_answer_section_drops_notes_and_confidence():
    assert session.answer_section(VERDICT) == "The merged answer."
    assert session.answer_section("A sole unit's answer.") == "A sole unit's answer."


def test_budget_leaves_room_for_the_question():
    assert session.budget_for("claude", "q") == session.MAX_CONTEXT_CHARS
    q = "x" * 30_000
    assert session.budget_for("chatgpt", q) == 50_000 - 30_000 - session.CONTEXT_RESERVE
    assert session.budget_for("chatgpt", "x" * 60_000) == 0


def test_parse_context_validates():
    turns = session.parse_context(json.dumps([{"q": "one", "answer": VERDICT}, {"q": " ", "answer": "x"}]))
    assert turns == [{"q": "one", "answer": "The merged answer."}]
    assert session.parse_context("") == []
    for bad in ("{", '{"q":1}', "[1]", '[{"q": 1, "answer": ""}]',
                "x" * (session.MAX_CONTEXT_INPUT + 1)):
        with pytest.raises(ValueError):
            session.parse_context(bad)


def test_session_ids():
    assert session.valid_session_id("a1b2c3d4e5f6")
    assert not session.valid_session_id("../etc")
    assert not session.valid_session_id("x" * 65)


# ── OFF_TOPIC against the reference ─────────────────────────────────────────


def test_a_short_follow_up_answer_survives_against_the_reference():
    turns = [{"q": "Does Uranus have rings?", "answer": "Yes. Uranus has thirteen known rings."}]
    q = "Which scientists discovered those, what year?"
    ans = (
        "They were found in 1977 by James Elliot, Edward Dunham and Jessica "
        "Mink, watching a star dim before and after the planet passed in "
        "front of it. Voyager 2 later imaged them directly in 1986 and found "
        "two more, bringing the known total to thirteen."
    ) * 2
    against_question = validate_answer(ans, q)
    assert not against_question.ok and against_question.reason == Rejection.OFF_TOPIC
    assert validate_answer(ans, session.reference(q, turns)).ok


def test_the_reference_keeps_the_check_on():
    """Past MAX_REFERENCE_WORDS `_overlap` stops judging; the reference must not get there."""
    turns = _turns(20, 0)
    turns[-1]["answer"] = " ".join(f"word{i}" for i in range(2_000))
    ref = session.reference("brand new question here", turns)
    assert len(_words(ref)) <= MAX_REFERENCE_WORDS
    assert ref.startswith("brand new question here")
    assert "question number 20" in ref


def test_browser_units_validate_against_the_reference():
    from pathlib import Path

    src = (Path(session.__file__).parents[1] / "providers" / "browser_base.py").read_text(encoding="utf-8")
    assert "ctx.reference or ctx.question or question" in src


# ── the chairman ────────────────────────────────────────────────────────────


def _ok(pid, text):
    return Answer(provider_id=pid, display_name=pid.title(), text=text, ok=True, state=ProviderState.DONE)


def test_empty_blocks_leave_the_prompt_unchanged():
    answers = [_ok("a", MEMBER), _ok("b", MEMBER)]
    base = chairman.build_prompt("q?", answers)
    assert chairman.build_prompt("q?", answers, context="", additions=[]) == base
    assert "EARLIER IN THIS CONVERSATION" not in base and "ADDED BY THE PERSON" not in base


def test_context_and_additions_reach_the_chairman():
    answers = [_ok("a", MEMBER), _ok("b", MEMBER)]
    p = chairman.build_prompt("q?", answers, context="CTX BLOCK", additions=["make it shorter", "in French"])
    assert p.index("EARLIER IN THIS CONVERSATION") < p.index("CTX BLOCK") < p.index("THE QUESTION")
    assert p.index("THE QUESTION") < p.index("ADDED BY THE PERSON") < p.index("COUNCIL RESPONSES")
    assert "- make it shorter\n- in French" in p


@pytest.mark.parametrize("pid", ["chatgpt", "claude", "gemini"])
def test_the_chairman_prompt_stays_within_its_cap(pid):
    cap = chairman.prompt_budget(pid)
    answers = [_ok(f"u{i}", "y" * 30_000) for i in range(5)]
    ctx = session.build_context(_turns(6, 8_000), session.budget_for(pid, "q?"))
    p = chairman.build_prompt("q?", answers, max_chars=cap, context=ctx, additions=["n" * 4_000])
    assert len(p) <= cap


def test_the_context_gives_way_before_the_answers():
    answers = [_ok("a", "A" * 20_000), _ok("b", "B" * 20_000)]
    ctx = "C" * 20_000
    p = chairman.build_prompt("q?", answers, max_chars=50_000, context=ctx)
    assert len(p) <= 50_000
    assert "A" * 20_000 in p and "B" * 20_000 in p, "answers were cut while context was kept"
    tight = chairman.build_prompt("q?", answers, max_chars=42_500, context=ctx)
    assert "EARLIER IN THIS CONVERSATION" not in tight


# ── notes: Steer ────────────────────────────────────────────────────────────


def test_a_note_lands_in_exactly_one_bucket():
    s = session.Steer()
    assert s.add("before") == "verdict"
    snap = s.close_gather()
    assert s.add("after") == "followup"
    s.finish()
    assert s.add("late") == "followup"
    assert snap == ["before"] and s.followup == ["after", "late"]


def test_note_limits():
    s = session.Steer()
    with pytest.raises(ValueError):
        s.add("   ")
    with pytest.raises(ValueError):
        s.add("x" * (session.MAX_NOTE_CHARS + 1))
    for i in range(session.MAX_NOTES):
        s.add(f"n{i}")
    with pytest.raises(OverflowError):
        s.add("one too many")


# ── the orchestrator ────────────────────────────────────────────────────────


class Unit(Provider):
    kind = "api"
    accent = "#888"

    def __init__(self, pid, text=MEMBER, on_member=None, on_chair=None, fail=False):
        self.id = pid
        self.display_name = pid.title()
        self.text, self.on_member, self.on_chair, self.fail = text, on_member, on_chair, fail
        self.prompts, self.chair_prompts, self.ctxs = [], [], []

    async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
        self.ctxs.append(ctx)
        if question.startswith("You are the chairman"):
            self.chair_prompts.append(question)
            if self.on_chair:
                self.on_chair()
            return _ok(self.id, VERDICT)
        self.prompts.append(question)
        if self.on_member:
            self.on_member()
        if self.fail:
            from magi.errors import FailureKind

            return Answer.failed(self.id, self.display_name, FailureKind.UNKNOWN, "boom")
        return _ok(self.id, self.text)

    async def health_check(self, *, deep=False):
        raise NotImplementedError


def _orch(db=None, mode="sequential"):
    settings = SimpleNamespace(
        chairman=SimpleNamespace(provider_id="a", fallback_order=[], min_members=2),
        pacing=SimpleNamespace(mode=mode, max_concurrency=8, sample_inter_provider=lambda: 0),
    )
    return Orchestrator(settings, db)


def test_a_follow_up_replays_the_conversation_to_every_unit_and_the_chair():
    a, b = Unit("a"), Unit("b")
    turns = [{"q": "Does Uranus have rings?", "answer": "Yes, thirteen."}]
    out = asyncio.run(_orch().run("When were they found?", [a, b], context=turns, session_id="s1", turn=2))
    for u in (a, b):
        assert u.prompts[0].startswith(session.HEADER)
        assert "Does Uranus have rings?" in u.prompts[0]
        assert u.prompts[0].endswith(session.NEW_MESSAGE + "When were they found?")
        assert u.ctxs[0].question == "When were they found?"
        assert "Does Uranus have rings?" in u.ctxs[0].reference
    assert "EARLIER IN THIS CONVERSATION" in a.chair_prompts[0]
    assert "Yes, thirteen." in a.chair_prompts[0]
    assert out["session_id"] == "s1" and out["turn"] == 2


def test_a_first_turn_is_unchanged():
    a, b = Unit("a"), Unit("b")
    out = asyncio.run(_orch().run("Does Uranus have rings?", [a, b], run_id="r1"))
    assert a.prompts == ["Does Uranus have rings?"]
    assert a.ctxs[0].reference == ""
    assert "EARLIER IN THIS CONVERSATION" not in a.chair_prompts[0]
    assert out["session_id"] == "r1" and out["turn"] == 1
    assert out["notes"] == out["followup_notes"] == out["unapplied_notes"] == []


def test_notes_during_gather_reach_the_verdict_later_ones_are_held():
    steer = session.Steer()
    a = Unit("a", on_member=lambda: steer.add("use metric units"),
             on_chair=lambda: steer.add("also compare to Saturn"))
    b = Unit("b")
    out = asyncio.run(_orch().run("How big are they?", [a, b], steer=steer))
    assert "use metric units" in a.chair_prompts[0]
    assert "also compare to Saturn" not in a.chair_prompts[0]
    assert out["notes"] == ["use metric units"]
    assert out["followup_notes"] == ["also compare to Saturn"]
    assert out["unapplied_notes"] == []
    assert steer.phase == "done"


def test_a_sole_responder_with_notes_goes_through_synthesis():
    steer = session.Steer()
    a = Unit("a", text="The one answer. " * 20, on_member=lambda: steer.add("shorter please"))
    out = asyncio.run(_orch().run("q?", [a], steer=steer))
    assert len(a.chair_prompts) == 1 and "shorter please" in a.chair_prompts[0]
    assert out["verdict"] == VERDICT and out["notes"] == ["shorter please"]


def test_a_sole_responder_without_notes_keeps_the_shortcut():
    a = Unit("a", text="The one answer. " * 20)
    out = asyncio.run(_orch().run("q?", [a], steer=session.Steer()))
    assert a.chair_prompts == [] and out["verdict"] == a.text


def test_notes_that_could_not_be_applied_come_back():
    steer = session.Steer()
    a = Unit("a", on_member=lambda: steer.add("in French"))
    b, c = Unit("b", fail=True), Unit("c", fail=True)
    out = asyncio.run(_orch().run("q?", [a, b, c], steer=steer))
    assert not out["synthesis_ok"]
    assert out["notes"] == [] and out["unapplied_notes"] == ["in French"]


def test_the_straggler_floor_is_measured_on_the_new_question(monkeypatch):
    """A one-line follow-up padded with 20k of context keeps the short floor."""
    seen = {}
    real = orch_mod.Orchestrator._gather_with_grace

    async def spy(self, tasks, providers, t0, emit, *, floor=None, grew=None):
        seen["floor"] = floor
        return await real(self, tasks, providers, t0, emit, floor=floor, grew=grew)

    monkeypatch.setattr(orch_mod.Orchestrator, "_gather_with_grace", spy)
    turns = _turns(3, answer_len=6_000)
    a, b = Unit("a"), Unit("b")
    asyncio.run(_orch(mode="parallel").run("why?", [a, b], context=turns))
    assert len(a.prompts[0]) > orch_mod.SHORT_PROMPT_CHARS
    assert seen["floor"] == orch_mod.STRAGGLER_GRACE_SHORT_S


# ── the database ────────────────────────────────────────────────────────────


OLD_RUNS = """CREATE TABLE runs(
  id TEXT PRIMARY KEY, question TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN
    ('pending','running','synthesizing','complete','failed','cancelled')),
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, total_ms INTEGER,
  chairman_provider TEXT, responded_count INTEGER DEFAULT 0,
  attempted_count INTEGER DEFAULT 0, config_snapshot TEXT);
INSERT INTO runs(id,question,status,created_at) VALUES('old1','old q','complete','2026-09-01');
"""


def test_an_old_database_is_migrated(tmp_path):
    path = tmp_path / "magi.db"
    con = sqlite3.connect(path)
    con.executescript(OLD_RUNS)
    con.commit()
    con.close()

    db = Database(path)

    async def go():
        await db.init()
        await db.create_run("new1", "follow up", "a", session_id="old1", turn=2)
        await db.finish_run("new1", "complete", 2, 2, 10, notes={"applied": ["x"]})
        return await db.get_run("old1"), await db.get_run("new1"), await db.list_runs()

    old, new, rows = asyncio.run(go())
    assert old["run"]["session_id"] is None and old["run"]["notes"] is None
    assert new["run"]["session_id"] == "old1" and new["run"]["turn"] == 2
    assert new["run"]["notes"] == {"applied": ["x"]}
    assert {r["id"]: r["turn"] for r in rows} == {"old1": None, "new1": 2}


def test_a_run_with_a_db_records_its_session(tmp_path):
    db = Database(tmp_path / "magi.db")
    asyncio.run(db.init())
    steer = session.Steer()
    a, b = Unit("a", on_member=lambda: steer.add("note one")), Unit("b")
    asyncio.run(_orch(db).run("q?", [a, b], run_id="r2", session_id="s9", turn=3, steer=steer))
    row = asyncio.run(db.get_run("r2"))["run"]
    assert (row["session_id"], row["turn"]) == ("s9", 3)
    assert row["notes"]["applied"] == ["note one"]


# ── the routes ──────────────────────────────────────────────────────────────


@pytest.fixture
def api(tmp_path, monkeypatch):
    from starlette.testclient import TestClient

    from magi import app as app_mod
    from magi import settings as S

    monkeypatch.delenv(S.api_token_env(), raising=False)
    monkeypatch.setattr(app_mod, "_runs", {})
    return TestClient(app_mod.app, raise_server_exceptions=False), app_mod


def _live(app_mod, rid, question="q?", providers=("a",), session_in=""):
    from magi.fanout import Broadcast

    st = {
        "queue": Broadcast(), "cancel": asyncio.Event(), "done": False,
        "question": question, "session_in": session_in,
        "session": session_in or rid, "turn": 1, "steer": session.Steer(),
        "notes": [], "providers": {p: {} for p in providers}, "result": None,
    }
    app_mod._runs[rid] = st
    return st


def test_a_note_route_applies_then_holds(api):
    client, app_mod = api
    st = _live(app_mod, "r1")
    r = client.post("/api/runs/r1/note", json={"text": "  in French  "})
    assert r.status_code == 200 and r.json() == {"text": "in French", "applied": "verdict", "id": "n1"}
    st["steer"].close_gather()
    assert client.post("/api/runs/r1/note", json={"text": "later"}).json()["applied"] == "followup"
    assert [n["applied"] for n in st["notes"]] == ["verdict", "followup"]
    st["done"] = True
    assert client.post("/api/runs/r1/note", json={"text": "after"}).json()["applied"] == "followup"
    assert len(st["notes"]) == 2


def test_the_note_route_refuses_bad_input(api):
    client, app_mod = api
    st = _live(app_mod, "r1")
    assert client.post("/api/runs/nope/note", json={"text": "x"}).status_code == 404
    assert client.post("/api/runs/r1/note", json={}).status_code == 400
    assert client.post("/api/runs/r1/note", json={"text": " "}).status_code == 400
    assert client.post("/api/runs/r1/note", json={"text": "x" * 5000}).status_code == 400
    for i in range(session.MAX_NOTES):
        st["steer"].add(f"n{i}")
    assert client.post("/api/runs/r1/note", json={"text": "x"}).status_code == 429


def test_create_run_refuses_a_bad_context_or_session(api):
    client, _ = api
    r = client.post("/api/runs", data={"question": "q?", "context": "{nope"})
    assert r.status_code == 400 and "JSON" in r.text
    r = client.post("/api/runs", data={"question": "q?", "session": "../x"})
    assert r.status_code == 400


def test_the_live_twin_keys_on_the_session(api):
    _, app_mod = api
    _live(app_mod, "r1", "why?", ("a", "b"), session_in="")
    _live(app_mod, "r2", "why?", ("a", "b"), session_in="sessA")
    assert app_mod._live_twin("why?", ["a", "b"]) == "r1"
    assert app_mod._live_twin("why?", ["b", "a"], "sessA") == "r2"
    assert app_mod._live_twin("why?", ["a", "b"], "sessB") is None


def test_health_advertises_the_features(api):
    client, _ = api
    assert {"followup", "steer"} <= set(client.get("/api/health").json()["features"])


# ── notes: edit, remove, Interrupt now ─────────────────────────────────────


def test_a_note_can_be_edited_or_removed_until_synthesis_takes_it():
    s = session.Steer()
    closed = []
    s.on_close = lambda: closed.append(1)
    s.add("in metric")
    s.add("and briefly")
    assert s.edit("n1", "in metric units") and s.remove("n2")
    assert s.notes == ["in metric units"]
    assert s.close_gather() == ["in metric units"] and closed == [1]
    assert not s.edit("n1", "x") and not s.remove("n1"), "the chairman has it"


def test_interrupt_now_needs_a_note_and_works_once():
    s = session.Steer()
    assert not s.interrupt_now(), "no note to re-ask with"
    s.add("in French")
    assert s.interrupt_now() and s.interrupt.is_set()
    assert not s.interrupt_now(), "once per run"


def test_interrupt_now_reasks_only_the_members_still_answering():
    """`a` had finished; `b` was stopped mid-answer and is asked again, once,
    with what it had written and the note -- which also reaches the chair."""
    steer = session.Steer()

    class Stoppable(Unit):
        async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
            if question.startswith("You are the chairman") or len(self.prompts):
                return await super().ask(question, ctx=ctx, on_event=on_event, cancel=cancel)
            self.prompts.append(question)
            self.ctxs.append(ctx)
            steer.add("in French")
            assert steer.interrupt_now()
            assert ctx.interrupt is steer.interrupt
            a = _ok(self.id, "Uranus has thir")
            a.ok, a.interrupted = False, True
            return a

    a, b = Unit("a"), Stoppable("b")
    out = asyncio.run(_orch().run("Does Uranus have rings?", [a, b], steer=steer))
    assert len(a.prompts) == 1, "a finished member is not asked again"
    assert len(b.prompts) == 2
    assert "Uranus has thir" in b.prompts[1] and "- in French" in b.prompts[1]
    assert b.ctxs[1].interrupt is None, "the re-ask cannot be interrupted again"
    assert "in French" in b.ctxs[1].reference, "checked against the notes too"
    # Found live: the chair got the same context, saw Interrupt now set and
    # stopped before sending -- every chair failed.
    assert a.chair_prompts and a.ctxs[-1].interrupt is None
    assert out["responded"] == 2 and "in French" in a.chair_prompts[0]


def test_note_routes_edit_remove_and_interrupt(api):
    client, app_mod = api
    st = _live(app_mod, "r1")
    assert client.post("/api/runs/r1/interrupt").status_code == 409, "no note yet"
    nid = client.post("/api/runs/r1/note", json={"text": "in French"}).json()["id"]
    r = client.post(f"/api/runs/r1/note/{nid}/edit", json={"text": "in German"})
    assert r.status_code == 200 and st["notes"][0]["text"] == "in German"
    assert client.post("/api/runs/r1/interrupt").json() == {"interrupted": True}
    assert st["steer"].interrupt.is_set()
    assert client.post("/api/runs/r1/interrupt").status_code == 409, "once per run"
    nid2 = client.post("/api/runs/r1/note", json={"text": "drop me"}).json()["id"]
    assert client.post(f"/api/runs/r1/note/{nid2}/remove").status_code == 200
    assert [n["text"] for n in st["notes"]] == ["in German"]
    st["steer"].close_gather()
    assert client.post(f"/api/runs/r1/note/{nid}/edit", json={"text": "x"}).status_code == 409
    assert client.post(f"/api/runs/r1/note/{nid}/remove").status_code == 409
    feats = set(client.get("/api/health").json()["features"])
    assert {"note_edit", "note_interrupt"} <= feats
