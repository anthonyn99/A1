-- N8 (A1-Priv docs/TradeHub/quant/n4-08.md): where Neo Cortex's alerts have been sent up to. One row: the newest
-- journal event, lab run end and ready brief already handed to quant-api. `at` NULL = never run: the first flush only
-- learns the current position, so nothing old arrives as a burst of alerts.
CREATE TABLE IF NOT EXISTS bot_outbox (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  event_id INTEGER NOT NULL DEFAULT 0,
  run_end INTEGER NOT NULL DEFAULT 0,
  brief_day TEXT NOT NULL DEFAULT '',
  at INTEGER
);
INSERT OR IGNORE INTO bot_outbox (id) VALUES (1);
