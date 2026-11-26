-- N4: a manual halt stays latched while any paper orders or positions remain.
ALTER TABLE bot_state ADD COLUMN kill_pending INTEGER NOT NULL DEFAULT 0;
