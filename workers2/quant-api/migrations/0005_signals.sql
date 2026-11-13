-- quant-api, Phase 5 (the scanner's ledger). Only ADDS, like every migration here.
-- (The spec named it 0004_signals.sql; 0004 went to the Charts tab first.)

-- Every signal the scanner made, taken or not, and what happened to it.
-- `id` = a hash of symbol, setup and bar time, so the same bar never makes two
-- rows: a second POST of it is ignored (ON CONFLICT DO NOTHING writes nothing).
-- The columns the routes filter or sort on are their own; the rest of the
-- signal (zone, stop, targets, factors, reasons...) is `body`, its grade `grade`.
-- One index only: each index is one more row written per insert.
CREATE TABLE IF NOT EXISTS signals (
  id        TEXT PRIMARY KEY,
  symbol    TEXT NOT NULL,
  setup     TEXT NOT NULL,
  horizon   TEXT NOT NULL,     -- 'day' | 'swing'
  dir       TEXT NOT NULL,     -- 'long' | 'short'
  at        INTEGER NOT NULL,  -- the signal bar's opening time (ms)
  expires   INTEGER NOT NULL,  -- ms
  verdict   TEXT NOT NULL,     -- 'GO' | 'WATCH' | 'NO-GO'
  score     REAL,
  regime    TEXT,
  by        TEXT,              -- 'page' | 'runner'
  created   INTEGER NOT NULL,  -- when it was stored (ms)
  status    TEXT NOT NULL DEFAULT 'open',   -- open | triggered | target1 | target2 | stopped | expired
  done      INTEGER NOT NULL DEFAULT 0,     -- 1 once its grade can no longer change
  r         REAL,              -- the result in R (null: never entered)
  taken     TEXT,              -- the journal trade it became, when Tony took it
  graded_at INTEGER,
  body      TEXT NOT NULL,     -- the rest of the signal, JSON
  grade     TEXT               -- the grade, JSON
);
CREATE INDEX IF NOT EXISTS signals_at ON signals (at);
