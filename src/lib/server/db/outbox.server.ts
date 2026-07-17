import type { NewOutboxJob, OutboxJob } from '$lib/domain/orders';
import { isStableErrorCode, RepositoryError } from '$lib/domain/orders';
import type { ShopDatabase } from './types';
import {
	isOperationalAlertKey,
	parseAlertIdempotencyKey,
	type AlertCode,
	type AlertRecord
} from '$lib/server/monitoring/alerts.server';

export interface OutboxRepository {
	enqueue(input: NewOutboxJob): void;
	enqueueOperationalAlert(input: OperationalAlertOutboxInput): void;
	ensureShipping(orderId: string, trackingNumber: string, now: Date): boolean;
	claimDue(now: Date, limit: number): OutboxJob[];
	complete(id: number, now: Date): void;
	reschedule(id: number, attemptCount: number, nextAttemptAt: Date, errorCode: string): void;
	beginEmailDelivery(input: EmailDeliveryReference): boolean;
	completeEmailDelivery(
		input: EmailDeliveryReference,
		providerDeliveryId: string,
		now: Date,
		outboxJobId?: number
	): void;
}

export type OperationalAlertOutboxInput = NewOutboxJob & {
	code: AlertCode;
	subjectId: string;
	observedAt: Date;
};

export type EmailDeliveryReference = {
	orderId: string;
	kind: 'shipping' | 'shipping-support';
	trackingNumber: string;
	idempotencyKey: string;
};

type OutboxRow = {
	id: unknown;
	kind: unknown;
	idempotency_key: unknown;
	order_id: unknown;
	attempt_count: unknown;
	next_attempt_at: unknown;
	completed_at: unknown;
	last_error_code: unknown;
	alert_code: unknown;
	alert_subject_id: unknown;
	alert_observed_at: unknown;
};

type EmailDeliveryRow = {
	id: unknown;
	order_id: unknown;
	kind: unknown;
	tracking_reference: unknown;
	idempotency_key: unknown;
	provider_delivery_id: unknown;
	attempt_count: unknown;
	completed_at: unknown;
};

const CLAIM_LEASE_MILLISECONDS = 5 * 60_000;

function fail(code: string): never {
	throw new RepositoryError(code);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isoTimestamp(value: Date, invalidCode: string): string {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(invalidCode);
	return value.toISOString();
}

function dateFromIso(value: unknown, invalidCode: string): Date {
	if (typeof value !== 'string') fail(invalidCode);
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(invalidCode);
	return parsed;
}

function mapJob(row: OutboxRow): OutboxJob {
	const alertMetadataValid =
		row.kind === 'operational-alert'
			? isNonEmptyString(row.alert_code) &&
				isNonEmptyString(row.alert_subject_id) &&
				isNonEmptyString(row.alert_observed_at)
			: row.alert_code === null && row.alert_subject_id === null && row.alert_observed_at === null;
	if (
		!Number.isSafeInteger(row.id) ||
		(row.id as number) < 1 ||
		!isNonEmptyString(row.kind) ||
		!isNonEmptyString(row.idempotency_key) ||
		(row.order_id !== null && !isNonEmptyString(row.order_id)) ||
		!Number.isSafeInteger(row.attempt_count) ||
		(row.attempt_count as number) < 0 ||
		(row.last_error_code !== null && !isStableErrorCode(row.last_error_code)) ||
		!alertMetadataValid
	) {
		fail('OUTBOX_ROW_INVALID');
	}

	return {
		id: row.id as number,
		kind: row.kind,
		idempotencyKey: row.idempotency_key,
		orderId: row.order_id as string | null,
		attemptCount: row.attempt_count as number,
		nextAttemptAt: dateFromIso(row.next_attempt_at, 'OUTBOX_ROW_INVALID'),
		completedAt:
			row.completed_at === null ? null : dateFromIso(row.completed_at, 'OUTBOX_ROW_INVALID'),
		lastErrorCode: row.last_error_code as string | null
	};
}

function validateNewJob(input: NewOutboxJob, allowOperationalAlert = false): string {
	if (
		!input ||
		!isNonEmptyString(input.kind) ||
		!isNonEmptyString(input.idempotencyKey) ||
		(input.orderId !== null && !isNonEmptyString(input.orderId))
	) {
		fail('OUTBOX_JOB_INVALID');
	}
	const usesAlertKey = input.idempotencyKey.startsWith('alert:');
	if (
		(input.kind === 'operational-alert' &&
			(!allowOperationalAlert ||
				input.orderId !== null ||
				!isOperationalAlertKey(input.idempotencyKey))) ||
		(input.kind !== 'operational-alert' && usesAlertKey)
	) {
		fail('OUTBOX_JOB_INVALID');
	}
	return isoTimestamp(input.nextAttemptAt, 'OUTBOX_JOB_INVALID');
}

function shippingReference(orderId: string, trackingNumber: string): EmailDeliveryReference {
	if (!isNonEmptyString(orderId) || !isNonEmptyString(trackingNumber)) {
		fail('SHIPPING_EMAIL_REFERENCE_INVALID');
	}
	return {
		orderId,
		kind: 'shipping',
		trackingNumber,
		idempotencyKey: `shipping:${orderId}:${trackingNumber}`
	};
}

function validateEmailReference(input: EmailDeliveryReference): void {
	if (
		!input ||
		!isNonEmptyString(input.orderId) ||
		(input.kind !== 'shipping' && input.kind !== 'shipping-support') ||
		!isNonEmptyString(input.trackingNumber) ||
		!isNonEmptyString(input.idempotencyKey)
	) {
		fail('SHIPPING_EMAIL_REFERENCE_INVALID');
	}
	if (
		input.kind === 'shipping' &&
		input.idempotencyKey !== `shipping:${input.orderId}:${input.trackingNumber}`
	) {
		fail('SHIPPING_EMAIL_REFERENCE_INVALID');
	}
}

function validateEmailRow(row: EmailDeliveryRow, input: EmailDeliveryReference): void {
	if (
		!Number.isSafeInteger(row.id) ||
		(row.id as number) < 1 ||
		row.order_id !== input.orderId ||
		row.kind !== input.kind ||
		row.tracking_reference !== input.trackingNumber ||
		row.idempotency_key !== input.idempotencyKey ||
		(row.provider_delivery_id !== null && !isNonEmptyString(row.provider_delivery_id)) ||
		!Number.isSafeInteger(row.attempt_count) ||
		(row.attempt_count as number) < 0
	) {
		fail('EMAIL_DELIVERY_ROW_INVALID');
	}
	if (row.completed_at !== null) dateFromIso(row.completed_at, 'EMAIL_DELIVERY_ROW_INVALID');
}

export class SqliteOutboxRepository implements OutboxRepository {
	constructor(private readonly database: ShopDatabase) {}

	enqueue(input: NewOutboxJob): void {
		const nextAttemptAt = validateNewJob(input);
		const find = this.database.prepare('SELECT * FROM outbox_jobs WHERE idempotency_key = ?');
		const insert = this.database.prepare(`
			INSERT INTO outbox_jobs (
				kind, idempotency_key, order_id, attempt_count,
				next_attempt_at, completed_at, last_error_code
			) VALUES (?, ?, ?, 0, ?, NULL, NULL)
		`);
		const enqueueJob = this.database.transaction(() => {
			const existing = find.get(input.idempotencyKey) as OutboxRow | undefined;
			if (existing) {
				const job = mapJob(existing);
				if (job.kind !== input.kind || job.orderId !== input.orderId) {
					fail('OUTBOX_IDEMPOTENCY_CONFLICT');
				}
				return;
			}
			insert.run(input.kind, input.idempotencyKey, input.orderId, nextAttemptAt);
		});

		try {
			enqueueJob.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('OUTBOX_ENQUEUE_FAILED');
		}
	}

	enqueueOperationalAlert(input: OperationalAlertOutboxInput): void {
		const nextAttemptAt = validateNewJob(input, true);
		const observedAt = isoTimestamp(input.observedAt, 'OUTBOX_JOB_INVALID');
		let parsed: AlertRecord;
		try {
			parsed = parseAlertIdempotencyKey(input.idempotencyKey);
		} catch {
			fail('OUTBOX_JOB_INVALID');
		}
		if (parsed.code !== input.code || parsed.subjectId !== input.subjectId) {
			fail('OUTBOX_JOB_INVALID');
		}
		const observedBucket = input.observedAt
			.toISOString()
			.slice(0, input.code === 'ORDER_PENDING_REVIEW' || input.code === 'BACKUP_MISSED' ? 10 : 13);
		const keyBucket = parsed.observedAt.toISOString().slice(0, observedBucket.length);
		if (observedBucket !== keyBucket) fail('OUTBOX_JOB_INVALID');

		const find = this.database.prepare('SELECT * FROM outbox_jobs WHERE idempotency_key = ?');
		const insert = this.database.prepare(`
			INSERT INTO outbox_jobs (
				kind, idempotency_key, order_id, attempt_count,
				next_attempt_at, completed_at, last_error_code,
				alert_code, alert_subject_id, alert_observed_at
			) VALUES ('operational-alert', ?, NULL, 0, ?, NULL, NULL, ?, ?, ?)
		`);
		const enqueueJob = this.database.transaction(() => {
			const existing = find.get(input.idempotencyKey) as OutboxRow | undefined;
			if (existing) {
				const job = mapJob(existing);
				if (
					job.kind !== 'operational-alert' ||
					job.orderId !== null ||
					existing.alert_code !== input.code ||
					existing.alert_subject_id !== input.subjectId
				) {
					fail('OUTBOX_IDEMPOTENCY_CONFLICT');
				}
				const existingObservedAt = dateFromIso(existing.alert_observed_at, 'OUTBOX_ROW_INVALID');
				const existingBucket = existingObservedAt.toISOString().slice(0, observedBucket.length);
				if (existingBucket !== observedBucket) fail('OUTBOX_IDEMPOTENCY_CONFLICT');
				return;
			}
			insert.run(input.idempotencyKey, nextAttemptAt, input.code, input.subjectId, observedAt);
		});

		try {
			enqueueJob.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('OUTBOX_ENQUEUE_FAILED');
		}
	}

	ensureShipping(orderId: string, trackingNumber: string, now: Date): boolean {
		const reference = shippingReference(orderId, trackingNumber);
		const timestamp = isoTimestamp(now, 'SHIPPING_EMAIL_REFERENCE_INVALID');
		const findDelivery = this.database.prepare(
			'SELECT * FROM email_deliveries WHERE idempotency_key = ?'
		);
		const findJob = this.database.prepare('SELECT * FROM outbox_jobs WHERE idempotency_key = ?');
		const insert = this.database.prepare(`
			INSERT INTO outbox_jobs (
				kind, idempotency_key, order_id, attempt_count,
				next_attempt_at, completed_at, last_error_code
			) VALUES ('shipping-email', ?, ?, 0, ?, NULL, NULL)
		`);
		const reopen = this.database.prepare(`
			UPDATE outbox_jobs SET completed_at = NULL, next_attempt_at = ?, last_error_code = NULL
			WHERE id = ? AND completed_at IS NOT NULL
		`);
		const ensure = this.database.transaction(() => {
			const delivery = findDelivery.get(reference.idempotencyKey) as EmailDeliveryRow | undefined;
			if (delivery) {
				validateEmailRow(delivery, reference);
				if (delivery.completed_at !== null) return false;
			}
			const row = findJob.get(reference.idempotencyKey) as OutboxRow | undefined;
			if (!row) {
				insert.run(reference.idempotencyKey, reference.orderId, timestamp);
				return true;
			}
			const job = mapJob(row);
			if (job.kind !== 'shipping-email' || job.orderId !== orderId) {
				fail('OUTBOX_IDEMPOTENCY_CONFLICT');
			}
			if (job.completedAt === null) return false;
			if (reopen.run(timestamp, job.id).changes !== 1) fail('OUTBOX_ENQUEUE_FAILED');
			return true;
		});

		try {
			return ensure.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('OUTBOX_ENQUEUE_FAILED');
		}
	}

	claimDue(now: Date, limit: number): OutboxJob[] {
		const nowTimestamp = isoTimestamp(now, 'OUTBOX_CLAIM_INVALID');
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			fail('OUTBOX_CLAIM_LIMIT_INVALID');
		}
		const leaseDate = new Date(now.getTime() + CLAIM_LEASE_MILLISECONDS);
		const leaseTimestamp = isoTimestamp(leaseDate, 'OUTBOX_CLAIM_INVALID');
		const findDue = this.database.prepare(`
			SELECT * FROM outbox_jobs
			WHERE completed_at IS NULL AND next_attempt_at <= ?
			ORDER BY next_attempt_at, id
			LIMIT ?
		`);
		const reserve = this.database.prepare(`
			UPDATE outbox_jobs
			SET next_attempt_at = ?
			WHERE id = ? AND completed_at IS NULL AND next_attempt_at <= ?
		`);
		const claim = this.database.transaction(() => {
			const rows = findDue.all(nowTimestamp, limit) as OutboxRow[];
			for (const row of rows) {
				if (reserve.run(leaseTimestamp, row.id, nowTimestamp).changes !== 1) {
					fail('OUTBOX_CLAIM_CONFLICT');
				}
			}
			return rows.map((row) => ({ ...mapJob(row), nextAttemptAt: new Date(leaseDate) }));
		});

		try {
			return claim.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('OUTBOX_CLAIM_FAILED');
		}
	}

	complete(id: number, now: Date): void {
		if (!Number.isSafeInteger(id) || id < 1) fail('OUTBOX_JOB_ID_INVALID');
		const timestamp = isoTimestamp(now, 'OUTBOX_COMPLETION_INVALID');
		const find = this.database.prepare('SELECT completed_at FROM outbox_jobs WHERE id = ?');
		const update = this.database.prepare(`
			UPDATE outbox_jobs
			SET completed_at = ?, last_error_code = NULL
			WHERE id = ? AND completed_at IS NULL
		`);
		const completeJob = this.database.transaction(() => {
			const row = find.get(id) as { completed_at: unknown } | undefined;
			if (!row) fail('OUTBOX_JOB_NOT_FOUND');
			if (row.completed_at !== null) {
				dateFromIso(row.completed_at, 'OUTBOX_ROW_INVALID');
				return;
			}
			if (update.run(timestamp, id).changes !== 1) fail('OUTBOX_COMPLETION_CONFLICT');
		});

		try {
			completeJob.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('OUTBOX_COMPLETE_FAILED');
		}
	}

	reschedule(id: number, attemptCount: number, nextAttemptAt: Date, errorCode: string): void {
		if (!Number.isSafeInteger(id) || id < 1) fail('OUTBOX_JOB_ID_INVALID');
		if (!Number.isSafeInteger(attemptCount) || attemptCount < 1 || !isStableErrorCode(errorCode)) {
			fail('OUTBOX_RESCHEDULE_INVALID');
		}
		const timestamp = isoTimestamp(nextAttemptAt, 'OUTBOX_RESCHEDULE_INVALID');
		const find = this.database.prepare(
			'SELECT attempt_count, completed_at FROM outbox_jobs WHERE id = ?'
		);
		const update = this.database.prepare(`
			UPDATE outbox_jobs
			SET attempt_count = ?, next_attempt_at = ?, last_error_code = ?
			WHERE id = ? AND completed_at IS NULL AND attempt_count = ?
		`);
		const rescheduleJob = this.database.transaction(() => {
			const row = find.get(id) as { attempt_count: unknown; completed_at: unknown } | undefined;
			if (!row) fail('OUTBOX_JOB_NOT_FOUND');
			if (row.completed_at !== null) fail('OUTBOX_JOB_COMPLETED');
			if (!Number.isSafeInteger(row.attempt_count)) fail('OUTBOX_ROW_INVALID');
			if (attemptCount !== (row.attempt_count as number) + 1) {
				fail('OUTBOX_ATTEMPT_REGRESSION');
			}
			if (update.run(attemptCount, timestamp, errorCode, id, row.attempt_count).changes !== 1) {
				fail('OUTBOX_ATTEMPT_REGRESSION');
			}
		});

		try {
			rescheduleJob.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('OUTBOX_RESCHEDULE_FAILED');
		}
	}

	beginEmailDelivery(input: EmailDeliveryReference): boolean {
		validateEmailReference(input);
		const find = this.database.prepare('SELECT * FROM email_deliveries WHERE idempotency_key = ?');
		const insert = this.database.prepare(`
			INSERT INTO email_deliveries (
				order_id, kind, tracking_reference, idempotency_key,
				provider_delivery_id, attempt_count, completed_at
			) VALUES (?, ?, ?, ?, NULL, 1, NULL)
		`);
		const increment = this.database.prepare(`
			UPDATE email_deliveries SET attempt_count = attempt_count + 1
			WHERE id = ? AND completed_at IS NULL
		`);
		const begin = this.database.transaction(() => {
			const row = find.get(input.idempotencyKey) as EmailDeliveryRow | undefined;
			if (!row) {
				insert.run(input.orderId, input.kind, input.trackingNumber, input.idempotencyKey);
				return true;
			}
			validateEmailRow(row, input);
			if (row.completed_at !== null) return false;
			if (increment.run(row.id).changes !== 1) fail('EMAIL_DELIVERY_ATTEMPT_FAILED');
			return true;
		});

		try {
			return begin.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('EMAIL_DELIVERY_ATTEMPT_FAILED');
		}
	}

	completeEmailDelivery(
		input: EmailDeliveryReference,
		providerDeliveryId: string,
		now: Date,
		outboxJobId?: number
	): void {
		validateEmailReference(input);
		if (!isNonEmptyString(providerDeliveryId)) fail('EMAIL_DELIVERY_COMPLETION_INVALID');
		if (outboxJobId !== undefined && (!Number.isSafeInteger(outboxJobId) || outboxJobId < 1)) {
			fail('EMAIL_DELIVERY_COMPLETION_INVALID');
		}
		const timestamp = isoTimestamp(now, 'EMAIL_DELIVERY_COMPLETION_INVALID');
		const find = this.database.prepare('SELECT * FROM email_deliveries WHERE idempotency_key = ?');
		const updateDelivery = this.database.prepare(`
			UPDATE email_deliveries
			SET provider_delivery_id = ?, completed_at = ?
			WHERE id = ? AND completed_at IS NULL
		`);
		const updateJob = this.database.prepare(`
			UPDATE outbox_jobs SET completed_at = ?, last_error_code = NULL
			WHERE id = ? AND completed_at IS NULL
		`);
		const complete = this.database.transaction(() => {
			const row = find.get(input.idempotencyKey) as EmailDeliveryRow | undefined;
			if (!row) fail('EMAIL_DELIVERY_NOT_FOUND');
			validateEmailRow(row, input);
			if (row.completed_at !== null) {
				if (row.provider_delivery_id !== providerDeliveryId) {
					fail('EMAIL_DELIVERY_COMPLETION_CONFLICT');
				}
				return;
			}
			if (updateDelivery.run(providerDeliveryId, timestamp, row.id).changes !== 1) {
				fail('EMAIL_DELIVERY_COMPLETION_CONFLICT');
			}
			if (outboxJobId !== undefined && updateJob.run(timestamp, outboxJobId).changes !== 1) {
				fail('OUTBOX_COMPLETION_CONFLICT');
			}
		});

		try {
			complete.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('EMAIL_DELIVERY_COMPLETE_FAILED');
		}
	}
}
