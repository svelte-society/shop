-- Checkout contract v4 stores the configured shipping amount as a tax-inclusive gross.
-- Existing v3 drafts remain frozen but cannot satisfy the v4 provider reconciliation.
ALTER TABLE checkout_drafts RENAME COLUMN shipping_net_amount TO shipping_gross_amount;
