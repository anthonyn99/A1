-- Neo Cortex N5 (A1-Priv docs/TradeHub/quant/n4-05.md): the 15-minute checkpoints at which the bot really evaluated its
-- strategies (shadow or paper, not paused, halted or guarded). A day's decision check judges a strategy only when the
-- session was covered, so an off or paused day never fails a shadow or counts as drift. Additive.
CREATE TABLE IF NOT EXISTS bot_session_slots (
  day TEXT NOT NULL,
  slot INTEGER NOT NULL,
  PRIMARY KEY (day, slot)
);
