-- quant-api, Phase 13 (A1-Priv docs/TradeHub/quant/phase-13.md): macro, news and
-- options context. The spec named it 0009_context.sql; 0009 to 0011 were taken
-- by Phases 9 to 11. Only adds tables, like every migration here.

-- CBOE's delayed chain (15 min) per symbol, compacted (providers/options.js
-- compactChain): at most 2 CBOE calls a symbol a New York day (`calls`).
CREATE TABLE IF NOT EXISTS options_cache (
  symbol TEXT PRIMARY KEY,
  day TEXT NOT NULL,            -- New York day of the newest fetch
  at INTEGER NOT NULL,          -- when it was fetched (ms)
  calls INTEGER NOT NULL,       -- CBOE calls for this symbol on `day`
  body TEXT NOT NULL            -- the compact chain (JSON)
);

-- Our own log of each symbol's 30-day at-the-money IV, one row a day: IV rank
-- needs 60 days of it before it is shown.
CREATE TABLE IF NOT EXISTS iv_log (
  symbol TEXT NOT NULL,
  day TEXT NOT NULL,
  iv REAL NOT NULL,             -- a fraction (0.32 = 32%)
  PRIMARY KEY (symbol, day)
);

-- Rates, credit, the dollar and oil from FRED (no key: fredgraph.csv), one row
-- per series, refreshed at most every 6 hours.
CREATE TABLE IF NOT EXISTS macro_series (
  id TEXT PRIMARY KEY,          -- the FRED series id (DGS10, BAMLH0A0HYM2…)
  at INTEGER NOT NULL,
  body TEXT NOT NULL            -- [[day, value]…] oldest first, about 400 days
);

-- Earnings history from Nasdaq's free calendar, by date (no key). One request
-- per trading day; `earnings_days` records each day asked, so the backfill is
-- resumable and never asks a day twice.
CREATE TABLE IF NOT EXISTS earnings (
  symbol TEXT NOT NULL,
  day TEXT NOT NULL,
  time TEXT,                    -- bmo | amc | null (not supplied)
  eps REAL,
  est REAL,
  PRIMARY KEY (symbol, day)
);
CREATE INDEX IF NOT EXISTS earnings_day ON earnings (day);
CREATE TABLE IF NOT EXISTS earnings_days (
  day TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  n INTEGER NOT NULL            -- reports that day (0 = asked, none)
);
