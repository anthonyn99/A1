-- Neo Cortex N5 (A1-Priv docs/TradeHub/quant/n4-05.md): strategy lifecycle and the learning loop. Additive.
-- A decision's bar (the replay compares fires bar by bar) and whether the entry rule fired (a skip after a fire
-- is still a decision; a skip before it, such as stale data, is not).
ALTER TABLE bot_events ADD COLUMN bar_time INTEGER;
ALTER TABLE bot_events ADD COLUMN fired INTEGER;

-- One row per strategy version: where it is in its life and the numbers the rules read.
CREATE TABLE IF NOT EXISTS strategy_life (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  stage TEXT NOT NULL,
  since INTEGER NOT NULL,           -- when it entered this stage
  prior_stage TEXT,                 -- the stage a pause returns to
  shadow_day TEXT,                  -- the session it is shadowing
  shadow_fails INTEGER NOT NULL DEFAULT 0,
  paper_days INTEGER NOT NULL DEFAULT 0,
  last_day TEXT,                    -- the last session counted in paper_days
  trades INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  gross_win REAL NOT NULL DEFAULT 0,
  gross_loss REAL NOT NULL DEFAULT 0,
  sum_r REAL NOT NULL DEFAULT 0,
  r_trades INTEGER NOT NULL DEFAULT 0,
  pnl REAL NOT NULL DEFAULT 0,
  peak REAL NOT NULL DEFAULT 0,
  signals INTEGER NOT NULL DEFAULT 0,  -- replay: bars where either side fired, all sessions
  matched INTEGER NOT NULL DEFAULT 0,
  conviction REAL NOT NULL DEFAULT 0,
  why TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);

-- The daily review runs once per session; a replay verdict once per strategy version and day.
CREATE TABLE IF NOT EXISTS bot_reviews (
  day TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_replays (
  day TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  at INTEGER NOT NULL,
  signals INTEGER NOT NULL,
  matched INTEGER NOT NULL,
  missed_live INTEGER NOT NULL,
  extra_live INTEGER NOT NULL,
  notes TEXT,
  PRIMARY KEY (day, id, version)
);
