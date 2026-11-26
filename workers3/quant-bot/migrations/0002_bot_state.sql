-- Neo Cortex N4. Additive worker state and audit storage.
CREATE TABLE IF NOT EXISTS bot_settings (
  version INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  author TEXT NOT NULL,
  reason TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  halted TEXT,
  last_check INTEGER,
  snapshot TEXT,
  errors INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO bot_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS bot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  symbol TEXT,
  side TEXT,
  qty REAL,
  price REAL,
  strategy TEXT,
  version INTEGER,
  why TEXT NOT NULL,
  thesis TEXT
);
CREATE INDEX IF NOT EXISTS bot_events_day ON bot_events (day, ts, id);

CREATE TABLE IF NOT EXISTS bot_briefs (
  day TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_equity (
  strategy TEXT NOT NULL,
  version INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  equity REAL NOT NULL,
  PRIMARY KEY (strategy, version, slot)
);
CREATE TABLE IF NOT EXISTS bot_shadow_sessions (
  day TEXT PRIMARY KEY,
  checked INTEGER NOT NULL
);
