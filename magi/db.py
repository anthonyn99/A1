"""SQLite persistence. Every run is recorded, including the failures.

Failures are stored as first-class rows with their FailureKind, not as empty
answers, so history can honestly show "3 of 4 responded" months later.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite

from .providers.base import Answer

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN
    ('pending','running','synthesizing','complete','failed','cancelled')),
  created_at TEXT NOT NULL,
  started_at TEXT, ended_at TEXT, total_ms INTEGER,
  chairman_provider TEXT,
  responded_count INTEGER DEFAULT 0,
  attempted_count INTEGER DEFAULT 0,
  config_snapshot TEXT
);

CREATE TABLE IF NOT EXISTS answers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  display_name TEXT,
  provider_kind TEXT,
  state TEXT NOT NULL,
  ok INTEGER NOT NULL,
  answer_text TEXT,
  failure_kind TEXT,
  error_detail TEXT,
  completion_reason TEXT,
  low_confidence INTEGER DEFAULT 0,
  degraded INTEGER DEFAULT 0,
  degraded_reason TEXT,
  started_at TEXT, ended_at TEXT,
  latency_ms INTEGER, char_count INTEGER,
  artifacts TEXT,
  UNIQUE(run_id, provider_id)
);

CREATE TABLE IF NOT EXISTS syntheses(
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  chairman_provider TEXT NOT NULL,
  verdict_text TEXT,
  members_responded INTEGER,
  members_total INTEGER,
  ok INTEGER NOT NULL,
  error_detail TEXT,
  latency_ms INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS run_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  provider_id TEXT, state TEXT, message TEXT, payload TEXT
);

CREATE TABLE IF NOT EXISTS studio_artifacts(
  id TEXT PRIMARY KEY,                 -- job_id
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN
    ('audio','slides','mindmap','report','flashcards','quiz','table')),
  status TEXT NOT NULL CHECK(status IN
    ('pending','running','complete','failed')),
  provider_id TEXT,
  raw_text TEXT,
  parsed_json TEXT,
  error_detail TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL,
  ended_at TEXT
);

-- Brainstorm mode. Deliberately its own pair of tables rather than an
-- extension of runs/answers: a session is many turns per provider, which is
-- exactly what answers' UNIQUE(run_id, provider_id) forbids. Keeping them
-- separate leaves the one-shot council path -- and every existing row -- alone.
CREATE TABLE IF NOT EXISTS brainstorm_sessions(
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN
    ('active','finalizing','complete','failed','cancelled')),
  provider_ids TEXT,                   -- JSON array, frozen at creation
  plan_path TEXT,                      -- legacy: where finalise used to write
                                       -- the plan automatically. Now always
                                       -- NULL -- the plan is handed to the
                                       -- person to save where they choose.
                                       -- Kept so older rows keep their path.
  plan_md TEXT,                        -- the markdown itself, kept even if the
                                       -- file is later moved or deleted
  created_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS brainstorm_turns(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES brainstorm_sessions(id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL,
  -- Which try at this round number. A round that fails quorum is retried, and
  -- both attempts really happened -- overwriting the first would erase what
  -- the members actually said before the failure.
  attempt INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL CHECK(role IN ('user','council','critique','chairman')),
  provider_id TEXT,                    -- set for role='council'
  content TEXT,
  parsed_json TEXT,                    -- chairman turns: the parse_round dict
  -- What happened to this answer, kept so a failed or degraded member is
  -- still an honest row months later rather than an empty one.
  ok INTEGER,
  failure_kind TEXT,
  error_detail TEXT,
  degraded INTEGER DEFAULT 0,
  degraded_reason TEXT,
  latency_ms INTEGER,
  char_count INTEGER,
  -- 'round' | 'finalize': the finalise pass is a different kind of turn and
  -- should not read as just another round in the history.
  phase TEXT DEFAULT 'round',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_answers_run ON answers(run_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_run ON studio_artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_bs_turns ON brainstorm_turns(session_id, round_no, id);
CREATE INDEX IF NOT EXISTS idx_bs_created ON brainstorm_sessions(created_at DESC);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    async def init(self) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.executescript(SCHEMA)
            # CREATE TABLE IF NOT EXISTS does nothing to a table that already
            # exists, so columns added after a database was first created have
            # to be migrated in explicitly. Without this, every existing
            # install breaks on the next write with "no such column".
            cur = await db.execute("PRAGMA table_info(answers)")
            have = {r[1] for r in await cur.fetchall()}
            for col, ddl in (
                ("degraded", "INTEGER DEFAULT 0"),
                ("degraded_reason", "TEXT"),
            ):
                if col not in have:
                    await db.execute(f"ALTER TABLE answers ADD COLUMN {col} {ddl}")

            # Same for brainstorm_turns, whose retention columns were added
            # after the first sessions had already been recorded. Existing
            # rows keep their content and simply gain empty metadata -- a
            # turn recorded before the columns existed is still a real turn.
            cur = await db.execute("PRAGMA table_info(brainstorm_turns)")
            have = {r[1] for r in await cur.fetchall()}
            for col, ddl in (
                ("attempt", "INTEGER NOT NULL DEFAULT 1"),
                ("ok", "INTEGER"),
                ("failure_kind", "TEXT"),
                ("error_detail", "TEXT"),
                ("degraded", "INTEGER DEFAULT 0"),
                ("degraded_reason", "TEXT"),
                ("latency_ms", "INTEGER"),
                ("char_count", "INTEGER"),
                ("phase", "TEXT DEFAULT 'round'"),
            ):
                if col not in have:
                    await db.execute(
                        f"ALTER TABLE brainstorm_turns ADD COLUMN {col} {ddl}"
                    )

            # The `critique` role postdates the first databases, and a CHECK
            # constraint is part of the table definition -- ALTER TABLE cannot
            # widen it. Rebuilding is the only route, so it is done once, only
            # when the old constraint is actually present, and inside a
            # transaction: a half-migrated turn log would lose real session
            # history, which is the one thing this table exists to keep.
            cur = await db.execute(
                "SELECT sql FROM sqlite_master "
                "WHERE type='table' AND name='brainstorm_turns'"
            )
            row = await cur.fetchone()
            ddl_text = (row[0] if row else "") or ""
            if "critique" not in ddl_text and "CHECK(role IN" in ddl_text:
                cur = await db.execute("PRAGMA table_info(brainstorm_turns)")
                cols = [r[1] for r in await cur.fetchall()]
                col_list = ",".join(cols)
                await db.execute("PRAGMA foreign_keys=OFF")
                await db.execute("BEGIN")
                try:
                    await db.execute(
                        "CREATE TABLE brainstorm_turns_new("
                        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
                        "  session_id TEXT NOT NULL REFERENCES brainstorm_sessions(id)"
                        "    ON DELETE CASCADE,"
                        "  round_no INTEGER NOT NULL,"
                        "  attempt INTEGER NOT NULL DEFAULT 1,"
                        "  role TEXT NOT NULL CHECK(role IN"
                        "    ('user','council','critique','chairman')),"
                        "  provider_id TEXT,"
                        "  content TEXT,"
                        "  parsed_json TEXT,"
                        "  ok INTEGER,"
                        "  failure_kind TEXT,"
                        "  error_detail TEXT,"
                        "  degraded INTEGER DEFAULT 0,"
                        "  degraded_reason TEXT,"
                        "  latency_ms INTEGER,"
                        "  char_count INTEGER,"
                        "  phase TEXT DEFAULT 'round',"
                        "  created_at TEXT NOT NULL)"
                    )
                    await db.execute(
                        f"INSERT INTO brainstorm_turns_new({col_list}) "
                        f"SELECT {col_list} FROM brainstorm_turns"
                    )
                    await db.execute("DROP TABLE brainstorm_turns")
                    await db.execute(
                        "ALTER TABLE brainstorm_turns_new RENAME TO brainstorm_turns"
                    )
                    await db.execute(
                        "CREATE INDEX IF NOT EXISTS idx_bs_turns "
                        "ON brainstorm_turns(session_id, round_no, id)"
                    )
                    await db.execute("COMMIT")
                except Exception:
                    await db.execute("ROLLBACK")
                    raise
                finally:
                    await db.execute("PRAGMA foreign_keys=ON")

            await db.commit()

    async def create_run(self, run_id: str, question: str, chairman: str | None) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "INSERT INTO runs(id,question,status,created_at,started_at,chairman_provider) "
                "VALUES(?,?,'running',?,?,?)",
                (run_id, question, _now(), _now(), chairman),
            )
            await db.commit()

    async def save_answer(self, run_id: str, a: Answer) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                """INSERT OR REPLACE INTO answers(
                     run_id,provider_id,display_name,provider_kind,state,ok,answer_text,
                     failure_kind,error_detail,completion_reason,low_confidence,
                     degraded,degraded_reason,
                     started_at,ended_at,latency_ms,char_count,artifacts)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    run_id, a.provider_id, a.display_name, a.provider_kind,
                    str(a.state), 1 if a.ok else 0, a.text,
                    str(a.failure) if a.failure else None, a.error_detail,
                    a.completion_reason, 1 if a.low_confidence else 0,
                    1 if a.degraded else 0, a.degraded_reason or None,
                    a.started_at.isoformat(), a.ended_at.isoformat(),
                    a.latency_ms, a.chars, json.dumps(a.artifacts),
                ),
            )
            await db.commit()

    async def save_synthesis(
        self, run_id: str, chairman: str, text: str, responded: int,
        total: int, ok: bool, error: str | None, latency_ms: int,
    ) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                """INSERT OR REPLACE INTO syntheses(
                     run_id,chairman_provider,verdict_text,members_responded,
                     members_total,ok,error_detail,latency_ms,created_at)
                   VALUES(?,?,?,?,?,?,?,?,?)""",
                (run_id, chairman, text, responded, total,
                 1 if ok else 0, error, latency_ms, _now()),
            )
            await db.commit()

    async def finish_run(
        self, run_id: str, status: str, responded: int, attempted: int, total_ms: int
    ) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "UPDATE runs SET status=?,ended_at=?,total_ms=?,responded_count=?,"
                "attempted_count=? WHERE id=?",
                (status, _now(), total_ms, responded, attempted, run_id),
            )
            await db.commit()

    async def log_event(
        self, run_id: str, provider_id: str | None, state: str, message: str = ""
    ) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "INSERT INTO run_events(run_id,ts,provider_id,state,message) VALUES(?,?,?,?,?)",
                (run_id, _now(), provider_id, state, message),
            )
            await db.commit()

    async def get_run(self, run_id: str) -> dict | None:
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM runs WHERE id=?", (run_id,))
            run = await cur.fetchone()
            if not run:
                return None
            cur = await db.execute(
                "SELECT * FROM answers WHERE run_id=? ORDER BY id", (run_id,)
            )
            answers = [dict(r) for r in await cur.fetchall()]
            cur = await db.execute("SELECT * FROM syntheses WHERE run_id=?", (run_id,))
            syn = await cur.fetchone()
            return {
                "run": dict(run),
                "answers": answers,
                "synthesis": dict(syn) if syn else None,
            }

    async def delete_run(self, run_id: str) -> bool:
        """Forget a deliberation completely.

        Every child table is named explicitly rather than relying on cascade:
        SQLite enforces foreign keys only when PRAGMA foreign_keys is ON, which
        is per-connection and off by default, so a cascade that "works" in a
        test can silently leave orphans in production. Answers and syntheses
        are the whole point of deleting -- they are the model's full text --
        and a run row that is gone while its answers remain is a leak that
        nothing would ever surface again.

        Returns whether there was anything to delete, so the caller can tell
        "removed" from "was not there" instead of reporting success either way.
        """
        async with aiosqlite.connect(self.path) as db:
            cur = await db.execute("SELECT 1 FROM runs WHERE id=?", (run_id,))
            if not await cur.fetchone():
                return False
            for table in ("answers", "syntheses", "run_events", "studio_artifacts"):
                await db.execute(f"DELETE FROM {table} WHERE run_id=?", (run_id,))
            await db.execute("DELETE FROM runs WHERE id=?", (run_id,))
            await db.commit()
        return True

    async def list_runs(self, limit: int = 50, offset: int = 0) -> list[dict]:
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                "SELECT id,question,status,created_at,total_ms,responded_count,"
                "attempted_count FROM runs ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            )
            return [dict(r) for r in await cur.fetchall()]

    async def create_studio_artifact(
        self, job_id: str, run_id: str, kind: str, provider_id: str | None
    ) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "INSERT INTO studio_artifacts(id,run_id,kind,status,provider_id,created_at) "
                "VALUES(?,?,?,'pending',?,?)",
                (job_id, run_id, kind, provider_id, _now()),
            )
            await db.commit()

    async def finish_studio_artifact(
        self,
        job_id: str,
        status: str,
        *,
        raw_text: str | None = None,
        parsed_json: str | None = None,
        error_detail: str | None = None,
        latency_ms: int | None = None,
    ) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "UPDATE studio_artifacts SET status=?,raw_text=?,parsed_json=?,"
                "error_detail=?,latency_ms=?,ended_at=? WHERE id=?",
                (status, raw_text, parsed_json, error_detail, latency_ms, _now(), job_id),
            )
            await db.commit()

    async def get_studio_artifacts(self, run_id: str) -> list[dict]:
        """Latest artifact per kind for this run, newest first within a kind."""
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                "SELECT * FROM studio_artifacts WHERE run_id=? ORDER BY created_at DESC",
                (run_id,),
            )
            rows = [dict(r) for r in await cur.fetchall()]
        seen: set[str] = set()
        out: list[dict] = []
        for r in rows:
            if r["kind"] in seen:
                continue
            seen.add(r["kind"])
            out.append(r)
        return out

    async def get_studio_artifact(self, job_id: str) -> dict | None:
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                "SELECT * FROM studio_artifacts WHERE id=?", (job_id,)
            )
            row = await cur.fetchone()
            return dict(row) if row else None

    # ── brainstorm ──────────────────────────────────────────────────────────

    async def create_session(
        self, session_id: str, topic: str, provider_ids: list[str]
    ) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "INSERT INTO brainstorm_sessions(id,topic,status,provider_ids,created_at) "
                "VALUES(?,?,'active',?,?)",
                (session_id, topic, json.dumps(provider_ids), _now()),
            )
            await db.commit()

    async def add_turn(
        self,
        session_id: str,
        round_no: int,
        role: str,
        *,
        attempt: int = 1,
        provider_id: str | None = None,
        content: str | None = None,
        parsed_json: str | None = None,
        ok: bool | None = None,
        failure_kind: str | None = None,
        error_detail: str | None = None,
        degraded: bool = False,
        degraded_reason: str | None = None,
        latency_ms: int | None = None,
        char_count: int | None = None,
        phase: str = "round",
    ) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "INSERT INTO brainstorm_turns("
                "  session_id,round_no,attempt,role,provider_id,content,parsed_json,"
                "  ok,failure_kind,error_detail,degraded,degraded_reason,"
                "  latency_ms,char_count,phase,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    session_id, round_no, attempt, role, provider_id, content,
                    parsed_json,
                    None if ok is None else (1 if ok else 0),
                    failure_kind, error_detail,
                    1 if degraded else 0, degraded_reason,
                    latency_ms, char_count, phase, _now(),
                ),
            )
            await db.commit()

    async def next_attempt(self, session_id: str, round_no: int) -> int:
        """Which try this is at `round_no`.

        A round that fails quorum leaves its council turns behind and is then
        retried under the same number. Numbering the retry keeps both, so the
        history can show what the members said on the attempt that failed.
        """
        async with aiosqlite.connect(self.path) as db:
            cur = await db.execute(
                "SELECT COALESCE(MAX(attempt),0) FROM brainstorm_turns "
                "WHERE session_id=? AND round_no=?",
                (session_id, round_no),
            )
            row = await cur.fetchone()
            return int(row[0] or 0) + 1

    async def get_session(self, session_id: str) -> dict | None:
        """Session row plus every turn in order. Shaped like get_run."""
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                "SELECT * FROM brainstorm_sessions WHERE id=?", (session_id,)
            )
            session = await cur.fetchone()
            if not session:
                return None
            cur = await db.execute(
                "SELECT * FROM brainstorm_turns WHERE session_id=? "
                "ORDER BY round_no, attempt, id",
                (session_id,),
            )
            turns = [dict(r) for r in await cur.fetchall()]
            out = dict(session)
            if out.get("provider_ids"):
                try:
                    out["provider_ids"] = json.loads(out["provider_ids"])
                except (TypeError, ValueError):
                    out["provider_ids"] = []
            return {"session": out, "turns": turns}

    async def list_sessions(self, limit: int = 50, offset: int = 0) -> list[dict]:
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                "SELECT s.id, s.topic, s.status, s.created_at, s.ended_at, s.plan_path,"
                "  (SELECT COALESCE(MAX(round_no),0) FROM brainstorm_turns t"
                "     WHERE t.session_id=s.id) AS rounds "
                "FROM brainstorm_sessions s ORDER BY s.created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            )
            return [dict(r) for r in await cur.fetchall()]

    async def set_session_status(self, session_id: str, status: str) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "UPDATE brainstorm_sessions SET status=? WHERE id=?",
                (status, session_id),
            )
            await db.commit()

    async def finish_session(
        self,
        session_id: str,
        status: str,
        *,
        plan_path: str | None = None,
        plan_md: str | None = None,
    ) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "UPDATE brainstorm_sessions SET status=?,plan_path=?,plan_md=?,ended_at=? "
                "WHERE id=?",
                (status, plan_path, plan_md, _now(), session_id),
            )
            await db.commit()
