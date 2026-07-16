CREATE TABLE checkout_drafts (
  id TEXT PRIMARY KEY,
  stripe_checkout_session_id TEXT UNIQUE,
  contract_version INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'eur'),
  total_unit_count INTEGER NOT NULL CHECK (total_unit_count BETWEEN 1 AND 20),
  shipping_mode TEXT NOT NULL CHECK (shipping_mode IN ('paid', 'free')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE checkout_draft_lines (
  draft_id TEXT NOT NULL REFERENCES checkout_drafts(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL,
  stripe_product_id TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  variant_label TEXT NOT NULL,
  sku TEXT NOT NULL,
  styria_product_number TEXT NOT NULL,
  design_reference TEXT NOT NULL,
  design_json TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_amount INTEGER NOT NULL CHECK (unit_amount >= 0),
  currency TEXT NOT NULL CHECK (currency = 'eur'),
  PRIMARY KEY (draft_id, line_index)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT NOT NULL,
  checkout_draft_id TEXT NOT NULL UNIQUE REFERENCES checkout_drafts(id),
  currency TEXT NOT NULL CHECK (currency = 'eur'),
  subtotal_amount INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL,
  shipping_amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,
  destination_country TEXT NOT NULL,
  payment_status TEXT NOT NULL CHECK (payment_status IN ('paid', 'partially_refunded', 'refunded')),
  fulfillment_status TEXT NOT NULL CHECK (fulfillment_status IN ('pending_review', 'submitting', 'submitted', 'awaiting_vendor_payment', 'in_production', 'shipped', 'review_required', 'cancelled')),
  styria_order_id TEXT UNIQUE,
  styria_status TEXT,
  tracking_number TEXT,
  submitted_at TEXT,
  shipped_at TEXT,
  updated_at TEXT NOT NULL,
  last_error_code TEXT
);

CREATE TABLE stripe_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processing_status TEXT NOT NULL CHECK (processing_status IN ('processing', 'completed', 'failed')),
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  last_error_code TEXT,
  first_seen_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE order_lines (
  order_id TEXT NOT NULL REFERENCES orders(id),
  line_index INTEGER NOT NULL,
  stripe_product_id TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  variant_label TEXT NOT NULL,
  sku TEXT NOT NULL,
  styria_product_number TEXT NOT NULL,
  design_reference TEXT NOT NULL,
  design_json TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_amount INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'eur'),
  PRIMARY KEY (order_id, line_index)
);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  prior_state TEXT,
  next_state TEXT,
  result TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE submission_approvals (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  payload_hash TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor = 'codex-admin'),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE outbox_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  order_id TEXT REFERENCES orders(id),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  completed_at TEXT,
  last_error_code TEXT
);

CREATE TABLE email_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL,
  tracking_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_delivery_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT
);

CREATE TABLE support_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  outcome TEXT NOT NULL,
  external_reference TEXT,
  actor TEXT NOT NULL CHECK (actor = 'codex-admin'),
  created_at TEXT NOT NULL
);

CREATE TABLE job_leases (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  error_code TEXT
);

CREATE INDEX idx_orders_fulfillment_status ON orders(fulfillment_status, updated_at);
CREATE INDEX idx_outbox_due ON outbox_jobs(completed_at, next_attempt_at);
CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);
