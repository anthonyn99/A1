-- quant-api, Phase 7 (the ticker dossier, the nightly ideas, FINRA short volume). Only ADDS, like every migration here.
-- (The spec named it 0006_dossier.sql; 0006 went to the backtests first.)

-- The dossier's parts (lib/dossier.js): one row per symbol and part (metric,
-- recommendation, surprises, calendar, insiders, target, estimates, sec), each
-- refreshed when older than its own time. `body` = the part's facts, JSON.
CREATE TABLE IF NOT EXISTS dossier_parts (
  symbol  TEXT NOT NULL,
  part    TEXT NOT NULL,
  at      INTEGER NOT NULL,   -- when it was fetched (ms)
  src     TEXT NOT NULL,      -- finnhub | nasdaq | sec | alphavantage
  body    TEXT NOT NULL,
  error   TEXT,
  PRIMARY KEY (symbol, part)
);

-- The nightly ideas (the runner's `ideas` job): the top 12 with their reasons,
-- the market stage and the accumulation plan. The newest is shown; 30 kept.
CREATE TABLE IF NOT EXISTS ideas (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  day   TEXT NOT NULL,        -- the New York day it was built for
  at    INTEGER NOT NULL,
  body  TEXT NOT NULL         -- JSON
);

-- FINRA's daily short volume for the watchlist (the runner reads the file;
-- the dossier reads these rows). 60 days kept.
CREATE TABLE IF NOT EXISTS short_volume (
  symbol  TEXT NOT NULL,
  day     TEXT NOT NULL,      -- YYYY-MM-DD
  short   INTEGER NOT NULL,
  total   INTEGER NOT NULL,
  PRIMARY KEY (symbol, day)
);
