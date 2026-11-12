-- quant-api, Phase 3 (the Market tab). Only ADDS, like every migration here.

-- The market snapshot: everything the Market tab shows, built five times a
-- trading day by the scheduled runner (A1-Priv tools/quant-runner.mjs) or,
-- when it has not run, by the page. One row per New York day and slot; a
-- later build of the same slot replaces it.
CREATE TABLE IF NOT EXISTS snapshots (
  day   TEXT NOT NULL,      -- New York date, 'YYYY-MM-DD'
  slot  TEXT NOT NULL,      -- premarket | open30 | midday | close | nightly
  due   INTEGER NOT NULL,   -- when the slot was due (ms): what "newest" is ordered by
  at    INTEGER NOT NULL,   -- when it was built (ms)
  by    TEXT,               -- 'runner' or 'page'
  body  TEXT NOT NULL,      -- the snapshot, JSON
  PRIMARY KEY (day, slot)
);
CREATE INDEX IF NOT EXISTS snapshots_due ON snapshots (due);
