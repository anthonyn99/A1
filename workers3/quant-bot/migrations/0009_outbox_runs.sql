-- N8 review: the ids of the strategist runs already announced (lib/outbox.js). A run's `ended` comes from the PC, so
-- the outbox looks back a few hours past its watermark and skips these instead of trusting the order.
ALTER TABLE bot_outbox ADD COLUMN runs_sent TEXT NOT NULL DEFAULT '[]';
