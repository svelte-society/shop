import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateWithdrawalReference } from '$lib/domain/withdrawals';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import {
	AlertError,
	SqliteAlertService,
	alertMessage,
	parseAlertIdempotencyKey
} from './alerts.server';

const migrationsDirectory = resolve('migrations');

let database: ShopDatabase;
let alerts: SqliteAlertService;

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, migrationsDirectory);
	alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
});

afterEach(() => closeDatabase());

describe('operational alerts', () => {
	it('uses exact UTC daily and hourly idempotency buckets', () => {
		alerts.enqueueAlert('ORDER_PENDING_REVIEW', 'ord_123', new Date('2026-12-31T23:59:59.999Z'));
		alerts.enqueueAlert(
			'CHECKOUT_UNAVAILABLE',
			'stripe-checkout',
			new Date('2027-01-01T00:01:00Z')
		);

		expect(
			database
				.prepare(
					`SELECT kind, idempotency_key, order_id, alert_code, alert_subject_id,
						alert_observed_at FROM outbox_jobs ORDER BY id`
				)
				.all()
		).toEqual([
			{
				kind: 'operational-alert',
				idempotency_key: 'alert:ORDER_PENDING_REVIEW:ord_123:2026-12-31',
				order_id: null,
				alert_code: 'ORDER_PENDING_REVIEW',
				alert_subject_id: 'ord_123',
				alert_observed_at: '2026-12-31T23:59:59.999Z'
			},
			{
				kind: 'operational-alert',
				idempotency_key: 'alert:CHECKOUT_UNAVAILABLE:stripe-checkout:2027-01-01T00',
				order_id: null,
				alert_code: 'CHECKOUT_UNAVAILABLE',
				alert_subject_id: 'stripe-checkout',
				alert_observed_at: '2027-01-01T00:01:00.000Z'
			}
		]);
	});

	it('coalesces recurrence in one bucket and permits a later bucket', () => {
		alerts.enqueueAlert('DISK_LOW', 'data-volume', new Date('2026-07-17T08:00:00Z'));
		alerts.enqueueAlert('DISK_LOW', 'data-volume', new Date('2026-07-17T08:59:59Z'));
		alerts.enqueueAlert('DISK_LOW', 'data-volume', new Date('2026-07-17T09:00:00Z'));

		expect(database.prepare('SELECT COUNT(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 2
		});
		expect(database.prepare('SELECT alert_observed_at FROM outbox_jobs ORDER BY id').all()).toEqual(
			[
				{ alert_observed_at: '2026-07-17T08:00:00.000Z' },
				{ alert_observed_at: '2026-07-17T09:00:00.000Z' }
			]
		);
	});

	it.each([
		'customer@example.com',
		'203.0.113.10',
		'<script>',
		'a'.repeat(65),
		'order id',
		'line\nbreak'
	])('rejects unsafe or identifying subject input: %s', (subjectId) => {
		expect(() =>
			alerts.enqueueAlert('SQLITE_NOT_READY', subjectId, new Date('2026-07-17T08:00:00Z'))
		).toThrowError(new AlertError('ALERT_SUBJECT_INVALID'));
		expect(database.prepare('SELECT COUNT(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 0
		});
	});

	it('rejects malformed kind and idempotency combinations at the repository boundary', () => {
		const outbox = new SqliteOutboxRepository(database);
		expect(() =>
			outbox.enqueue({
				kind: 'paid-order-alert',
				idempotencyKey: 'alert:DISK_LOW:data-volume:2026-07-17T08',
				orderId: null,
				nextAttemptAt: new Date('2026-07-17T08:00:00Z')
			})
		).toThrowError('OUTBOX_JOB_INVALID');
		expect(() =>
			outbox.enqueue({
				kind: 'operational-alert',
				idempotencyKey: 'shipping:ord_123:tracking_123',
				orderId: null,
				nextAttemptAt: new Date('2026-07-17T08:00:00Z')
			})
		).toThrowError('OUTBOX_JOB_INVALID');
	});

	it('parses fixed safe metadata and renders terse actionable mail without private data', () => {
		const parsed = parseAlertIdempotencyKey('alert:SHIPPING_EMAIL_UNSENT:ord_123:2026-07-17T08');
		const message = alertMessage(parsed);
		const serialized = JSON.stringify(message);

		expect(parsed).toEqual({
			code: 'SHIPPING_EMAIL_UNSENT',
			subjectId: 'ord_123',
			observedAt: new Date('2026-07-17T08:00:00.000Z')
		});
		expect(message.subject).toBe('[SHIPPING_EMAIL_UNSENT] Shop operational alert');
		expect(message.html).toContain('Code: SHIPPING_EMAIL_UNSENT');
		expect(message.html).toContain('Subject: ord_123');
		expect(message.html).toContain('Observed UTC: 2026-07-17T08:00:00.000Z');
		expect(message.html).toContain(
			'Inspect the shipping email outbox job and Plunk delivery status.'
		);
		expect(serialized).not.toContain('customer@example.com');
		expect(serialized).not.toContain('private-tracking-value');
		expect(serialized).not.toContain('Bearer private-token');
		expect(serialized).not.toContain('203.0.113.10');
		expect(serialized).not.toContain('Error: provider stack');
		expect(() =>
			parseAlertIdempotencyKey('alert:DISK_LOW:customer@example.com:2026-07-17T08')
		).toThrowError('ALERT_JOB_INVALID');
	});

	it('accepts the PII-free withdrawal notice alert and renders only its public reference', () => {
		alerts.enqueueAlert(
			'WITHDRAWAL_NOTICE_RECEIVED',
			'WDR-AAAAAAAAAAAAAAAAAAAAAA',
			new Date('2026-07-17T08:12:34.000Z')
		);
		const row = database.prepare('SELECT idempotency_key FROM outbox_jobs').get() as {
			idempotency_key: string;
		};
		const message = alertMessage(parseAlertIdempotencyKey(row.idempotency_key));

		expect(row.idempotency_key).toBe(
			'alert:WITHDRAWAL_NOTICE_RECEIVED:WDR-AAAAAAAAAAAAAAAAAAAAAA:2026-07-17T08'
		);
		expect(message.subject).toBe('[WITHDRAWAL_NOTICE_RECEIVED] Shop operational alert');
		expect(message.html).toContain('Subject: WDR-AAAAAAAAAAAAAAAAAAAAAA');
		expect(message.html).toContain(
			'Open Codex and inspect the withdrawal notice before reconciliation.'
		);
		expect(JSON.stringify(message)).not.toContain('customer@example.com');
	});

	it.each(['WITHDRAWAL_MESSAGE_UNSENT', 'WITHDRAWAL_DATA_UNREADABLE'] as const)(
		'accepts a generated WDR reference for %s without private alert fields',
		(code) => {
			const reference = generateWithdrawalReference(() => Buffer.alloc(16, 7));
			alerts.enqueueAlert(code, reference, new Date('2026-07-17T09:12:34.000Z'));

			const row = database
				.prepare(
					`SELECT alert_code, alert_subject_id, alert_observed_at
					 FROM outbox_jobs WHERE alert_code = ?`
				)
				.get(code);
			expect(row).toEqual({
				alert_code: code,
				alert_subject_id: reference,
				alert_observed_at: '2026-07-17T09:12:34.000Z'
			});
			expect(JSON.stringify(row)).not.toContain('customer@example.com');
		}
	);
});
