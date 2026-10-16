import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShopDatabase } from '$lib/server/db/types';
import { createMcpServer } from '../server';
import { SqliteShippingEmailDiagnosticsService } from './inspect-shipping-email-delivery';

type RpcResult = {
	result: {
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
		structuredContent?: Record<string, unknown>;
	};
};

const currentTracking = 'PRIVATE-TRACKING-CURRENT';
const currentKey = `shipping:order_shipping:${currentTracking}`;
let database: ShopDatabase;

async function callDiagnostics(orderId = 'order_shipping') {
	const server = createMcpServer({
		shippingEmailDiagnostics: new SqliteShippingEmailDiagnosticsService(database)
	});
	return (await server.receive({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name: 'inspect_shipping_email_delivery', arguments: { order_id: orderId } }
	})) as RpcResult;
}

function insertOrder(id: string, trackingNumber: string | null): void {
	database
		.prepare('INSERT INTO orders (id, tracking_number) VALUES (?, ?)')
		.run(id, trackingNumber);
}

function insertJob(
	input: {
		key?: string;
		attemptCount?: number;
		nextAttemptAt?: string;
		completedAt?: string | null;
		lastErrorCode?: string | null;
	} = {}
): void {
	database
		.prepare(
			`INSERT INTO outbox_jobs (
				kind, idempotency_key, order_id, attempt_count,
				next_attempt_at, completed_at, last_error_code
			) VALUES ('shipping-email', ?, 'order_shipping', ?, ?, ?, ?)`
		)
		.run(
			input.key ?? currentKey,
			input.attemptCount ?? 0,
			input.nextAttemptAt ?? '2026-10-16T05:00:00.000Z',
			input.completedAt ?? null,
			input.lastErrorCode ?? null
		);
}

function insertDelivery(
	input: {
		key?: string;
		trackingNumber?: string;
		providerDeliveryId?: string | null;
		completedAt?: string | null;
		attemptCount?: number;
	} = {}
): void {
	database
		.prepare(
			`INSERT INTO email_deliveries (
				order_id, kind, tracking_reference, idempotency_key,
				provider_delivery_id, attempt_count, completed_at
			) VALUES ('order_shipping', 'shipping', ?, ?, ?, ?, ?)`
		)
		.run(
			input.trackingNumber ?? currentTracking,
			input.key ?? currentKey,
			input.providerDeliveryId ?? null,
			input.attemptCount ?? 1,
			input.completedAt ?? null
		);
}

function expectMirrored(response: RpcResult): Record<string, unknown> {
	expect(response.result.isError).not.toBe(true);
	expect(response.result.content).toEqual([
		{ type: 'text', text: JSON.stringify(response.result.structuredContent) }
	]);
	return response.result.structuredContent ?? {};
}

beforeEach(() => {
	database = new Database(':memory:');
	database.exec(`
		CREATE TABLE orders (
			id TEXT PRIMARY KEY,
			tracking_number TEXT
		);
		CREATE TABLE outbox_jobs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			idempotency_key TEXT NOT NULL UNIQUE,
			order_id TEXT,
			attempt_count INTEGER NOT NULL,
			next_attempt_at TEXT NOT NULL,
			completed_at TEXT,
			last_error_code TEXT
		);
		CREATE TABLE email_deliveries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			order_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			tracking_reference TEXT,
			idempotency_key TEXT NOT NULL UNIQUE,
			provider_delivery_id TEXT,
			attempt_count INTEGER NOT NULL,
			completed_at TEXT
		);
	`);
});

afterEach(() => database.close());

describe('shipping email delivery diagnostics', () => {
	it('reports missing tracking and does not mutate the database', async () => {
		insertOrder('order_shipping', null);
		const before = database.serialize();

		const response = await callDiagnostics();

		expect(expectMirrored(response)).toEqual({
			order_id: 'order_shipping',
			state: 'missing_tracking',
			tracking_present: false,
			outbox_job: null,
			delivery_attempt_count: null,
			provider_accepted: false,
			provider_accepted_at: null
		});
		expect(database.serialize()).toEqual(before);
	});

	it('reports not queued for the current tracking reference and ignores historical tracking jobs', async () => {
		insertOrder('order_shipping', currentTracking);
		const oldTracking = 'PRIVATE-TRACKING-OLD';
		const oldKey = `shipping:order_shipping:${oldTracking}`;
		insertJob({
			key: oldKey,
			completedAt: '2026-10-15T05:00:00.000Z',
			nextAttemptAt: '2026-10-15T05:00:00.000Z'
		});
		insertDelivery({
			key: oldKey,
			trackingNumber: oldTracking,
			providerDeliveryId: 'PRIVATE-PROVIDER-OLD',
			completedAt: '2026-10-15T05:00:00.000Z'
		});

		const response = await callDiagnostics();
		const serialized = JSON.stringify(response.result);

		expect(expectMirrored(response)).toEqual({
			order_id: 'order_shipping',
			state: 'not_queued',
			tracking_present: true,
			outbox_job: null,
			delivery_attempt_count: null,
			provider_accepted: false,
			provider_accepted_at: null
		});
		expect(serialized).not.toContain(currentTracking);
		expect(serialized).not.toContain(oldTracking);
		expect(serialized).not.toContain(oldKey);
		expect(serialized).not.toContain('PRIVATE-PROVIDER-OLD');
	});

	it('distinguishes a newly queued job from a retrying job', async () => {
		insertOrder('order_shipping', currentTracking);
		insertJob();

		const queued = await callDiagnostics();
		expect(expectMirrored(queued)).toEqual({
			order_id: 'order_shipping',
			state: 'queued',
			tracking_present: true,
			outbox_job: {
				state: 'pending',
				attempt_count: 0,
				next_attempt_at: '2026-10-16T05:00:00.000Z',
				completed_at: null,
				last_error_code: null
			},
			delivery_attempt_count: null,
			provider_accepted: false,
			provider_accepted_at: null
		});

		database
			.prepare(
				`UPDATE outbox_jobs
				 SET attempt_count = 3, next_attempt_at = ?, last_error_code = ?`
			)
			.run('2026-10-16T06:00:00.000Z', 'SHIPPING_EMAIL_FAILED');
		insertDelivery({ attemptCount: 3 });

		const retrying = await callDiagnostics();
		expect(expectMirrored(retrying)).toMatchObject({
			order_id: 'order_shipping',
			state: 'retrying',
			outbox_job: {
				state: 'pending',
				attempt_count: 3,
				next_attempt_at: '2026-10-16T06:00:00.000Z',
				completed_at: null,
				last_error_code: 'SHIPPING_EMAIL_FAILED'
			},
			delivery_attempt_count: 3,
			provider_accepted: false,
			provider_accepted_at: null
		});
	});

	it('reports an attempt that began but did not record acceptance or a retry schedule', async () => {
		insertOrder('order_shipping', currentTracking);
		insertJob();
		insertDelivery({ attemptCount: 1 });

		const response = await callDiagnostics();

		expect(expectMirrored(response)).toMatchObject({
			order_id: 'order_shipping',
			state: 'attempting',
			outbox_job: {
				state: 'pending',
				attempt_count: 0,
				last_error_code: null
			},
			delivery_attempt_count: 1,
			provider_accepted: false,
			provider_accepted_at: null
		});
	});

	it('reports provider acceptance without returning tracking, idempotency, provider, or recipient data', async () => {
		insertOrder('order_shipping', currentTracking);
		insertJob({
			completedAt: '2026-10-16T05:01:00.000Z',
			nextAttemptAt: '2026-10-16T05:00:00.000Z'
		});
		insertDelivery({
			providerDeliveryId: 'PRIVATE-RESEND-DELIVERY-ID',
			completedAt: '2026-10-16T05:01:00.000Z'
		});

		const response = await callDiagnostics();
		const serialized = JSON.stringify(response.result);

		expect(expectMirrored(response)).toEqual({
			order_id: 'order_shipping',
			state: 'provider_accepted',
			tracking_present: true,
			outbox_job: {
				state: 'completed',
				attempt_count: 0,
				next_attempt_at: '2026-10-16T05:00:00.000Z',
				completed_at: '2026-10-16T05:01:00.000Z',
				last_error_code: null
			},
			delivery_attempt_count: 1,
			provider_accepted: true,
			provider_accepted_at: '2026-10-16T05:01:00.000Z'
		});
		for (const privateValue of [
			currentTracking,
			currentKey,
			'PRIVATE-RESEND-DELIVERY-ID',
			'customer@example.test'
		]) {
			expect(serialized).not.toContain(privateValue);
		}
	});

	it('surfaces inconsistent completion evidence without guessing delivery success', async () => {
		insertOrder('order_shipping', currentTracking);
		insertJob({ completedAt: '2026-10-16T05:01:00.000Z' });

		const response = await callDiagnostics();

		expect(expectMirrored(response)).toMatchObject({
			state: 'inconsistent',
			tracking_present: true,
			outbox_job: { state: 'completed' },
			delivery_attempt_count: null,
			provider_accepted: false,
			provider_accepted_at: null
		});
	});

	it('rejects a malformed stored delivery attempt count', async () => {
		insertOrder('order_shipping', currentTracking);
		insertJob();
		insertDelivery();
		database
			.prepare('UPDATE email_deliveries SET attempt_count = ? WHERE idempotency_key = ?')
			.run('not-a-number', currentKey);

		const response = await callDiagnostics();

		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'SHIPPING_EMAIL_DIAGNOSTICS_INVALID' } }
		});
	});

	it('returns stable opaque errors for missing orders and invalid stored rows', async () => {
		const missing = await callDiagnostics('missing_order');
		expect(missing.result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'ORDER_NOT_FOUND' } }
		});

		insertOrder('order_shipping', currentTracking);
		insertJob({ lastErrorCode: 'private provider said recipient@example.test' });
		const invalid = await callDiagnostics();
		expect(invalid.result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'SHIPPING_EMAIL_DIAGNOSTICS_INVALID' } }
		});
		expect(JSON.stringify(invalid.result)).not.toContain('recipient@example.test');
	});

	it('rejects a completed delivery with a malformed empty provider delivery id', async () => {
		insertOrder('order_shipping', currentTracking);
		insertJob({ completedAt: '2026-10-16T05:01:00.000Z' });
		insertDelivery({
			providerDeliveryId: '',
			completedAt: '2026-10-16T05:01:00.000Z'
		});

		const response = await callDiagnostics();

		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'SHIPPING_EMAIL_DIAGNOSTICS_INVALID' } }
		});
	});
});
