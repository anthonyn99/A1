-- quant-api, Phase 8 (memory cards, conversation history, Drive files). Only ADDS, like every migration here.
-- (The spec named it 0007_memory.sql; 0007 went to the dossier first.)

-- Memory cards (A1-Priv docs/TradeHub/quant/phase-08.md): what Neo Quant knows
-- about Tony. Neo may only PROPOSE a card; Tony makes it active. At most 150
-- active; the least recently used unpinned ones are archived.
CREATE TABLE IF NOT EXISTS memory_cards (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,     -- preference | lesson | fact | pattern
  text       TEXT NOT NULL,     -- ≤ 240 characters
  source     TEXT NOT NULL,     -- tony | neo
  evidence   TEXT,              -- a history turn or trade id
  created    INTEGER NOT NULL,
  last_used  INTEGER,
  pinned     INTEGER NOT NULL DEFAULT 0,
  state      TEXT NOT NULL      -- active | proposed | archived
);
CREATE INDEX IF NOT EXISTS memory_state ON memory_cards (state, last_used);

-- Conversations (30 days in TradeHub, then Drive). A conversation row is
-- written once, with its first turn; its time is its newest turn's.
CREATE TABLE IF NOT EXISTS history (
  id       TEXT PRIMARY KEY,
  title    TEXT,
  created  INTEGER NOT NULL,
  pinned   INTEGER NOT NULL DEFAULT 0
);
-- One row per question and per reply.
CREATE TABLE IF NOT EXISTS history_turns (
  id       TEXT PRIMARY KEY,
  conv     TEXT NOT NULL,
  at       INTEGER NOT NULL,
  role     TEXT NOT NULL,       -- q | a
  text     TEXT NOT NULL,
  verdict  TEXT,               -- GO | WATCH | NO-GO | …
  facts    TEXT,               -- fact sheet ids, JSON
  tickers  TEXT,               -- JSON
  mode     TEXT,               -- voice | text
  model    TEXT                -- which model answered
);
CREATE INDEX IF NOT EXISTS history_turns_conv ON history_turns (conv, at);
CREATE INDEX IF NOT EXISTS history_turns_at ON history_turns (at);

-- What quant-api put in Tony's Drive (under TradeHub/): one row per file or
-- folder, with the SHA-256 of its content so identical content is never
-- uploaded twice.
CREATE TABLE IF NOT EXISTS drive_files (
  path   TEXT PRIMARY KEY,     -- TradeHub/ledger/2026-11.jsonl
  id     TEXT NOT NULL,        -- Drive's file id
  kind   TEXT NOT NULL,        -- file | folder
  sha    TEXT,
  size   INTEGER,
  mime   TEXT,
  at     INTEGER NOT NULL
);
