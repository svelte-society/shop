CREATE TABLE _pricing_migration_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO _pricing_migration_guard
SELECT
  (SELECT count(*) FROM checkout_drafts) +
  (SELECT count(*) FROM orders) +
  (SELECT count(*) FROM order_lines);

DROP TABLE _pricing_migration_guard;

ALTER TABLE checkout_drafts ADD COLUMN destination_country TEXT
  CHECK (
    destination_country IS NULL OR
    (length(destination_country) = 2 AND destination_country = upper(destination_country))
  );

CREATE TRIGGER checkout_drafts_destination_required_insert
BEFORE INSERT ON checkout_drafts
WHEN NEW.destination_country IS NULL
BEGIN
  SELECT RAISE(ABORT, 'checkout destination required');
END;

CREATE TRIGGER checkout_drafts_destination_required_update
BEFORE UPDATE OF destination_country ON checkout_drafts
WHEN NEW.destination_country IS NULL
BEGIN
  SELECT RAISE(ABORT, 'checkout destination required');
END;

ALTER TABLE checkout_drafts ADD COLUMN shipping_rate_id TEXT;

ALTER TABLE checkout_drafts ADD COLUMN shipping_net_amount INTEGER
  CHECK (shipping_net_amount IS NULL OR shipping_net_amount >= 0);

CREATE TRIGGER checkout_drafts_shipping_required_insert
BEFORE INSERT ON checkout_drafts
WHEN NEW.shipping_rate_id IS NULL OR NEW.shipping_net_amount IS NULL OR
  (NEW.shipping_mode = 'paid' AND NEW.shipping_net_amount <= 0) OR
  (NEW.shipping_mode = 'free' AND NEW.shipping_net_amount <> 0)
BEGIN
  SELECT RAISE(ABORT, 'checkout shipping snapshot required');
END;

CREATE TRIGGER checkout_drafts_shipping_required_update
BEFORE UPDATE OF shipping_rate_id, shipping_net_amount, shipping_mode ON checkout_drafts
WHEN NEW.shipping_rate_id IS NULL OR NEW.shipping_net_amount IS NULL OR
  (NEW.shipping_mode = 'paid' AND NEW.shipping_net_amount <= 0) OR
  (NEW.shipping_mode = 'free' AND NEW.shipping_net_amount <> 0)
BEGIN
  SELECT RAISE(ABORT, 'checkout shipping snapshot required');
END;

ALTER TABLE orders ADD COLUMN shipping_tax_amount INTEGER NOT NULL DEFAULT 0
  CHECK (shipping_tax_amount >= 0);

ALTER TABLE order_lines ADD COLUMN retail_unit_amount INTEGER NOT NULL DEFAULT 0
  CHECK (retail_unit_amount >= 0);
