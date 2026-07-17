import type { OutboxJob } from '$lib/domain/orders';
import type { OutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';

export type AlertCode =
	| 'ORDER_PENDING_REVIEW'
	| 'STYRIA_REVIEW_REQUIRED'
	| 'SCHEDULER_FAILED'
	| 'SHIPPING_EMAIL_UNSENT'
	| 'BACKUP_FAILED'
	| 'BACKUP_MISSED'
	| 'CATALOG_UNAVAILABLE'
	| 'CHECKOUT_UNAVAILABLE'
	| 'MCP_AUTH_REPEATED_FAILURE'
	| 'DISK_LOW'
	| 'SQLITE_NOT_READY'
	| 'WITHDRAWAL_NOTICE_RECEIVED'
	| 'WITHDRAWAL_MESSAGE_UNSENT'
	| 'WITHDRAWAL_DATA_UNREADABLE';

export type AlertRecord = {
	code: AlertCode;
	subjectId: string;
	observedAt: Date;
};

export interface AlertService {
	enqueueAlert(code: AlertCode, subjectId: string, now: Date): void;
}

const alertCodes = new Set<AlertCode>([
	'ORDER_PENDING_REVIEW',
	'STYRIA_REVIEW_REQUIRED',
	'SCHEDULER_FAILED',
	'SHIPPING_EMAIL_UNSENT',
	'BACKUP_FAILED',
	'BACKUP_MISSED',
	'CATALOG_UNAVAILABLE',
	'CHECKOUT_UNAVAILABLE',
	'MCP_AUTH_REPEATED_FAILURE',
	'DISK_LOW',
	'SQLITE_NOT_READY',
	'WITHDRAWAL_NOTICE_RECEIVED',
	'WITHDRAWAL_MESSAGE_UNSENT',
	'WITHDRAWAL_DATA_UNREADABLE'
]);
const dailyCodes = new Set<AlertCode>(['ORDER_PENDING_REVIEW', 'BACKUP_MISSED']);
const SAFE_SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const DAILY_BUCKET_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const HOURLY_BUCKET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/u;

const nextActions: Record<AlertCode, string> = {
	ORDER_PENDING_REVIEW: 'Open Codex, inspect the order, and decide the fulfillment action.',
	STYRIA_REVIEW_REQUIRED: 'Open Codex and reconcile the Styria submission before any retry.',
	SCHEDULER_FAILED: 'Inspect the named job run and correct its stable failure code.',
	SHIPPING_EMAIL_UNSENT: 'Inspect the shipping email outbox job and Plunk delivery status.',
	BACKUP_FAILED: 'Inspect the backup job run and storage configuration before the next cadence.',
	BACKUP_MISSED: 'Verify the backup schedule and run the documented backup check.',
	CATALOG_UNAVAILABLE: 'Verify Stripe catalog availability and the last validated cache state.',
	CHECKOUT_UNAVAILABLE: 'Verify Stripe Checkout availability before reopening checkout.',
	MCP_AUTH_REPEATED_FAILURE:
		'Verify the Codex host configuration and rotate the bearer secret if needed.',
	DISK_LOW: 'Free space or expand the persistent data volume.',
	SQLITE_NOT_READY: 'Stop checkout and inspect the SQLite file, volume, and migrations.',
	WITHDRAWAL_NOTICE_RECEIVED: 'Open Codex and inspect the withdrawal notice before reconciliation.',
	WITHDRAWAL_MESSAGE_UNSENT: 'Open Codex and inspect the withdrawal message delivery state.',
	WITHDRAWAL_DATA_UNREADABLE:
		'Open Codex and inspect the withdrawal data-key and encrypted case integrity.'
};

export class AlertError extends Error {
	constructor(readonly code: 'ALERT_TIME_INVALID' | 'ALERT_SUBJECT_INVALID' | 'ALERT_JOB_INVALID') {
		super(code);
		this.name = 'AlertError';
	}
}

function validDate(now: Date): boolean {
	return now instanceof Date && Number.isFinite(now.getTime());
}

function isAlertCode(value: string): value is AlertCode {
	return alertCodes.has(value as AlertCode);
}

function bucketFor(code: AlertCode, now: Date): string {
	const iso = now.toISOString();
	return dailyCodes.has(code) ? iso.slice(0, 10) : iso.slice(0, 13);
}

function parseBucket(code: AlertCode, bucket: string): Date | null {
	const daily = dailyCodes.has(code);
	if (daily ? !DAILY_BUCKET_PATTERN.test(bucket) : !HOURLY_BUCKET_PATTERN.test(bucket)) return null;
	const parsed = new Date(`${bucket}${daily ? 'T00:00:00.000Z' : ':00:00.000Z'}`);
	if (!validDate(parsed)) return null;
	if (bucketFor(code, parsed) !== bucket) return null;
	return parsed;
}

export function parseAlertIdempotencyKey(value: string): AlertRecord {
	const parts = value.split(':');
	if (parts.length < 4 || parts[0] !== 'alert') throw new AlertError('ALERT_JOB_INVALID');
	const code = parts[1];
	const subjectId = parts[2];
	const bucket = parts.slice(3).join(':');
	if (!isAlertCode(code) || !SAFE_SUBJECT_PATTERN.test(subjectId)) {
		throw new AlertError('ALERT_JOB_INVALID');
	}
	const observedAt = parseBucket(code, bucket);
	if (!observedAt) throw new AlertError('ALERT_JOB_INVALID');
	return { code, subjectId, observedAt };
}

export function isOperationalAlertKey(value: string): boolean {
	try {
		parseAlertIdempotencyKey(value);
		return true;
	} catch {
		return false;
	}
}

export function parseOperationalAlertJob(job: OutboxJob): AlertRecord {
	if (job.kind !== 'operational-alert' || job.orderId !== null) {
		throw new AlertError('ALERT_JOB_INVALID');
	}
	return parseAlertIdempotencyKey(job.idempotencyKey);
}

export function loadOperationalAlert(database: ShopDatabase, job: OutboxJob): AlertRecord {
	const keyed = parseOperationalAlertJob(job);
	const row = database
		.prepare(
			`SELECT alert_code, alert_subject_id, alert_observed_at
			 FROM outbox_jobs WHERE id = ? AND idempotency_key = ?`
		)
		.get(job.id, job.idempotencyKey) as
		| {
				alert_code: unknown;
				alert_subject_id: unknown;
				alert_observed_at: unknown;
		  }
		| undefined;
	if (
		!row ||
		row.alert_code !== keyed.code ||
		row.alert_subject_id !== keyed.subjectId ||
		typeof row.alert_observed_at !== 'string'
	) {
		throw new AlertError('ALERT_JOB_INVALID');
	}
	const observedAt = new Date(row.alert_observed_at);
	if (
		!validDate(observedAt) ||
		observedAt.toISOString() !== row.alert_observed_at ||
		bucketFor(keyed.code, observedAt) !== bucketFor(keyed.code, keyed.observedAt)
	) {
		throw new AlertError('ALERT_JOB_INVALID');
	}
	return { code: keyed.code, subjectId: keyed.subjectId, observedAt };
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

export function alertMessage(alert: AlertRecord): { subject: string; html: string } {
	if (
		!alertCodes.has(alert.code) ||
		!SAFE_SUBJECT_PATTERN.test(alert.subjectId) ||
		!validDate(alert.observedAt)
	) {
		throw new AlertError('ALERT_JOB_INVALID');
	}
	const code = escapeHtml(alert.code);
	const subjectId = escapeHtml(alert.subjectId);
	const observedAt = escapeHtml(alert.observedAt.toISOString());
	const action = escapeHtml(nextActions[alert.code]);
	return {
		subject: `[${alert.code}] Shop operational alert`,
		html:
			`<p>Code: ${code}</p>` +
			`<p>Subject: ${subjectId}</p>` +
			`<p>Observed UTC: ${observedAt}</p>` +
			`<p>Next action: ${action}</p>`
	};
}

export class SqliteAlertService implements AlertService {
	constructor(private readonly outbox: Pick<OutboxRepository, 'enqueueOperationalAlert'>) {}

	enqueueAlert(code: AlertCode, subjectId: string, now: Date): void {
		if (!alertCodes.has(code)) throw new AlertError('ALERT_JOB_INVALID');
		if (!SAFE_SUBJECT_PATTERN.test(subjectId)) throw new AlertError('ALERT_SUBJECT_INVALID');
		if (!validDate(now)) throw new AlertError('ALERT_TIME_INVALID');
		this.outbox.enqueueOperationalAlert({
			kind: 'operational-alert',
			idempotencyKey: `alert:${code}:${subjectId}:${bucketFor(code, now)}`,
			orderId: null,
			nextAttemptAt: now,
			code,
			subjectId,
			observedAt: now
		});
	}
}

let configuredAlertService: AlertService | null = null;

export function configureAlertService(service: AlertService): () => void {
	configuredAlertService = service;
	return () => {
		if (configuredAlertService === service) configuredAlertService = null;
	};
}

// Request paths use this best-effort boundary after application startup. Durable scheduler paths
// inject AlertService directly so persistence failures remain observable to their caller.
export function enqueueAlert(code: AlertCode, subjectId: string, now: Date): void {
	try {
		configuredAlertService?.enqueueAlert(code, subjectId, now);
	} catch {
		// Operational alerting must never change commerce, auth, health, or provider outcomes.
	}
}
