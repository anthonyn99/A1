-- quant-api, Phase 9 (Neo Quant, the assistant). Only ADDS, like every migration here.
-- (The spec named it 0008_ai.sql; 0008 went to memory first.)

-- The AI models in use (A1-Priv docs/TradeHub/quant/phase-09.md). Nothing is
-- named in code: each provider's list is read and what it serves is kept here.
-- Gemini's rows are its ladder (family flash | flash-lite | gemma, best rank
-- first) with what each model can do and when it is spent; a fast-lane
-- provider's rows are its best three chat models.
CREATE TABLE IF NOT EXISTS models (
  provider  TEXT NOT NULL,     -- gemini | groq | cerebras | openrouter | mistral | github | nvidia
  id        TEXT NOT NULL,     -- the provider's model id
  family    TEXT,              -- flash | flash-lite | gemma | chat
  rank      INTEGER NOT NULL DEFAULT 0,   -- 0 = tried first within its family
  caps      TEXT,              -- JSON { search, image, audio }: true | false | null (not known yet)
  limits    TEXT,              -- JSON { rpd, in, out }: requests a day, token limits
  spent     TEXT,              -- JSON { text | search | image | audio: ms until which it is spent }
  state     TEXT NOT NULL DEFAULT 'ok',   -- ok | dropped
  at        INTEGER NOT NULL,  -- when the provider's list was last read
  PRIMARY KEY (provider, id)
);

-- The graded question set's scores (tools/quant-eval.mjs), one row per run of a
-- provider. A provider whose newest row is under 85% numeric accuracy or 80%
-- verdict agreement is not used for answers.
CREATE TABLE IF NOT EXISTS evals (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  provider  TEXT NOT NULL,
  model     TEXT,
  n         INTEGER NOT NULL,  -- questions asked
  numeric   REAL NOT NULL,     -- 0 to 1
  verdict   REAL NOT NULL,     -- 0 to 1
  detail    TEXT               -- JSON: the questions missed
);
CREATE INDEX IF NOT EXISTS evals_provider ON evals (provider, at);

-- What Neo Quant wrote ahead of time: the daily brief (kind 'daily', by the
-- runner's premarket job) and "What changed?" (kind 'changed'). One row per
-- New York day and kind; the Markdown copy goes to Drive (TradeHub/briefs/).
CREATE TABLE IF NOT EXISTS briefs (
  day    TEXT NOT NULL,        -- YYYY-MM-DD, New York
  kind   TEXT NOT NULL,        -- daily | changed
  at     INTEGER NOT NULL,
  body   TEXT NOT NULL,        -- JSON { text, facts, model, provider, struck? }
  PRIMARY KEY (day, kind)
);
