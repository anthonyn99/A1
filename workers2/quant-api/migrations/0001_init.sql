-- quant-api, first tables. Migrations only ever ADD (a new table, column or
-- index), so reverting a phase of TradeHub Quant never loses data.

-- One row of small state per key (schema notes, last job times).
CREATE TABLE IF NOT EXISTS meta (
  k   TEXT PRIMARY KEY,
  v   TEXT NOT NULL,
  at  INTEGER NOT NULL
);

-- The budget ledger: how many calls each outside service took on a UTC day.
-- Read before a call (a service at its cap is skipped) and by Control's
-- Data & AI status. One row per (day, service), counted in place.
CREATE TABLE IF NOT EXISTS usage (
  day      TEXT NOT NULL,      -- YYYY-MM-DD, UTC
  service  TEXT NOT NULL,      -- 'finnhub', 'alpaca', 'gemini:<model>', 'worker', ...
  n        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, service)
);

-- The last answer each provider gave, for the fallback chain and the status page.
CREATE TABLE IF NOT EXISTS provider_health (
  provider    TEXT PRIMARY KEY,
  ok          INTEGER NOT NULL,   -- 1 answered, 0 failed
  status      INTEGER,            -- HTTP status of the last call
  latency_ms  INTEGER,
  detail      TEXT,               -- short reason when it failed
  at          INTEGER NOT NULL,
  ok_at       INTEGER             -- when it last answered
);

-- Every correction the data doctor makes: what was wrong, old and new value, source.
CREATE TABLE IF NOT EXISTS corrections (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  kind    TEXT NOT NULL,       -- 'quote', 'bar', 'date', 'journal', ...
  symbol  TEXT,
  field   TEXT,
  old_v   TEXT,
  new_v   TEXT,
  source  TEXT,
  note    TEXT
);
CREATE INDEX IF NOT EXISTS corrections_at ON corrections (at);
