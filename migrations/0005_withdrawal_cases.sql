CREATE TABLE withdrawal_cases (
  id TEXT PRIMARY KEY,
  public_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('submitted','reviewing','awaiting_return','ineligible','support_handling','closed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  scope TEXT NOT NULL CHECK (scope IN ('entire_order','specific_items')),
  eligibility TEXT NOT NULL CHECK (eligibility IN ('pending','eligible_eu','ineligible_non_eu','support_handling')),
  outcome_code TEXT,
  schema_version INTEGER,
  encryption_key_version INTEGER,
  encrypted_payload BLOB,
  payload_nonce BLOB,
  payload_tag BLOB,
  dedupe_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reconciled_at TEXT,
  closed_at TEXT,
  pii_purge_due_at TEXT,
  purged_at TEXT,
  CHECK ((purged_at IS NULL AND schema_version = 1 AND encryption_key_version = 1 AND encrypted_payload IS NOT NULL AND payload_nonce IS NOT NULL AND payload_tag IS NOT NULL AND dedupe_fingerprint IS NOT NULL)
      OR (purged_at IS NOT NULL AND schema_version IS NULL AND encryption_key_version IS NULL AND encrypted_payload IS NULL AND payload_nonce IS NULL AND payload_tag IS NULL AND dedupe_fingerprint IS NULL))
);
CREATE INDEX withdrawal_cases_dedupe_idx ON withdrawal_cases(dedupe_fingerprint, created_at);
CREATE INDEX withdrawal_cases_status_idx ON withdrawal_cases(status, created_at);
CREATE INDEX withdrawal_cases_purge_idx ON withdrawal_cases(pii_purge_due_at) WHERE purged_at IS NULL;

CREATE TABLE withdrawal_case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES withdrawal_cases(id),
  actor TEXT NOT NULL CHECK (actor IN ('customer','codex-admin','system')),
  action TEXT NOT NULL,
  prior_status TEXT,
  next_status TEXT NOT NULL,
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX withdrawal_case_events_case_idx ON withdrawal_case_events(case_id, id);

CREATE TABLE withdrawal_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES withdrawal_cases(id),
  kind TEXT NOT NULL CHECK (kind IN ('receipt','eligible_instructions','ineligible_decision','support_handoff','resend')),
  resend_of_message_id INTEGER REFERENCES withdrawal_messages(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  provider_delivery_id TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  CHECK ((kind = 'resend' AND resend_of_message_id IS NOT NULL) OR (kind <> 'resend' AND resend_of_message_id IS NULL))
);
CREATE INDEX withdrawal_messages_due_idx ON withdrawal_messages(completed_at, next_attempt_at, id);
