-- Paper trading (A1-Priv docs/TradeHub/quant/phase-09c.md; the spec's 0007 went to the dossier).
-- Only adds tables. Orders, fills and equity are Alpaca paper's; these keep who and why.

-- A strategy running on paper: its spec, capital slice, limits and state.
CREATE TABLE IF NOT EXISTS paper_runs (
  id TEXT PRIMARY KEY,           -- r…
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  spec TEXT NOT NULL,            -- JSON, A1-Priv TradeHub/core/strategy.js
  capital REAL NOT NULL,
  limits TEXT NOT NULL,          -- JSON { maxPositions, maxPositionPct, maxOrdersDay, dailyLossPct, maxDrawdownPct }
  state TEXT NOT NULL,           -- running | paused | stopped
  by TEXT NOT NULL,              -- tony | neo
  last_bar INTEGER,              -- the last closed bar the runner acted on (ms)
  stats TEXT                     -- JSON, the runner's latest live-vs-backtest numbers
);

-- Every order TradeHub sent, before it went out: who, why, which run.
CREATE TABLE IF NOT EXISTS paper_orders (
  id TEXT PRIMARY KEY,           -- the client order id (run + symbol + bar + side for a run: a retried tick sends the same)
  at INTEGER NOT NULL,
  day TEXT NOT NULL,             -- New York day (a run's orders a day)
  run TEXT,
  who TEXT NOT NULL,             -- tony | run | neo
  reason TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  qty REAL,
  body TEXT NOT NULL,            -- JSON, what Alpaca was sent
  alpaca_id TEXT,
  status TEXT NOT NULL,          -- sent | new | accepted | filled | canceled | refused | replaced …
  error TEXT
);
CREATE INDEX IF NOT EXISTS paper_orders_run ON paper_orders (run, day);
CREATE INDEX IF NOT EXISTS paper_orders_alpaca ON paper_orders (alpaca_id);

-- Fills reconciled from Alpaca's account activity (once each).
CREATE TABLE IF NOT EXISTS paper_fills (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  order_id TEXT,
  run TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL,
  price REAL
);
CREATE INDEX IF NOT EXISTS paper_fills_run ON paper_fills (run, at);

-- One equity row a run a day ('account' for the whole paper account).
CREATE TABLE IF NOT EXISTS paper_equity (
  run TEXT NOT NULL,
  day TEXT NOT NULL,
  equity REAL NOT NULL,
  PRIMARY KEY (run, day)
);
