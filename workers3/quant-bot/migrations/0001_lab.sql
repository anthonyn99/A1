-- Neo Cortex N3 (A1-Priv docs/TradeHub/quant/n4-03.md): the strategist's research and its strategies.
-- A strategy version never changes once stored: an edit is version + 1 (its hash proves it).
CREATE TABLE IF NOT EXISTS strategies (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  name TEXT NOT NULL,
  stage TEXT NOT NULL,              -- gated | shadow | paper | active | killed | retired (N5 moves it)
  spec TEXT NOT NULL,               -- JSON, the clamped spec the gate passed
  gate TEXT NOT NULL,               -- JSON { pass, reasons }
  edits TEXT NOT NULL,              -- JSON [{ field, from, to, why }]
  report TEXT,                      -- JSON, the gate's numbers
  run_id TEXT,                      -- the lab run that proposed it
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS strategies_stage ON strategies (stage, updated);

CREATE TABLE IF NOT EXISTS lab_runs (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,            -- premarket | postclose | now
  day TEXT NOT NULL,                -- New York date
  model TEXT,
  started INTEGER NOT NULL,
  ended INTEGER,
  outcome TEXT NOT NULL,            -- ok | no-edge | refused | failed | running
  summary TEXT,                     -- Claude's notes for the brief (words)
  results TEXT,                     -- JSON [{ id, version, name, pass, reasons, edits, report }]
  trials INTEGER,                   -- backtests run in the sandbox (the deflated Sharpe's count)
  usage TEXT                        -- JSON { turns, ms, cost_usd }
);
CREATE INDEX IF NOT EXISTS lab_runs_day ON lab_runs (day, session);

CREATE TABLE IF NOT EXISTS research_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  note TEXT,
  claimed_at INTEGER,
  run_id TEXT
);
