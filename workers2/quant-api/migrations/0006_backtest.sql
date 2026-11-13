-- quant-api, Phase 6 (backtests, calibration, paper trades). Only ADDS, like every migration here.
-- (The spec named it 0005_backtest.sql; 0005 went to the scanner's ledger first.)

-- The weekly setups backtest's calibration table (A1-Priv TradeHub/core/fit.js):
-- per setup and regime bucket the measured n, hit rate, average win and loss,
-- EV and its interval, plus the fitted factor weights. The newest is used;
-- PUT keeps the last 12 so a bad week can be looked back on.
CREATE TABLE IF NOT EXISTS calibration (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  at    INTEGER NOT NULL,     -- when it was stored (ms)
  by    TEXT,                 -- 'runner' | 'page'
  body  TEXT NOT NULL         -- the table, JSON
);

-- Signals Tony follows on paper. `id` = the signal's id, so its grade is the
-- ledger's (signals.id); `signal` keeps the signal itself in case the ledger
-- row is ever gone.
CREATE TABLE IF NOT EXISTS paper (
  id       TEXT PRIMARY KEY,
  signal   TEXT NOT NULL,     -- JSON
  created  INTEGER NOT NULL
);

-- Saved strategy backtests: the spec, the headline numbers and the equity
-- curve thinned to at most 500 points. Never the bars.
CREATE TABLE IF NOT EXISTS backtests (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  created  INTEGER NOT NULL,
  spec     TEXT NOT NULL,     -- JSON
  summary  TEXT NOT NULL,     -- JSON
  curve    TEXT NOT NULL      -- JSON { equity, bench }
);
