import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { createPlunkClient } from '$lib/server/plunk/client.server';
import { PlunkError } from '$lib/server/plunk/gateway';
import type { ShippingEmailSender } from '$lib/server/plunk/shipping-email';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import { PaidOrderAlertOutboxWorker } from './outbox-worker.server';

const migrationsDirectory = resolve('migrations');
const now = new Date('2026-07-16T08:30:00.000Z');
const alertEmail = {
	to: 'shop-ops@sveltesociety.dev',
	from: { name: 'Svelte Society Shop', email: 'merch@sveltesociety.dev' },
	replyTo: 'merch@sveltesociety.dev'
};

type CapturedRequest = { input: RequestInfo | URL; init?: RequestInit };

function successfulResponse(deliveryId: string): Response {
	return Response.json({
		success: true,
		data: {
			emails: [
				{
					contact: { id: 'cnt_ops', email: alertEmail.to },
					email: deliveryId
				}
			],
			timestamp: now.toISOString()
		}
	});
}

function insertOrder(
	database: ShopDatabase,
	input: {
		id: string;
		totalAmount?: number;
		destinationCountry?: string;
		quantities?: number[];
		fulfillmentStatus?: 'pending_review' | 'shipped';
		trackingNumber?: string | null;
	}
): void {
	const totalAmount = input.totalAmount ?? 4567;
	const destinationCountry = input.destinationCountry ?? 'SE';
	const quantities = input.quantities ?? [2, 1];
	const fulfillmentStatus = input.fulfillmentStatus ?? 'pending_review';
	const trackingNumber = input.trackingNumber ?? null;
	const draftId = `draft_${input.id}`;
	database
		.prepare(
			`INSERT INTO checkout_drafts (
				id, stripe_checkout_session_id, contract_version, currency, total_unit_count,
				shipping_mode, created_at, expires_at, completed_at
			) VALUES (?, ?, 1, 'eur', ?, 'free', ?, ?, ?)`
		)
		.run(
			draftId,
			`cs_${input.id}`,
			quantities.reduce((sum, quantity) => sum + quantity, 0),
			now.toISOString(),
			new Date(now.getTime() + 60_000).toISOString(),
			now.toISOString()
		);
	database
		.prepare(
			`INSERT INTO orders (
				id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
				checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
				tax_amount, total_amount, destination_country, payment_status, fulfillment_status,
				tracking_number, shipped_at, updated_at
			) VALUES (?, ?, ?, ?, ?, 'eur', ?, 0, 0, 0, ?, ?, 'paid', ?, ?, ?, ?)`
		)
		.run(
			input.id,
			`cs_${input.id}`,
			`pi_${input.id}`,
			`cus_${input.id}`,
			draftId,
			totalAmount,
			totalAmount,
			destinationCountry,
			fulfillmentStatus,
			trackingNumber,
			fulfillmentStatus === 'shipped' ? now.toISOString() : null,
			now.toISOString()
		);
	const insertLine = database.prepare(
		`INSERT INTO order_lines (
			order_id, line_index, stripe_product_id, stripe_price_id, product_name,
			variant_label, sku, styria_product_number, design_reference, design_json,
			quantity, unit_amount, currency
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'eur')`
	);
	quantities.forEach((quantity, index) => {
		insertLine.run(
			input.id,
			index,
			`prod_${input.id}_${index}`,
			`price_${input.id}_${index}`,
			`Private product fixture ${index}`,
			`Private variant fixture ${index}`,
			`SKU_${input.id}_${index}`,
			`STYRIA_${input.id}_${index}`,
			`design_${input.id}_${index}`,
			'{}',
			quantity,
			1000
		);
	});
}

function enqueueAlert(outbox: SqliteOutboxRepository, orderId: string): void {
	outbox.enqueue({
		kind: 'paid-order-alert',
		idempotencyKey: `paid-order-alert:${orderId}`,
		orderId,
		nextAttemptAt: now
	});
}

let database: ShopDatabase;
let outbox: SqliteOutboxRepository;

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, migrationsDirectory);
	outbox = new SqliteOutboxRepository(database);
});

afterEach(() => {
	closeDatabase();
});

describe('PaidOrderAlertOutboxWorker', () => {
	it('sends the approved PII-free paid-order alert and completes it exactly once', async () => {
		insertOrder(database, { id: 'order_internal_123' });
		enqueueAlert(outbox, 'order_internal_123');
		const requests: CapturedRequest[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			requests.push({ input, init });
			return successfulResponse('delivery_paid_alert_123');
		};
		const plunk = createPlunkClient({ secretKey: 'sk_test_secret', fetch });
		const worker = new PaidOrderAlertOutboxWorker({ database, outbox, plunk, alertEmail });

		await expect(worker.drain(now)).resolves.toEqual({ completed: 1, rescheduled: 0 });
		expect(requests).toHaveLength(1);
		expect(JSON.parse(String(requests[0].init?.body))).toEqual({
			to: alertEmail.to,
			from: alertEmail.from,
			reply: alertEmail.replyTo,
			subject: 'Svelte Society Shop: paid order awaiting review',
			body:
				'<p>Internal order ID: order_internal_123</p>' +
				'<p>Unit count: 3</p>' +
				'<p>Total: EUR 45.67</p>' +
				'<p>Destination country: SE</p>' +
				'<p>Open Codex and use list_pending_orders.</p>'
		});
		expect(
			database
				.prepare(
					'SELECT attempt_count, completed_at, last_error_code FROM outbox_jobs WHERE order_id = ?'
				)
				.get('order_internal_123')
		).toEqual({
			attempt_count: 0,
			completed_at: now.toISOString(),
			last_error_code: null
		});

		await expect(worker.drain(new Date(now.getTime() + 60_000))).resolves.toEqual({
			completed: 0,
			rescheduled: 0
		});
		expect(requests).toHaveLength(1);
	});

	it('reschedules a transient Plunk failure without blocking the rest of the claimed batch', async () => {
		insertOrder(database, { id: 'order_first_fails' });
		insertOrder(database, { id: 'order_second_succeeds', totalAmount: 2500, quantities: [2] });
		enqueueAlert(outbox, 'order_first_fails');
		enqueueAlert(outbox, 'order_second_succeeds');
		const requestedOrders: string[] = [];
		let firstOrderMaySucceed = false;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { body: string };
			if (body.body.includes('order_first_fails')) {
				requestedOrders.push('order_first_fails');
				if (!firstOrderMaySucceed) {
					return new Response(
						'{"error":"customer@example.test and sk_live_sensitive must never persist"}',
						{ status: 503 }
					);
				}
				return successfulResponse('delivery_first_retry');
			}
			requestedOrders.push('order_second_succeeds');
			return successfulResponse('delivery_second');
		};
		const worker = new PaidOrderAlertOutboxWorker({
			database,
			outbox,
			plunk: createPlunkClient({ secretKey: 'sk_live_sensitive', fetch }),
			alertEmail
		});

		await expect(worker.drain(now, 2)).resolves.toEqual({ completed: 1, rescheduled: 1 });
		expect(requestedOrders).toEqual(['order_first_fails', 'order_second_succeeds']);
		expect(
			database
				.prepare(
					`SELECT order_id, attempt_count, next_attempt_at, completed_at, last_error_code
					FROM outbox_jobs ORDER BY id`
				)
				.all()
		).toEqual([
			{
				order_id: 'order_first_fails',
				attempt_count: 1,
				next_attempt_at: '2026-07-16T08:32:00.000Z',
				completed_at: null,
				last_error_code: 'PLUNK_UNAVAILABLE'
			},
			{
				order_id: 'order_second_succeeds',
				attempt_count: 0,
				next_attempt_at: '2026-07-16T08:35:00.000Z',
				completed_at: now.toISOString(),
				last_error_code: null
			}
		]);
		const persistedJobs = JSON.stringify(database.prepare('SELECT * FROM outbox_jobs').all());
		expect(persistedJobs).not.toContain('customer@example.test');
		expect(persistedJobs).not.toContain('sk_live_sensitive');

		await expect(worker.drain(new Date('2026-07-16T08:31:59.999Z'))).resolves.toEqual({
			completed: 0,
			rescheduled: 0
		});
		firstOrderMaySucceed = true;
		await expect(worker.drain(new Date('2026-07-16T08:32:00.000Z'))).resolves.toEqual({
			completed: 1,
			rescheduled: 0
		});
		expect(requestedOrders).toEqual([
			'order_first_fails',
			'order_second_succeeds',
			'order_first_fails'
		]);
	});

	it('switches the sixth failed attempt to an hourly cadence and keeps later retries hourly', async () => {
		insertOrder(database, { id: 'order_hourly_retry' });
		enqueueAlert(outbox, 'order_hourly_retry');
		let fetchCount = 0;
		const fetch: typeof globalThis.fetch = async () => {
			fetchCount += 1;
			return new Response('{"error":"rate limited"}', { status: 429 });
		};
		const worker = new PaidOrderAlertOutboxWorker({
			database,
			outbox,
			plunk: createPlunkClient({ secretKey: 'sk_test_secret', fetch }),
			alertEmail
		});
		let attemptAt = new Date(now);
		const retryMinutes = [2, 4, 8, 16, 30, 60, 60];

		for (const [index, minutes] of retryMinutes.entries()) {
			await expect(worker.drain(attemptAt)).resolves.toEqual({ completed: 0, rescheduled: 1 });
			const expectedAttempt = index + 1;
			const expectedNextAttempt = new Date(attemptAt.getTime() + minutes * 60_000);
			expect(
				database
					.prepare(
						`SELECT attempt_count, next_attempt_at, completed_at, last_error_code
						FROM outbox_jobs WHERE order_id = ?`
					)
					.get('order_hourly_retry')
			).toEqual({
				attempt_count: expectedAttempt,
				next_attempt_at: expectedNextAttempt.toISOString(),
				completed_at: null,
				last_error_code: 'PLUNK_RATE_LIMITED'
			});
			attemptAt = expectedNextAttempt;
		}

		expect(fetchCount).toBe(7);
	});

	it('isolates an unsupported job with a stable redacted code and continues the batch', async () => {
		outbox.enqueue({
			kind: 'future-email-kind',
			idempotencyKey: 'future-email:fixture',
			orderId: null,
			nextAttemptAt: now
		});
		insertOrder(database, { id: 'order_after_unsupported' });
		enqueueAlert(outbox, 'order_after_unsupported');
		let fetchCount = 0;
		const fetch: typeof globalThis.fetch = async () => {
			fetchCount += 1;
			return successfulResponse('delivery_after_unsupported');
		};
		const worker = new PaidOrderAlertOutboxWorker({
			database,
			outbox,
			plunk: createPlunkClient({ secretKey: 'sk_test_secret', fetch }),
			alertEmail
		});

		await expect(worker.drain(now, 2)).resolves.toEqual({ completed: 1, rescheduled: 1 });
		expect(fetchCount).toBe(1);
		expect(
			database
				.prepare(
					`SELECT attempt_count, next_attempt_at, completed_at, last_error_code
					FROM outbox_jobs WHERE kind = 'future-email-kind'`
				)
				.get()
		).toEqual({
			attempt_count: 1,
			next_attempt_at: '2026-07-16T08:32:00.000Z',
			completed_at: null,
			last_error_code: 'OUTBOX_JOB_KIND_UNSUPPORTED'
		});
	});
});

describe('shipping email outbox', () => {
	function shippingDependencies(input: {
		stripe?: StripeFulfillmentGateway;
		sender?: ShippingEmailSender;
	}) {
		const stripe =
			input.stripe ??
			({
				retrieveFulfillmentDetails: vi.fn(async () => ({
					recipient: {
						firstName: 'Ada',
						lastName: 'Lovelace',
						company: 'Analytical Engines AB',
						phone: '+46 70 123 45 67'
					},
					address: {
						line1: 'Currentgatan 9',
						line2: '',
						city: 'Stockholm',
						state: '',
						postalCode: '111 22',
						countryCode: 'SE'
					},
					email: 'ada@example.test'
				}))
			} satisfies StripeFulfillmentGateway);
		const sender =
			input.sender ??
			({
				send: vi.fn(async () => ({ deliveryId: 'plunk_shipping_2042' }))
			} satisfies ShippingEmailSender);
		return { stripe, sender, supportEmail: 'merch@sveltesociety.dev' };
	}

	it('fetches the current Stripe email immediately before send and atomically records the delivery ID', async () => {
		insertOrder(database, {
			id: 'order_shipping',
			quantities: [2],
			fulfillmentStatus: 'shipped',
			trackingNumber: 'TRACK-2042'
		});
		outbox.enqueue({
			kind: 'shipping-email',
			idempotencyKey: 'shipping:order_shipping:TRACK-2042',
			orderId: 'order_shipping',
			nextAttemptAt: now
		});
		const sequence: string[] = [];
		const stripe = shippingDependencies({}).stripe;
		vi.mocked(stripe.retrieveFulfillmentDetails).mockImplementation(async () => {
			sequence.push('stripe-current-email');
			return {
				recipient: {
					firstName: 'Ada',
					lastName: 'Lovelace',
					company: 'Analytical Engines AB',
					phone: '+46 70 123 45 67'
				},
				address: {
					line1: 'Currentgatan 9',
					line2: '',
					city: 'Stockholm',
					state: '',
					postalCode: '111 22',
					countryCode: 'SE'
				},
				email: 'current@example.test'
			};
		});
		const sender: ShippingEmailSender = {
			send: vi.fn(async (input) => {
				sequence.push('plunk-send');
				expect(input).toEqual({
					recipientEmail: 'current@example.test',
					productSummary: '2 × Private product fixture 0 (Private variant fixture 0)',
					trackingNumber: 'TRACK-2042',
					supportEmail: 'merch@sveltesociety.dev'
				});
				return { deliveryId: 'plunk_shipping_2042' };
			})
		};
		const worker = new PaidOrderAlertOutboxWorker({
			database,
			outbox,
			plunk: createPlunkClient({ secretKey: 'unused', fetch: vi.fn() }),
			alertEmail,
			shipping: shippingDependencies({ stripe, sender })
		});

		await expect(worker.drain(now)).resolves.toEqual({ completed: 1, rescheduled: 0 });
		expect(sequence).toEqual(['stripe-current-email', 'plunk-send']);
		expect(stripe.retrieveFulfillmentDetails).toHaveBeenCalledWith('cs_order_shipping');
		expect(database.prepare('SELECT * FROM email_deliveries').all()).toEqual([
			expect.objectContaining({
				order_id: 'order_shipping',
				kind: 'shipping',
				tracking_reference: 'TRACK-2042',
				idempotency_key: 'shipping:order_shipping:TRACK-2042',
				provider_delivery_id: 'plunk_shipping_2042',
				attempt_count: 1,
				completed_at: now.toISOString()
			})
		]);
		const persisted = JSON.stringify({
			outbox: database.prepare('SELECT * FROM outbox_jobs').all(),
			deliveries: database.prepare('SELECT * FROM email_deliveries').all()
		});
		expect(persisted).not.toContain('current@example.test');
		expect(persisted).not.toContain('Currentgatan');
		expect(persisted).not.toContain('+46 70');
		expect(persisted).not.toContain('Analytical Engines');
	});

	it('settles three shipping jobs concurrently, isolates failure, and uses the shipping fallback code', async () => {
		for (const id of ['concurrent_a', 'concurrent_fail', 'concurrent_c']) {
			insertOrder(database, {
				id,
				quantities: [1],
				fulfillmentStatus: 'shipped',
				trackingNumber: `TRACK-${id}`
			});
			outbox.enqueue({
				kind: 'shipping-email',
				idempotencyKey: `shipping:${id}:TRACK-${id}`,
				orderId: id,
				nextAttemptAt: now
			});
		}
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let active = 0;
		let maximumActive = 0;
		const sender: ShippingEmailSender = {
			send: vi.fn(async (input) => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await barrier;
				active -= 1;
				if (input.trackingNumber === 'TRACK-concurrent_fail') {
					throw new Error('unexpected private shipping failure');
				}
				return { deliveryId: `plunk_${input.trackingNumber}` };
			})
		};
		const worker = new PaidOrderAlertOutboxWorker({
			database,
			outbox,
			plunk: createPlunkClient({ secretKey: 'unused', fetch: vi.fn() }),
			alertEmail,
			shipping: shippingDependencies({ sender })
		});

		const draining = worker.drain(now, 3);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const startedBeforeRelease = vi.mocked(sender.send).mock.calls.length;
		release();

		await expect(draining).resolves.toEqual({ completed: 2, rescheduled: 1 });
		expect(startedBeforeRelease).toBe(3);
		expect(maximumActive).toBe(3);
		expect(
			database
				.prepare(
					`SELECT order_id, completed_at, last_error_code
					FROM outbox_jobs ORDER BY order_id`
				)
				.all()
		).toEqual([
			{ order_id: 'concurrent_a', completed_at: now.toISOString(), last_error_code: null },
			{ order_id: 'concurrent_c', completed_at: now.toISOString(), last_error_code: null },
			{
				order_id: 'concurrent_fail',
				completed_at: null,
				last_error_code: 'SHIPPING_EMAIL_FAILED'
			}
		]);
	});

	it('does not mark success before Plunk accepts and retries an interrupted local completion', async () => {
		insertOrder(database, {
			id: 'order_at_least_once',
			quantities: [1],
			fulfillmentStatus: 'shipped',
			trackingNumber: 'TRACK-RETRY'
		});
		outbox.enqueue({
			kind: 'shipping-email',
			idempotencyKey: 'shipping:order_at_least_once:TRACK-RETRY',
			orderId: 'order_at_least_once',
			nextAttemptAt: now
		});
		database
			.prepare(
				`CREATE TRIGGER reject_delivery_completion BEFORE UPDATE OF completed_at ON email_deliveries
				WHEN NEW.completed_at IS NOT NULL
				BEGIN SELECT RAISE(ABORT, 'completion interrupted'); END`
			)
			.run();
		const sender: ShippingEmailSender = {
			send: vi
				.fn<ShippingEmailSender['send']>()
				.mockResolvedValueOnce({ deliveryId: 'plunk_first_accept' })
				.mockResolvedValueOnce({ deliveryId: 'plunk_retry_accept' })
		};
		const worker = new PaidOrderAlertOutboxWorker({
			database,
			outbox,
			plunk: createPlunkClient({ secretKey: 'unused', fetch: vi.fn() }),
			alertEmail,
			shipping: shippingDependencies({ sender })
		});

		await expect(worker.drain(now)).resolves.toEqual({ completed: 0, rescheduled: 1 });
		expect(sender.send).toHaveBeenCalledOnce();
		expect(
			database
				.prepare('SELECT provider_delivery_id, attempt_count, completed_at FROM email_deliveries')
				.get()
		).toEqual({ provider_delivery_id: null, attempt_count: 1, completed_at: null });
		database.prepare('DROP TRIGGER reject_delivery_completion').run();
		const retryAt = new Date(now.getTime() + 2 * 60_000);

		await expect(worker.drain(retryAt)).resolves.toEqual({ completed: 1, rescheduled: 0 });
		expect(sender.send).toHaveBeenCalledTimes(2);
		expect(
			database
				.prepare('SELECT provider_delivery_id, attempt_count, completed_at FROM email_deliveries')
				.get()
		).toEqual({
			provider_delivery_id: 'plunk_retry_accept',
			attempt_count: 2,
			completed_at: retryAt.toISOString()
		});
	});

	it('keeps both delivery and outbox incomplete when Plunk rejects the message', async () => {
		insertOrder(database, {
			id: 'order_plunk_rejects',
			quantities: [1],
			fulfillmentStatus: 'shipped',
			trackingNumber: 'TRACK-PLUNK-REJECTS'
		});
		outbox.enqueue({
			kind: 'shipping-email',
			idempotencyKey: 'shipping:order_plunk_rejects:TRACK-PLUNK-REJECTS',
			orderId: 'order_plunk_rejects',
			nextAttemptAt: now
		});
		const sender: ShippingEmailSender = {
			send: vi.fn(async () => {
				throw new PlunkError('PLUNK_UNAVAILABLE');
			})
		};
		const worker = new PaidOrderAlertOutboxWorker({
			database,
			outbox,
			plunk: createPlunkClient({ secretKey: 'unused', fetch: vi.fn() }),
			alertEmail,
			shipping: shippingDependencies({ sender })
		});

		await expect(worker.drain(now)).resolves.toEqual({ completed: 0, rescheduled: 1 });
		expect(database.prepare('SELECT * FROM email_deliveries').all()).toEqual([
			expect.objectContaining({
				provider_delivery_id: null,
				attempt_count: 1,
				completed_at: null
			})
		]);
		expect(
			database.prepare('SELECT attempt_count, completed_at, last_error_code FROM outbox_jobs').get()
		).toEqual({ attempt_count: 1, completed_at: null, last_error_code: 'PLUNK_UNAVAILABLE' });
	});
});
