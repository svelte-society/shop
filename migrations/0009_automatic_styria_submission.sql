CREATE TABLE submission_approvals_next (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  payload_hash TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('codex-admin', 'system-auto')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

INSERT INTO submission_approvals_next (
  id,
  order_id,
  payload_hash,
  actor,
  expires_at,
  used_at
)
SELECT
  id,
  order_id,
  payload_hash,
  actor,
  expires_at,
  used_at
FROM submission_approvals;

DROP TABLE submission_approvals;
ALTER TABLE submission_approvals_next RENAME TO submission_approvals;

INSERT INTO outbox_jobs (
  kind,
  idempotency_key,
  order_id,
  next_attempt_at
)
SELECT
  'styria-create',
  'styria-create:' || id,
  id,
  updated_at
FROM orders
WHERE payment_status = 'paid'
  AND fulfillment_status = 'pending_review'
  AND styria_order_id IS NULL;
