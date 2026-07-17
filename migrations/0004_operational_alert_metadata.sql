ALTER TABLE outbox_jobs ADD COLUMN alert_code TEXT;
ALTER TABLE outbox_jobs ADD COLUMN alert_subject_id TEXT;
ALTER TABLE outbox_jobs ADD COLUMN alert_observed_at TEXT;
