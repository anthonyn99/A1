-- Neo Cortex research publishes the calendar snapshot used by the bot’s earnings guard.
CREATE TABLE IF NOT EXISTS bot_market_context (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at INTEGER NOT NULL,
  body TEXT NOT NULL
);
