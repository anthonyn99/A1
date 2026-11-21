-- Batch 4 T1 (A1-Priv docs/TradeHub/quant-trading.md): which paper broker each logged order, fill and
-- equity row belongs to. Existing rows are Alpaca's. Only adds columns. Apply with
-- `wrangler d1 execute quant --remote --file=migrations/0014_broker.sql` (never `migrations apply`).
-- paper_orders.alpaca_id holds the broker's own order id for every broker.
ALTER TABLE paper_orders ADD COLUMN broker TEXT NOT NULL DEFAULT 'alpaca';
ALTER TABLE paper_fills ADD COLUMN broker TEXT NOT NULL DEFAULT 'alpaca';
ALTER TABLE paper_equity ADD COLUMN broker TEXT NOT NULL DEFAULT 'alpaca';
CREATE INDEX IF NOT EXISTS paper_orders_broker ON paper_orders (broker, at);
