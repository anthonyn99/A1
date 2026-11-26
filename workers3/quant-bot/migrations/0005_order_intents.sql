-- Order intent is stored before a paper broker request and reconciled by the stable client id.
CREATE TABLE IF NOT EXISTS bot_order_intents (
  client_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  version INTEGER NOT NULL,
  side TEXT NOT NULL,
  style TEXT NOT NULL,
  qty INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  stop REAL NOT NULL,
  target REAL,
  bar_time INTEGER NOT NULL,
  requested INTEGER NOT NULL,
  opened INTEGER,
  broker_id TEXT,
  order_body TEXT,
  close_id TEXT,
  status TEXT NOT NULL,
  why TEXT NOT NULL,
  thesis TEXT,
  spec TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_active_order_symbol ON bot_order_intents (symbol)
  WHERE status IN ('reserved', 'working', 'held', 'closing');

CREATE TABLE IF NOT EXISTS bot_fills (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  side TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_fill_cursor ON bot_fills (ts);
