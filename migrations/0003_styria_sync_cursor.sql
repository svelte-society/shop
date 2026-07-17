ALTER TABLE orders ADD COLUMN styria_last_checked_at TEXT;

CREATE INDEX idx_orders_styria_sync
ON orders(styria_last_checked_at, updated_at, id);
