import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteAlertService } from '$lib/server/monitoring/alerts.server';
import { SqliteOperationalChecksJob } from './stale-orders.server';

const migrationsDirectory = resolve('migrations');
const NOW = new Date('2026-07-17T03:00:00.000Z');

let database: ShopDatabase;

function insertOrder(input: {
	id: string;
	status:
		'pending_review' | 'submitting' | 'awaiting_vendor_payment' | 'review_required' | 'shipped';
	paymentStatus?: 'paid' | 'partially_refunded' | 'refunded';
	updatedAt: string;
	trackingNumber?: string | null;
}): void {
	const draftId = `draft_${input.id}`;
	database
		.prepare(
			`INSERT INTO checkout_drafts (
				id, contract_version, currency, total_unit_count, shipping_mode, created_at, expires_at,
				destination_country, shipping_rate_id, shipping_gross_amount
			) VALUES (?, 2, 'eur', 1, 'paid', ?, ?, 'SE', 'shr_paid_8_eur', 800)`
		)
		.run(draftId, input.updatedAt, '2026-08-17T00:00:00.000Z');
	database
		.prepare(
			`INSERT INTO orders (
				id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
				checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
				shipping_tax_amount, tax_amount, total_amount, destination_country, payment_status, fulfillment_status,
				tracking_number, updated_at
			) VALUES (?, ?, ?, ?, ?, 'eur', 2000, 0, 1000, 200, 700, 3500, 'SE', ?, ?, ?, ?)`
		)
		.run(
			input.id,
			`cs_${input.id}`,
			`pi_${input.id}`,
			`cus_${input.id}`,
			draftId,
			input.paymentStatus ?? 'paid',
			input.status,
			input.trackingNumber ?? null,
			input.updatedAt
		);
}

function alertKeys(): string[] {
	return (
		database
			.prepare(
				"SELECT idempotency_key FROM outbox_jobs WHERE kind = 'operational-alert' ORDER BY id"
			)
			.all() as Array<{ idempotency_key: string }>
	).map((row) => row.idempotency_key);
}

function recordTransition(
	orderId: string,
	priorState: string | null,
	nextState: string,
	createdAt: string
): void {
	database
		.prepare(
			`INSERT INTO order_events (
				order_id, actor, action, prior_state, next_state, result, error_code, created_at
			) VALUES (?, 'codex-admin', 'test_transition', ?, ?, 'succeeded', NULL, ?)`
		)
		.run(orderId, priorState, nextState, createdAt);
}

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, migrationsDirectory);
});

afterEach(() => closeDatabase());

describe('daily operational checks', () => {
	it('alerts only paid pending-review orders older than 24 rolling hours', async () => {
		insertOrder({
			id: 'old_order',
			status: 'pending_review',
			updatedAt: '2026-07-16T02:59:59.999Z'
		});
		insertOrder({
			id: 'boundary',
			status: 'pending_review',
			updatedAt: '2026-07-16T03:00:00.000Z'
		});
		insertOrder({ id: 'recent', status: 'pending_review', updatedAt: '2026-07-16T04:00:00.000Z' });
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			readiness: async () => ({
				ready: true,
				checks: { configuration: 'ok', database: 'ok', migrations: 'ok', volume: 'ok', disk: 'ok' }
			})
		});

		await expect(job.run(NOW)).resolves.toMatchObject({ pendingReview: 1 });
		expect(alertKeys()).toContain('alert:ORDER_PENDING_REVIEW:old_order:2026-07-17');
		expect(alertKeys().join(' ')).not.toContain('boundary');
		expect(alertKeys().join(' ')).not.toContain('recent');
	});

	it('alerts review-required state without treating an unattempted shipping email as failed', async () => {
		insertOrder({ id: 'needs_review', status: 'review_required', updatedAt: NOW.toISOString() });
		insertOrder({
			id: 'mail_pending',
			status: 'shipped',
			updatedAt: NOW.toISOString(),
			trackingNumber: 'private-tracking-value'
		});
		const outbox = new SqliteOutboxRepository(database);
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(outbox),
			readiness: async () => ({
				ready: true,
				checks: { configuration: 'ok', database: 'ok', migrations: 'ok', volume: 'ok', disk: 'ok' }
			})
		});

		await expect(job.run(NOW)).resolves.toMatchObject({ shippingUnsent: 0 });

		expect(alertKeys()).toEqual([
			'alert:STYRIA_REVIEW_REQUIRED:needs_review:2026-07-17T03',
			'alert:BACKUP_MISSED:daily-backup:2026-07-17'
		]);
		expect(JSON.stringify(database.prepare('SELECT * FROM outbox_jobs').all())).not.toContain(
			'private-tracking-value'
		);
	});

	it('reports shipping jobs after six failures without emitting another alert', async () => {
		insertOrder({
			id: 'mail_failed',
			status: 'shipped',
			updatedAt: NOW.toISOString(),
			trackingNumber: 'private-tracking-value'
		});
		database
			.prepare(
				`INSERT INTO outbox_jobs (
					kind, idempotency_key, order_id, attempt_count,
					next_attempt_at, completed_at, last_error_code
				) VALUES ('shipping-email', ?, 'mail_failed', 6, ?, NULL, 'EMAIL_PROVIDER_UNAVAILABLE')`
			)
			.run('shipping:mail_failed:private-tracking-value', NOW.toISOString());
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			backupsEnabled: false,
			readiness: async () => ({
				ready: true,
				checks: { configuration: 'ok', database: 'ok', migrations: 'ok', volume: 'ok', disk: 'ok' }
			})
		});

		await expect(job.run(NOW)).resolves.toMatchObject({ shippingUnsent: 1 });
		expect(alertKeys()).toEqual([]);
	});

	it('alerts stuck submissions and reminds operators to pay prepared Styria orders', async () => {
		insertOrder({
			id: 'stuck_submission',
			status: 'submitting',
			updatedAt: '2026-07-17T02:44:59.999Z'
		});
		insertOrder({
			id: 'active_submission',
			status: 'submitting',
			updatedAt: '2026-07-17T02:45:00.000Z'
		});
		insertOrder({
			id: 'pay_in_styria',
			status: 'awaiting_vendor_payment',
			updatedAt: '2026-07-17T02:59:00.000Z'
		});
		insertOrder({
			id: 'refunded_in_styria',
			status: 'awaiting_vendor_payment',
			paymentStatus: 'refunded',
			updatedAt: '2026-07-17T02:59:00.000Z'
		});
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			readiness: async () => ({
				ready: true,
				checks: {
					configuration: 'ok',
					database: 'ok',
					migrations: 'ok',
					volume: 'ok',
					disk: 'ok'
				}
			})
		});

		await job.run(NOW);

		expect(alertKeys()).toContain('alert:STYRIA_REVIEW_REQUIRED:stuck_submission:2026-07-17T03');
		expect(alertKeys()).toContain('alert:STYRIA_PAYMENT_REQUIRED:pay_in_styria:2026-07-17');
		expect(alertKeys()).toContain('alert:STYRIA_REVIEW_REQUIRED:refunded_in_styria:2026-07-17T03');
		expect(alertKeys()).not.toContain(
			'alert:STYRIA_PAYMENT_REQUIRED:refunded_in_styria:2026-07-17'
		);
		expect(alertKeys().join(' ')).not.toContain('active_submission');
	});

	it('alerts each pending or review incident once while allowing a later true state re-entry', async () => {
		insertOrder({
			id: 'pending_incident',
			status: 'pending_review',
			updatedAt: '2026-07-15T03:00:00.000Z'
		});
		recordTransition('pending_incident', null, 'pending_review', '2026-07-15T03:00:00.000Z');
		insertOrder({
			id: 'review_incident',
			status: 'review_required',
			updatedAt: '2026-07-16T03:00:00.000Z'
		});
		recordTransition(
			'review_incident',
			'submitting',
			'review_required',
			'2026-07-16T03:00:00.000Z'
		);
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			backupsEnabled: false,
			readiness: async () => ({
				ready: true,
				checks: {
					configuration: 'ok',
					database: 'ok',
					migrations: 'ok',
					volume: 'ok',
					disk: 'ok'
				}
			})
		});

		await job.run(NOW);
		database
			.prepare(
				`UPDATE outbox_jobs SET completed_at = ?
				 WHERE alert_code IN ('ORDER_PENDING_REVIEW', 'STYRIA_REVIEW_REQUIRED')`
			)
			.run('2026-07-17T03:05:00.000Z');
		await job.run(new Date('2026-07-18T03:00:00.000Z'));

		expect(alertKeys().filter((key) => key.includes('pending_incident'))).toHaveLength(1);
		expect(alertKeys().filter((key) => key.includes('review_incident'))).toHaveLength(1);

		// A same-state audit/update is still the same incident.
		database
			.prepare('UPDATE orders SET updated_at = ? WHERE id = ?')
			.run('2026-07-18T04:00:00.000Z', 'review_incident');
		recordTransition(
			'review_incident',
			'review_required',
			'review_required',
			'2026-07-18T04:00:00.000Z'
		);
		await job.run(new Date('2026-07-18T05:00:00.000Z'));
		expect(alertKeys().filter((key) => key.includes('review_incident'))).toHaveLength(1);

		// Leaving and re-entering review starts a new incident and permits one new alert.
		database
			.prepare('UPDATE orders SET fulfillment_status = ?, updated_at = ? WHERE id = ?')
			.run('in_production', '2026-07-18T05:30:00.000Z', 'review_incident');
		recordTransition(
			'review_incident',
			'review_required',
			'in_production',
			'2026-07-18T05:30:00.000Z'
		);
		database
			.prepare('UPDATE orders SET fulfillment_status = ?, updated_at = ? WHERE id = ?')
			.run('review_required', '2026-07-18T06:00:00.000Z', 'review_incident');
		recordTransition(
			'review_incident',
			'in_production',
			'review_required',
			'2026-07-18T06:00:00.000Z'
		);
		await job.run(new Date('2026-07-18T07:00:00.000Z'));

		expect(alertKeys().filter((key) => key.includes('review_incident'))).toHaveLength(2);
	});

	it('requires a completed run for the current 02:30 UTC backup cadence', async () => {
		database
			.prepare(
				`INSERT INTO job_runs (name, owner_id, started_at, finished_at, result)
				 VALUES ('backup', 'prior-owner', ?, ?, 'completed')`
			)
			.run('2026-07-17T02:30:00.000Z', '2026-07-17T02:45:00.000Z');
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			readiness: async () => ({
				ready: true,
				checks: { configuration: 'ok', database: 'ok', migrations: 'ok', volume: 'ok', disk: 'ok' }
			})
		});

		await job.run(NOW);
		expect(alertKeys()).not.toContain('alert:BACKUP_MISSED:daily-backup:2026-07-17');

		database.prepare('DELETE FROM job_runs').run();
		database
			.prepare(
				`INSERT INTO job_runs (name, owner_id, started_at, finished_at, result)
				 VALUES ('backup', 'stale-owner', ?, ?, 'completed')`
			)
			.run('2026-07-16T02:30:00.000Z', '2026-07-16T02:45:00.000Z');
		await job.run(NOW);
		expect(alertKeys()).toContain('alert:BACKUP_MISSED:daily-backup:2026-07-17');
	});

	it('does not report a missed backup when backup scheduling is disabled', async () => {
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			backupsEnabled: false,
			readiness: async () => ({
				ready: true,
				checks: {
					configuration: 'ok',
					database: 'ok',
					migrations: 'ok',
					volume: 'ok',
					disk: 'ok'
				}
			})
		});

		await expect(job.run(NOW)).resolves.toMatchObject({
			backupMissed: false,
			retryAt: null
		});
		expect(alertKeys()).not.toContain('alert:BACKUP_MISSED:daily-backup:2026-07-17');
	});

	it('alerts a failed current-cadence backup and suppresses a genuinely active leased run', async () => {
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			readiness: async () => ({
				ready: true,
				checks: { configuration: 'ok', database: 'ok', migrations: 'ok', volume: 'ok', disk: 'ok' }
			})
		});
		database
			.prepare(
				`INSERT INTO job_runs (name, owner_id, started_at, finished_at, result, error_code)
				 VALUES ('backup', 'failed-owner', ?, ?, 'failed', 'BACKUP_FAILED')`
			)
			.run('2026-07-17T02:30:00.000Z', '2026-07-17T02:40:00.000Z');

		await job.run(NOW);
		expect(alertKeys()).toContain('alert:BACKUP_MISSED:daily-backup:2026-07-17');

		database.prepare('DELETE FROM outbox_jobs').run();
		database.prepare('DELETE FROM job_runs').run();
		database
			.prepare(
				`INSERT INTO job_runs (name, owner_id, started_at)
				 VALUES ('backup', 'active-owner', ?)`
			)
			.run('2026-07-17T02:30:00.000Z');
		database
			.prepare(`INSERT INTO job_leases (name, owner_id, expires_at) VALUES ('backup', ?, ?)`)
			.run('active-owner', '2026-07-17T04:30:00.000Z');

		const activeResult = await job.run(NOW);
		expect(alertKeys()).not.toContain('alert:BACKUP_MISSED:daily-backup:2026-07-17');
		expect(activeResult.retryAt).toEqual(new Date('2026-07-17T04:30:00.000Z'));

		await job.run(new Date('2026-07-17T04:30:00.000Z'));
		expect(alertKeys()).toContain('alert:BACKUP_MISSED:daily-backup:2026-07-17');
	});

	it('suppresses a deferred backup alert when the active run completes before lease expiry', async () => {
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			readiness: async () => ({
				ready: true,
				checks: { configuration: 'ok', database: 'ok', migrations: 'ok', volume: 'ok', disk: 'ok' }
			})
		});
		database
			.prepare(
				`INSERT INTO job_runs (name, owner_id, started_at)
				 VALUES ('backup', 'active-owner', ?)`
			)
			.run('2026-07-17T02:30:00.000Z');
		database
			.prepare(`INSERT INTO job_leases (name, owner_id, expires_at) VALUES ('backup', ?, ?)`)
			.run('active-owner', '2026-07-17T04:30:00.000Z');

		const deferred = await job.run(NOW);
		expect(deferred.retryAt).toEqual(new Date('2026-07-17T04:30:00.000Z'));
		database
			.prepare(
				`UPDATE job_runs SET finished_at = ?, result = 'completed'
				 WHERE name = 'backup' AND owner_id = 'active-owner'`
			)
			.run('2026-07-17T03:15:00.000Z');
		database.prepare("DELETE FROM job_leases WHERE name = 'backup'").run();

		const completed = await job.run(new Date('2026-07-17T04:30:00.000Z'));
		expect(completed.retryAt).toBeNull();
		expect(alertKeys()).not.toContain('alert:BACKUP_MISSED:daily-backup:2026-07-17');
	});

	it('allows the explicit 30-minute backup grace before reporting a missing cadence', async () => {
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			readiness: async () => ({
				ready: true,
				checks: { configuration: 'ok', database: 'ok', migrations: 'ok', volume: 'ok', disk: 'ok' }
			})
		});

		await job.run(new Date('2026-07-17T02:59:59.999Z'));
		expect(alertKeys()).not.toContain('alert:BACKUP_MISSED:daily-backup:2026-07-17');

		await job.run(NOW);
		expect(alertKeys()).toContain('alert:BACKUP_MISSED:daily-backup:2026-07-17');
	});

	it('maps local low-disk and failed SQLite readiness without making the check depend on email', async () => {
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			readiness: async () => ({
				ready: false,
				checks: {
					configuration: 'ok',
					database: 'failed',
					migrations: 'failed',
					volume: 'failed',
					disk: 'low'
				}
			})
		});

		await job.run(NOW);
		expect(alertKeys()).toEqual([
			'alert:BACKUP_MISSED:daily-backup:2026-07-17',
			'alert:DISK_LOW:data-volume:2026-07-17T03',
			'alert:SQLITE_NOT_READY:shop-database:2026-07-17T03'
		]);
	});

	it('emits nothing after recovery and remains idempotent on recurrence in a bucket', async () => {
		let low = true;
		const job = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			readiness: async () => ({
				ready: !low,
				checks: {
					configuration: 'ok',
					database: 'ok',
					migrations: 'ok',
					volume: 'ok',
					disk: low ? 'low' : 'ok'
				}
			})
		});

		await job.run(NOW);
		low = false;
		await job.run(new Date('2026-07-17T03:30:00Z'));
		low = true;
		await job.run(new Date('2026-07-17T03:45:00Z'));
		expect(alertKeys().filter((key) => key.startsWith('alert:DISK_LOW'))).toHaveLength(1);

		await job.run(new Date('2026-07-17T04:00:00Z'));
		expect(alertKeys().filter((key) => key.startsWith('alert:DISK_LOW'))).toHaveLength(2);
	});
});
