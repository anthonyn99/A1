-- quant-api, Phase 1 (the data gateway). Only ADDS, like every migration here.

-- The skip window: a provider failing three times in a row, or at its daily
-- cap, is left out of every chain until skip_until (5 minutes later).
ALTER TABLE provider_health ADD COLUMN fails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_health ADD COLUMN skip_until INTEGER;

-- What history is known per symbol and timeframe: the first and last bar a
-- provider has served, so the page never asks again for bars before the start.
CREATE TABLE IF NOT EXISTS bars_meta (
  symbol    TEXT NOT NULL,
  tf        TEXT NOT NULL,      -- '1d', '1h', ...
  first_t   INTEGER,            -- the oldest bar served (ms)
  last_t    INTEGER,            -- the newest bar served (ms)
  provider  TEXT,
  at        INTEGER NOT NULL,
  PRIMARY KEY (symbol, tf)
);
