import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteFulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import type { StyriaGateway } from '$lib/server/styria/gateway';
import { StyriaError } from '$lib/server/styria/gateway';
import type { StyriaOrder } from '$lib/server/styria/types';
import { SqliteAlertService } from '$lib/server/monitoring/alerts.server';
import { SqliteStyriaSyncJob } from './styria-sync.server';

const migrationsDirectory = resolve('migrations');
const now = new Date('2026-07-17T12:00:00.000Z');

function insertOrder(
	database: ShopDatabase,
	input: {
		id: string;
		fulfillmentStatus?: string;
		styriaStatus?: string;
		trackingNumber?: string | null;
	}
): void {
	const fulfillmentStatus = input.fulfillmentStatus ?? 'awaiting_vendor_payment';
	const styriaStatus = input.styriaStatus ?? 'received';
	const trackingNumber = input.trackingNumber ?? null;
	const draftId = `draft_${input.id}`;
	database
		.prepare(
			`INSERT INTO checkout_drafts (
				id, stripe_checkout_session_id, contract_version, currency, total_unit_count,
				shipping_mode, created_at, expires_at, completed_at
			) VALUES (?, ?, 1, 'eur', 1, 'paid', ?, ?, ?)`
		)
		.run(
			draftId,
			`cs_${input.id}`,
			'2026-07-17T08:00:00.000Z',
			'2026-07-17T09:00:00.000Z',
			'2026-07-17T08:30:00.000Z'
		);
	database
		.prepare(
			`INSERT INTO orders (
				id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
				checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
				tax_amount, total_amount, destination_country, payment_status, fulfillment_status,
				styria_order_id, styria_status, tracking_number, submitted_at, shipped_at,
				updated_at, last_error_code
			) VALUES (?, ?, ?, ?, ?, 'eur', 2000, 0, 1000, 750, 3750, 'SE', 'paid', ?, ?, ?, ?,
				'2026-07-17T09:00:00.000Z', ?, '2026-07-17T10:00:00.000Z', NULL)`
		)
		.run(
			input.id,
			`cs_${input.id}`,
			`pi_${input.id}`,
			`cus_${input.id}`,
			draftId,
			fulfillmentStatus,
			`styria_${input.id}`,
			styriaStatus,
			trackingNumber,
			fulfillmentStatus === 'shipped' ? '2026-07-17T10:00:00.000Z' : null
		);
	database
		.prepare(
			`INSERT INTO order_lines (
				order_id, line_index, stripe_product_id, stripe_price_id, product_name,
				variant_label, sku, styria_product_number, design_reference, design_json,
				quantity, unit_amount, currency
			) VALUES (?, 0, ?, ?, 'Community Tee', 'M', ?, ?, ?,
				'{"front":"https://cdn.example.test/front.svg"}', 1, 2000, 'eur')`
		)
		.run(
			input.id,
			`prod_${input.id}`,
			`price_${input.id}`,
			`SKU_${input.id}`,
			`PN_${input.id}`,
			`design_${input.id}`
		);
}

function providerOrder(
	orderId: string,
	status: string,
	trackingNumber: string | null = null,
	deleted = false
): StyriaOrder {
	return {
		id: orderId,
		external_id: null,
		created_at: '2026-07-17T09:00:00.000Z',
		status,
		deleted,
		shipping_address: { country: 'Sweden' },
		shipping: { shippingMethod: 'courier', trackingNumber, shiped_at: null },
		items: []
	};
}

function gateway(get: StyriaGateway['get']): StyriaGateway {
	return {
		get,
		searchByExternalId: vi.fn(async () => []),
		create: vi.fn(async () => {
			throw new Error('TEST_CREATE_NOT_EXPECTED');
		})
	};
}

function completedDelivery(database: ShopDatabase, orderId: string, trackingNumber: string): void {
	database
		.prepare(
			`INSERT INTO email_deliveries (
				order_id, kind, tracking_reference, idempotency_key,
				provider_delivery_id, attempt_count, completed_at
			) VALUES (?, 'shipping', ?, ?, 'plunk_completed', 1, ?)`
		)
		.run(orderId, trackingNumber, `shipping:${orderId}:${trackingNumber}`, now.toISOString());
}

let database: ShopDatabase;

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, migrationsDirectory);
});

afterEach(() => {
	closeDatabase();
});

describe('SqliteStyriaSyncJob', () => {
	it('alerts review-required transitions and tracked-but-unsent delivery without provider retry data', async () => {
		insertOrder(database, { id: 'review_transition', fulfillmentStatus: 'in_production' });
		const outbox = new SqliteOutboxRepository(database);
		const job = new SqliteStyriaSyncJob({
			database,
			styria: gateway(
				vi.fn(async (id) => providerOrder(id, 'unknown-private-provider-status', 'TRACK-PRIVATE'))
			),
			fulfillment: new SqliteFulfillmentRepository(database),
			outbox,
			alerts: new SqliteAlertService(outbox)
		});

		await job.run(now);
		expect(
			database
				.prepare(
					"SELECT idempotency_key FROM outbox_jobs WHERE kind = 'operational-alert' ORDER BY id"
				)
				.all()
		).toEqual([
			{
				idempotency_key: 'alert:STYRIA_REVIEW_REQUIRED:review_transition:2026-07-17T12'
			},
			{
				idempotency_key: 'alert:SHIPPING_EMAIL_UNSENT:review_transition:2026-07-17T12'
			}
		]);
		expect(
			JSON.stringify(
				database.prepare("SELECT * FROM outbox_jobs WHERE kind = 'operational-alert'").all()
			)
		).not.toContain('TRACK-PRIVATE');
		expect(
			JSON.stringify(
				database.prepare("SELECT * FROM outbox_jobs WHERE kind = 'operational-alert'").all()
			)
		).not.toContain('unknown-private-provider-status');
	});

	it('polls only non-terminal orders, maps current states, and retains state when Styria is unavailable', async () => {
		insertOrder(database, { id: 'production' });
		insertOrder(database, {
			id: 'unavailable',
			fulfillmentStatus: 'awaiting_vendor_payment'
		});
		insertOrder(database, {
			id: 'unknown',
			fulfillmentStatus: 'in_production',
			styriaStatus: 'printing'
		});
		insertOrder(database, { id: 'cancelled', fulfillmentStatus: 'cancelled' });
		insertOrder(database, {
			id: 'complete',
			fulfillmentStatus: 'shipped',
			styriaStatus: 'printing',
			trackingNumber: 'TRACK-COMPLETE'
		});
		completedDelivery(database, 'complete', 'TRACK-COMPLETE');
		const get = vi.fn(async (orderId: string) => {
			if (orderId === 'styria_unavailable') throw new StyriaError('STYRIA_UNAVAILABLE');
			if (orderId === 'styria_unknown') return providerOrder(orderId, 'surprise status');
			return providerOrder(orderId, 'printing');
		});
		const job = new SqliteStyriaSyncJob({
			database,
			styria: gateway(get),
			fulfillment: new SqliteFulfillmentRepository(database),
			outbox: new SqliteOutboxRepository(database)
		});

		await expect(job.run(now)).resolves.toEqual({ checked: 3, updated: 2, shippingQueued: 0 });
		expect(get.mock.calls.map(([id]) => id)).toEqual([
			'styria_production',
			'styria_unavailable',
			'styria_unknown'
		]);
		expect(
			database
				.prepare(
					`SELECT id, fulfillment_status, styria_status, last_error_code
					FROM orders ORDER BY id`
				)
				.all()
		).toEqual([
			expect.objectContaining({ id: 'cancelled', fulfillment_status: 'cancelled' }),
			expect.objectContaining({ id: 'complete', fulfillment_status: 'shipped' }),
			{
				id: 'production',
				fulfillment_status: 'in_production',
				styria_status: 'printing',
				last_error_code: null
			},
			{
				id: 'unavailable',
				fulfillment_status: 'awaiting_vendor_payment',
				styria_status: 'received',
				last_error_code: null
			},
			{
				id: 'unknown',
				fulfillment_status: 'review_required',
				styria_status: 'surprise status',
				last_error_code: 'STYRIA_STATUS_REVIEW_REQUIRED'
			}
		]);
		expect(
			database
				.prepare(
					`SELECT id, styria_last_checked_at FROM orders
					WHERE id IN ('production', 'unavailable', 'unknown') ORDER BY id`
				)
				.all()
		).toEqual([
			{ id: 'production', styria_last_checked_at: now.toISOString() },
			{ id: 'unavailable', styria_last_checked_at: now.toISOString() },
			{ id: 'unknown', styria_last_checked_at: now.toISOString() }
		]);
	});

	it('durably rotates batches larger than 100 without changing unavailable provider state', async () => {
		for (let index = 0; index < 101; index += 1) {
			insertOrder(database, { id: `rotate_${String(index).padStart(3, '0')}` });
		}
		const get = vi.fn(async (orderId: string) => {
			if (orderId.length === 0) throw new Error('TEST_ORDER_ID_MISSING');
			throw new StyriaError('STYRIA_UNAVAILABLE');
		});
		const job = new SqliteStyriaSyncJob({
			database,
			styria: gateway(get),
			fulfillment: new SqliteFulfillmentRepository(database),
			outbox: new SqliteOutboxRepository(database)
		});

		await expect(job.run(now)).resolves.toEqual({ checked: 100, updated: 0, shippingQueued: 0 });
		expect(get).toHaveBeenCalledTimes(100);
		expect(get.mock.calls[0][0]).toBe('styria_rotate_000');
		expect(get.mock.calls[99][0]).toBe('styria_rotate_099');
		expect(
			database
				.prepare(
					`SELECT fulfillment_status, styria_status, styria_last_checked_at
					FROM orders WHERE id = 'rotate_100'`
				)
				.get()
		).toEqual({
			fulfillment_status: 'awaiting_vendor_payment',
			styria_status: 'received',
			styria_last_checked_at: null
		});

		const nextHour = new Date(now.getTime() + 60 * 60_000);
		get.mockClear();
		await expect(job.run(nextHour)).resolves.toEqual({
			checked: 100,
			updated: 0,
			shippingQueued: 0
		});
		expect(get).toHaveBeenCalledTimes(100);
		expect(get.mock.calls[0][0]).toBe('styria_rotate_100');
		expect(
			database
				.prepare(
					`SELECT fulfillment_status, styria_status, styria_last_checked_at
					FROM orders WHERE id = 'rotate_100'`
				)
				.get()
		).toEqual({
			fulfillment_status: 'awaiting_vendor_payment',
			styria_status: 'received',
			styria_last_checked_at: nextHour.toISOString()
		});
	});

	it('does not advance the durable cursor when a candidate crashes before handling completes', async () => {
		insertOrder(database, { id: 'crash_retry' });
		const get = vi
			.fn<StyriaGateway['get']>()
			.mockRejectedValueOnce(new Error('unexpected local crash'))
			.mockRejectedValueOnce(new StyriaError('STYRIA_UNAVAILABLE'));
		const job = new SqliteStyriaSyncJob({
			database,
			styria: gateway(get),
			fulfillment: new SqliteFulfillmentRepository(database),
			outbox: new SqliteOutboxRepository(database)
		});

		await expect(job.run(now)).rejects.toThrow('unexpected local crash');
		expect(
			database.prepare("SELECT styria_last_checked_at FROM orders WHERE id = 'crash_retry'").get()
		).toEqual({ styria_last_checked_at: null });

		const nextHour = new Date(now.getTime() + 60 * 60_000);
		await expect(job.run(nextHour)).resolves.toEqual({
			checked: 1,
			updated: 0,
			shippingQueued: 0
		});
		expect(get).toHaveBeenCalledTimes(2);
		expect(
			database.prepare("SELECT styria_last_checked_at FROM orders WHERE id = 'crash_retry'").get()
		).toEqual({ styria_last_checked_at: nextHour.toISOString() });
	});

	it('updates tracking and enqueues the exact shipping key atomically and idempotently', async () => {
		insertOrder(database, {
			id: 'tracking',
			fulfillmentStatus: 'in_production',
			styriaStatus: 'printing'
		});
		const get = vi.fn(async (id: string) => providerOrder(id, 'printing', 'TRACK-2042'));
		const job = new SqliteStyriaSyncJob({
			database,
			styria: gateway(get),
			fulfillment: new SqliteFulfillmentRepository(database),
			outbox: new SqliteOutboxRepository(database)
		});

		await expect(job.run(now)).resolves.toEqual({ checked: 1, updated: 1, shippingQueued: 1 });
		expect(
			database
				.prepare(
					`SELECT fulfillment_status, tracking_number, shipped_at
					FROM orders WHERE id = 'tracking'`
				)
				.get()
		).toEqual({
			fulfillment_status: 'shipped',
			tracking_number: 'TRACK-2042',
			shipped_at: now.toISOString()
		});
		expect(database.prepare('SELECT * FROM outbox_jobs').all()).toEqual([
			expect.objectContaining({
				kind: 'shipping-email',
				idempotency_key: 'shipping:tracking:TRACK-2042',
				order_id: 'tracking',
				next_attempt_at: now.toISOString(),
				completed_at: null
			})
		]);

		await expect(job.run(new Date(now.getTime() + 60 * 60_000))).resolves.toEqual({
			checked: 1,
			updated: 0,
			shippingQueued: 0
		});
		expect(get).toHaveBeenCalledOnce();
		expect(database.prepare('SELECT COUNT(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 1
		});
	});

	it('rolls back the status update when the matching shipping enqueue fails', async () => {
		insertOrder(database, {
			id: 'atomic',
			fulfillmentStatus: 'in_production',
			styriaStatus: 'printing'
		});
		database
			.prepare(
				`CREATE TRIGGER reject_shipping BEFORE INSERT ON outbox_jobs
				WHEN NEW.kind = 'shipping-email'
				BEGIN SELECT RAISE(ABORT, 'shipping enqueue rejected'); END`
			)
			.run();
		const job = new SqliteStyriaSyncJob({
			database,
			styria: gateway(vi.fn(async (id) => providerOrder(id, 'printing', 'TRACK-ATOMIC'))),
			fulfillment: new SqliteFulfillmentRepository(database),
			outbox: new SqliteOutboxRepository(database)
		});

		await expect(job.run(now)).rejects.toMatchObject({ code: 'OUTBOX_ENQUEUE_FAILED' });
		expect(
			database
				.prepare(
					`SELECT fulfillment_status, styria_status, tracking_number, shipped_at, updated_at
					FROM orders WHERE id = 'atomic'`
				)
				.get()
		).toEqual({
			fulfillment_status: 'in_production',
			styria_status: 'printing',
			tracking_number: null,
			shipped_at: null,
			updated_at: '2026-07-17T10:00:00.000Z'
		});
		expect(database.prepare('SELECT * FROM order_events').all()).toEqual([]);
		expect(
			database.prepare("SELECT styria_last_checked_at FROM orders WHERE id = 'atomic'").get()
		).toEqual({ styria_last_checked_at: null });
	});

	it('recovers existing tracking without polling and skips a matching completed delivery', async () => {
		insertOrder(database, {
			id: 'recover',
			fulfillmentStatus: 'shipped',
			styriaStatus: 'printing',
			trackingNumber: 'TRACK-RECOVER'
		});
		database
			.prepare(
				`INSERT INTO outbox_jobs (
					kind, idempotency_key, order_id, attempt_count,
					next_attempt_at, completed_at, last_error_code
				) VALUES ('shipping-email', 'shipping:recover:TRACK-RECOVER', 'recover', 1,
					'2026-07-17T10:00:00.000Z', '2026-07-17T10:05:00.000Z', NULL)`
			)
			.run();
		insertOrder(database, {
			id: 'delivered',
			fulfillmentStatus: 'shipped',
			styriaStatus: 'printing',
			trackingNumber: 'TRACK-DELIVERED'
		});
		completedDelivery(database, 'delivered', 'TRACK-DELIVERED');
		const get = vi.fn(async () => {
			throw new Error('TEST_PROVIDER_NOT_EXPECTED');
		});
		const job = new SqliteStyriaSyncJob({
			database,
			styria: gateway(get),
			fulfillment: new SqliteFulfillmentRepository(database),
			outbox: new SqliteOutboxRepository(database)
		});

		await expect(job.run(now)).resolves.toEqual({ checked: 1, updated: 0, shippingQueued: 1 });
		expect(get).not.toHaveBeenCalled();
		expect(
			database.prepare('SELECT kind, idempotency_key, order_id FROM outbox_jobs').all()
		).toEqual([
			{
				kind: 'shipping-email',
				idempotency_key: 'shipping:recover:TRACK-RECOVER',
				order_id: 'recover'
			}
		]);
		expect(
			database.prepare("SELECT styria_last_checked_at FROM orders WHERE id = 'recover'").get()
		).toEqual({ styria_last_checked_at: now.toISOString() });
	});
});
