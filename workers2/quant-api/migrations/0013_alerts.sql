-- quant-api, Phase 14 (A1-Priv docs/TradeHub/quant/phase-14.md): alerts and
-- automation. The spec named it 0010_alerts.sql; 0010 to 0012 were taken by
-- Phases 9C to 13. Only ADDS, like every migration here.

-- Phase 4 made `alerts` for chart rules (price / level). The rules now have
-- every kind: price, signal, graded, regime, catalyst, data. Rules that are not
-- about one ticker keep symbol '*' (the column is NOT NULL since Phase 4).
ALTER TABLE alerts ADD COLUMN params TEXT;             -- JSON: the kind's own settings (dir, holds, atr, setup, minutes…)
ALTER TABLE alerts ADD COLUMN cooldown_min INTEGER;    -- null = 30 minutes
ALTER TABLE alerts ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0;   -- 1 = listed in the bell, never pushed
ALTER TABLE alerts ADD COLUMN ord INTEGER;             -- Tony's order in Control ▸ Alerts (A1 drag)
ALTER TABLE alerts ADD COLUMN state TEXT;              -- JSON: the check's memory (side, pending, armed, gen, retry)
ALTER TABLE alerts ADD COLUMN fired_at INTEGER;        -- the last time it fired (ms), for the cooldown

-- Every alert that fired. (rule_id, trigger_key) is unique: a rule can never
-- fire twice for the same trigger. Also the bell's list.
CREATE TABLE IF NOT EXISTS alert_fires (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  symbol      TEXT,
  title       TEXT NOT NULL,
  body        TEXT,
  url         TEXT,
  pushed      INTEGER,           -- 1 sent, 0 failed (retried once), null not pushed (quiet, muted, off hours)
  why         TEXT,              -- why it was not pushed, or the send error
  devices     TEXT,              -- JSON list of the device names it reached
  seen        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (rule_id, trigger_key)
);
CREATE INDEX IF NOT EXISTS alert_fires_at ON alert_fires (at);
