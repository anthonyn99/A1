-- Batch 4 T5 (A1-Priv docs/TradeHub/quant/t4-05.md): a TradeHub book per paper broker. The broker's own
-- account keeps its balance (Alpaca's cannot be set through its API; Webull's sandbox resets only from its
-- web console); the book says what TradeHub shows: equity = capital + (broker equity - baseline), buying
-- power scaled by the same ratio and capped by bp_cap. resets = the last 20 resets (JSON). Only adds a table.
-- Apply with `wrangler d1 execute quant --remote --file=migrations/0015_books.sql` (never `migrations apply`).
CREATE TABLE IF NOT EXISTS trade_books (
  broker TEXT PRIMARY KEY,
  capital REAL NOT NULL,
  baseline REAL NOT NULL,
  bp_cap REAL,
  at INTEGER NOT NULL,
  resets TEXT NOT NULL DEFAULT '[]'
);
