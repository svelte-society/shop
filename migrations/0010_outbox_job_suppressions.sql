CREATE TABLE outbox_job_suppressions (
  outbox_job_id INTEGER PRIMARY KEY REFERENCES outbox_jobs(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason = 'REVIEW_ALERT_BACKLOG_CLEANUP'),
  actor TEXT NOT NULL CHECK (actor = 'codex-admin'),
  backup_id TEXT NOT NULL,
  backup_filename TEXT NOT NULL,
  backup_sha256 TEXT NOT NULL CHECK (
    length(backup_sha256) = 64
    AND backup_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  previous_next_attempt_at TEXT NOT NULL,
  previous_last_error_code TEXT,
  suppressed_at TEXT NOT NULL
);
