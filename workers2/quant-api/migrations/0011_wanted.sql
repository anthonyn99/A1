-- Neo Quant's "wanted" list (A1-Priv docs/TradeHub/quant/phase-11.md, "Guarantees"):
-- what Tony asked for that no registered action or rule can do yet, shown in
-- Control ▸ Data & AI status. One row per thing wanted; asking again counts it.
-- Only adds a table.
CREATE TABLE IF NOT EXISTS wanted (
  what TEXT PRIMARY KEY,        -- what is missing, in a few words ("options strategies")
  words TEXT NOT NULL,          -- what Tony said, the newest time
  kind TEXT NOT NULL,           -- control (Phase 11) | lab (Strategy Lab, Phase 9B)
  at INTEGER NOT NULL,          -- the newest ask (ms)
  count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS wanted_at ON wanted (at DESC);
