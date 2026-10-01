"""The chairman's model, like every member's (2026-10-01).

U2 put the model the site showed on every unit's answer, but the chairman's
turns -- a Deliberation verdict, a Brainstorm merge, the finished plan --
came back as plain tuples, so which model wrote them was the one thing on
screen with no chip. They are now `chairman.Synthesis` tuples: they unpack
exactly as before and also carry `.model` / `.model_fallback`.
"""

from __future__ import annotations

import asyncio
import sqlite3

from magi.db import Database
from magi.engine import brainstorm, chairman
from magi.providers.base import Answer, ProviderState

from test_followup import MEMBER, VERDICT, Unit, _orch


class ModelUnit(Unit):
    """A unit whose chairman answers say which model wrote them."""

    def __init__(self, pid, model="Gemini Flash", fallback="", **kw):
        super().__init__(pid, **kw)
        self.model, self.fallback = model, fallback

    async def ask(self, question, *, ctx=None, on_event=None, cancel=None):
        a = await super().ask(question, ctx=ctx, on_event=on_event, cancel=cancel)
        a.model, a.model_fallback = self.model, self.fallback
        return a


def _answer(text, model=""):
    a = Answer(provider_id="a", display_name="A", text=text, ok=True, state=ProviderState.DONE)
    a.model = model
    return a


class Chair:
    id, display_name = "gemini", "Gemini"

    def __init__(self, text, model="Gemini Flash", ok=True):
        self.text, self.model, self.ok = text, model, ok

    async def ask(self, prompt, *, ctx=None, on_event=None, cancel=None):
        if not self.ok:
            from magi.errors import FailureKind
            a = Answer.failed("gemini", "Gemini", FailureKind.UNKNOWN, "boom")
        else:
            a = _answer(self.text)
        a.model = self.model
        return a


def test_a_synthesis_unpacks_as_before_and_carries_the_model():
    s = asyncio.run(chairman.synthesize(Chair(VERDICT), "q?", [_answer(MEMBER), _answer(MEMBER)], None))
    text, ok, err, ms = s                      # the old four-tuple, unchanged
    assert ok and text == VERDICT and err is None and isinstance(ms, int)
    assert s.model == "Gemini Flash" and s.model_fallback == ""
    assert len(s) == 4


def test_a_failed_synthesis_still_says_which_model_it_was_on():
    s = asyncio.run(chairman.synthesize(Chair("", ok=False), "q?", [_answer(MEMBER)], None))
    assert s[1] is False and s.model == "Gemini Flash"


def test_the_run_result_names_the_chairs_model():
    a, b = ModelUnit("a", model="Sonnet 5.5 Medium"), ModelUnit("b")
    out = asyncio.run(_orch().run("q?", [a, b]))
    assert out["verdict"] == VERDICT
    assert out["chairman_model"] == "Sonnet 5.5 Medium"
    assert out["chairman_model_fallback"] == ""


def test_the_model_is_saved_with_the_synthesis(tmp_path):
    db = Database(tmp_path / "magi.db")
    asyncio.run(db.init())
    a, b = ModelUnit("a", model="Gemini Pro", fallback="Asked for Pro, got Flash"), ModelUnit("b")
    asyncio.run(_orch(db).run("q?", [a, b], run_id="r1"))
    syn = asyncio.run(db.get_run("r1"))["synthesis"]
    assert syn["model"] == "Gemini Pro" and syn["model_fallback"] == "Asked for Pro, got Flash"


def test_an_old_syntheses_table_is_migrated(tmp_path):
    path = tmp_path / "magi.db"
    con = sqlite3.connect(path)
    con.executescript("""CREATE TABLE syntheses(
      run_id TEXT PRIMARY KEY, chairman_provider TEXT NOT NULL, verdict_text TEXT,
      members_responded INTEGER, members_total INTEGER, ok INTEGER NOT NULL,
      error_detail TEXT, latency_ms INTEGER, created_at TEXT);""")
    con.commit()
    con.close()
    db = Database(path)
    asyncio.run(db.init())
    cols = {r[1] for r in sqlite3.connect(path).execute("PRAGMA table_info(syntheses)")}
    assert {"model", "model_fallback"} <= cols


def test_a_brainstorm_merge_and_plan_carry_the_model():
    merged = asyncio.run(brainstorm.merge_round(Chair("PLAN SO FAR\nx"), "topic", [], [], None))
    raw, parsed, ok, err, ms = merged
    assert ok and merged.model == "Gemini Flash"
    wrote = asyncio.run(brainstorm.write_plan(Chair("# Plan"), "topic", [], [], None))
    body, ok, err, ms = wrote
    assert ok and body == "# Plan" and wrote.model == "Gemini Flash"
