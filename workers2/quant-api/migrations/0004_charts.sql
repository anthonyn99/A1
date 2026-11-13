-- quant-api, Phase 4 (the Charts tab). Only ADDS, like every migration here.

-- Tony's chart drawings, one row per symbol (trend lines, horizontals, rays,
-- rectangles, Fibonacci, text), as the JSON list the page keeps. A symbol
-- taken off the watchlist is marked gone_at by POST /watchlist and its row is
-- deleted 30 days later; put back in time, it keeps them.
CREATE TABLE IF NOT EXISTS drawings (
  symbol   TEXT PRIMARY KEY,
  body     TEXT NOT NULL,      -- JSON array of drawings
  at       INTEGER NOT NULL,   -- when it was last saved (ms)
  gone_at  INTEGER             -- when the symbol left the watchlist (ms), else null
);

-- Alert rules made from a chart (a level's bell, or an alert line). Stored
-- now; Phase 14 delivers them through TaskHub's push.
CREATE TABLE IF NOT EXISTS alerts (
  id       TEXT PRIMARY KEY,
  symbol   TEXT NOT NULL,
  kind     TEXT NOT NULL,      -- 'price' (a line) or 'level' (a ranked level or zone)
  price    REAL,               -- the line, or a level's price
  lo       REAL,               -- a zone's edges
  hi       REAL,
  level    TEXT,               -- the level's name when made ('R1', 'S2', ...) and its rank
  note     TEXT,
  active   INTEGER NOT NULL DEFAULT 1,
  created  INTEGER NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_symbol ON alerts (symbol);
