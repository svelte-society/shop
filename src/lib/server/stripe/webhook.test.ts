import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewCheckoutDraft, PaymentStatus } from '$lib/domain/orders';
import { RepositoryError } from '$lib/domain/orders';
import {
	SqliteOrderEventRepository,
	type OrderEventRepository
} from '$lib/server/audit/order-events.server';
import { SqliteCheckoutDraftRepository } from '$lib/server/db/checkout-drafts.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOrderRepository, SqlitePaidOrderUnitOfWork } from '$lib/server/db/orders.server';
import {
	SqliteStripeEventRepository,
	type StripeEventRepository
} from '$lib/server/db/stripe-events.server';
import type { ShopDatabase } from '$lib/server/db/types';
import {
	SqliteRefundOrderUnitOfWork,
	type RefundOrderUnitOfWork
} from '$lib/server/orders/intake.server';
import type { PaidCheckoutSnapshot, StripeOrderGateway } from './gateway';
import {
	createStripeOrderGateway,
	PaidCheckoutError,
	type StripeOrderClient
} from './paid-checkout';
import {
	createStripeWebhookService,
	createStripeWebhookVerifier,
	StripeWebhookError,
	type StripeWebhookVerifier
} from './webhook.server';
import {
	paidCheckoutProviderFixture,
	type PaidCheckoutProviderFixture
} from '../../../../tests/fixtures/stripe-paid-checkout';

const migrationsDirectory = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const RAW_BODY = '{\n  "id": "evt_paid",\n  "email": "private@example.test"\n}\n';
const SIGNATURE = 't=1770000000,v1=verified';
const WEBHOOK_SECRET = 'whsec_test_contract';
const NOW = new Date('2026-07-16T12:00:00.000Z');

type FixtureEventObject =
	| Pick<Stripe.Checkout.Session, 'id' | 'object'>
	| Pick<Stripe.Charge, 'id' | 'object' | 'payment_intent'>
	| Pick<Stripe.Product, 'id' | 'object'>;

function event(id: string, type: Stripe.Event.Type, object: FixtureEventObject): Stripe.Event {
	return {
		id,
		object: 'event',
		api_version: '2026-06-24.dahlia',
		created: Math.floor(NOW.getTime() / 1_000),
		data: { object },
		livemode: false,
		pending_webhooks: 1,
		request: { id: null, idempotency_key: null },
		type
	} as Stripe.Event;
}

function checkoutEvent(
	id = 'evt_paid',
	type:
		| 'checkout.session.completed'
		| 'checkout.session.async_payment_succeeded' = 'checkout.session.completed'
): Stripe.Event {
	return event(id, type, { id: 'cs_paid', object: 'checkout.session' });
}

function refundEvent(id = 'evt_refund'): Stripe.Event {
	return event(id, 'charge.refunded', {
		id: 'ch_paid',
		object: 'charge',
		payment_intent: 'pi_paid'
	});
}

function draftInput(): NewCheckoutDraft {
	return {
		contractVersion: 2,
		destinationCountry: 'SE',
		currency: 'eur',
		totalUnitCount: 1,
		shippingMode: 'paid',
		shippingRateId: 'shr_paid_8_eur',
		shippingNetAmount: 800,
		createdAt: new Date('2026-07-16T11:00:00.000Z'),
		expiresAt: new Date('2026-07-16T13:00:00.000Z'),
		lines: [
			{
				stripeProductId: 'prod_tee',
				stripePriceId: 'price_tee_medium',
				productName: 'Svelte Society Tee',
				variantLabel: 'Medium',
				sku: 'TEE-M',
				styriaProductNumber: 'STYRIA-TEE-M',
				designReference: 'society-wave-v1',
				designPlacements: { front: 'https://cdn.example.test/society-wave.svg' },
				quantity: 1,
				unitAmount: 2_000,
				currency: 'eur'
			}
		]
	};
}

function paidSnapshot(draftId: string): PaidCheckoutSnapshot {
	return {
		contractVersion: 2,
		checkoutSessionId: 'cs_paid',
		paymentIntentId: 'pi_paid',
		customerId: 'cus_paid',
		draftId,
		currency: 'eur',
		paymentStatus: 'paid',
		destinationCountry: 'SE',
		shippingRate: { id: 'shr_paid_8_eur', netAmount: 800 },
		amounts: {
			subtotal: 2_000,
			discount: 0,
			shipping: 1_000,
			shippingTax: 200,
			tax: 700,
			total: 3_500
		},
		lines: [
			{
				priceId: 'price_tee_medium',
				quantity: 1,
				unitAmount: 2_000,
				retailUnitAmount: 2_500
			}
		]
	};
}

type FixtureOptions = {
	event?: Stripe.Event;
	verify?: StripeWebhookVerifier['constructEvent'];
	readiness?: () => Promise<{ ready: boolean }>;
	retrievePaidCheckout?: StripeOrderGateway['retrievePaidCheckout'];
	retrieveRefundStatus?: StripeOrderGateway['retrieveRefundStatus'];
	refunds?: RefundOrderUnitOfWork;
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function providerGateway(provider: PaidCheckoutProviderFixture): StripeOrderGateway {
	const client: StripeOrderClient = {
		checkout: {
			sessions: {
				retrieve: async () => structuredClone(provider.session),
				listLineItems: async () => structuredClone(provider.linePages[0])
			}
		},
		paymentIntents: {
			retrieve: async () => structuredClone(provider.refundPaymentIntent)
		}
	};
	return createStripeOrderGateway(client);
}

describe('Stripe webhook service', () => {
	let database: ShopDatabase;
	let drafts: SqliteCheckoutDraftRepository;
	let stripeEvents: SqliteStripeEventRepository;
	let orders: SqliteOrderRepository;
	let draftId: string;

	beforeEach(() => {
		database = new Database(':memory:');
		database.pragma('foreign_keys = ON');
		migrate(database, migrationsDirectory);
		drafts = new SqliteCheckoutDraftRepository(database);
		stripeEvents = new SqliteStripeEventRepository(database);
		orders = new SqliteOrderRepository(database);
		const draft = drafts.create(draftInput());
		drafts.attachSession(draft.id, 'cs_paid');
		draftId = draft.id;
	});

	afterEach(() => database.close());

	function fixture(options: FixtureOptions = {}) {
		const verifierCalls: Array<{ rawBody: string; signature: string; secret: string }> = [];
		const paidCalls: string[] = [];
		const refundCalls: string[] = [];
		let readinessCalls = 0;
		let currentEvent = options.event ?? checkoutEvent();
		const verifier: StripeWebhookVerifier = {
			constructEvent(rawBody, signature, secret) {
				verifierCalls.push({ rawBody, signature, secret });
				return options.verify
					? options.verify(rawBody, signature, secret)
					: structuredClone(currentEvent);
			}
		};
		const stripeOrders: StripeOrderGateway = {
			async retrievePaidCheckout(sessionId) {
				paidCalls.push(sessionId);
				return options.retrievePaidCheckout
					? options.retrievePaidCheckout(sessionId)
					: paidSnapshot(draftId);
			},
			async retrieveRefundStatus(paymentIntentId) {
				refundCalls.push(paymentIntentId);
				return options.retrieveRefundStatus
					? options.retrieveRefundStatus(paymentIntentId)
					: 'partially_refunded';
			}
		};
		const service = createStripeWebhookService({
			webhookSecret: WEBHOOK_SECRET,
			verifier,
			async checkReadiness() {
				readinessCalls += 1;
				return options.readiness ? options.readiness() : { ready: true };
			},
			stripeEvents,
			drafts,
			stripeOrders,
			paidOrders: new SqlitePaidOrderUnitOfWork(database),
			refunds: options.refunds ?? new SqliteRefundOrderUnitOfWork(database),
			now: () => new Date(NOW)
		});

		return {
			service,
			verifierCalls,
			paidCalls,
			refundCalls,
			get readinessCalls() {
				return readinessCalls;
			},
			setEvent(nextEvent: Stripe.Event) {
				currentEvent = nextEvent;
			}
		};
	}

	it('verifies the exact raw body before provider or database work', async () => {
		const route = fixture({
			verify: () => {
				throw new Error('No signatures found matching the expected signature');
			}
		});

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).rejects.toMatchObject({
			code: 'STRIPE_WEBHOOK_SIGNATURE_INVALID',
			retryable: false
		});
		expect(route.verifierCalls).toEqual([
			{ rawBody: RAW_BODY, signature: SIGNATURE, secret: WEBHOOK_SECRET }
		]);
		expect(route.paidCalls).toEqual([]);
		expect(route.readinessCalls).toBe(0);
		expect(database.prepare('SELECT count(*) AS count FROM stripe_events').get()).toEqual({
			count: 0
		});
	});

	it('does not initialize database processing dependencies until after signature verification', async () => {
		let processingLoads = 0;
		const service = createStripeWebhookService({
			webhookSecret: WEBHOOK_SECRET,
			checkReadiness: async () => ({ ready: true }),
			verifier: {
				constructEvent() {
					throw new Error('invalid signature');
				}
			},
			loadProcessingDependencies() {
				processingLoads += 1;
				return {
					stripeEvents,
					drafts,
					stripeOrders: {
						async retrievePaidCheckout() {
							return paidSnapshot(draftId);
						},
						async retrieveRefundStatus() {
							return 'paid';
						}
					},
					paidOrders: new SqlitePaidOrderUnitOfWork(database),
					refunds: new SqliteRefundOrderUnitOfWork(database)
				};
			}
		});

		await expect(service.handle(RAW_BODY, SIGNATURE)).rejects.toMatchObject({
			code: 'STRIPE_WEBHOOK_SIGNATURE_INVALID'
		});
		expect(processingLoads).toBe(0);
	});

	it('redacts processing initialization failures behind a stable retryable error', async () => {
		const service = createStripeWebhookService({
			webhookSecret: WEBHOOK_SECRET,
			checkReadiness: async () => ({ ready: true }),
			verifier: { constructEvent: () => checkoutEvent() },
			loadProcessingDependencies() {
				throw new Error('database path for private@example.test failed');
			}
		});

		await expect(service.handle(RAW_BODY, SIGNATURE)).rejects.toEqual(
			new StripeWebhookError('STRIPE_WEBHOOK_PROCESSING_INIT_FAILED', true)
		);
	});

	it('uses Stripe signature verification against the exact unparsed payload', () => {
		const rawBody = JSON.stringify({
			id: 'evt_signed',
			object: 'event',
			data: { object: { id: 'prod_signed', object: 'product' } },
			type: 'product.created'
		});
		const signature = Stripe.webhooks.generateTestHeaderString({
			payload: rawBody,
			secret: WEBHOOK_SECRET,
			timestamp: Math.floor(Date.now() / 1_000)
		});
		const verifier = createStripeWebhookVerifier(new Stripe('sk_test_webhook_contract'));

		expect(verifier.constructEvent(rawBody, signature, WEBHOOK_SECRET)).toMatchObject({
			id: 'evt_signed',
			type: 'product.created'
		});
		expect(() => verifier.constructEvent(`${rawBody}\n`, signature, WEBHOOK_SECRET)).toThrowError();
	});

	it('allowlists relevant types and safely acknowledges other verified events without persistence', async () => {
		const route = fixture({
			event: event('evt_product', 'product.created', { id: 'prod_new', object: 'product' })
		});

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: false });
		expect(route.paidCalls).toEqual([]);
		expect(route.refundCalls).toEqual([]);
		expect(route.readinessCalls).toBe(0);
		expect(database.prepare('SELECT count(*) AS count FROM stripe_events').get()).toEqual({
			count: 0
		});
	});

	it('checks local readiness on every relevant event before cached processing work', async () => {
		const readiness = vi
			.fn<() => Promise<{ ready: boolean }>>()
			.mockResolvedValueOnce({ ready: true })
			.mockResolvedValueOnce({ ready: false });
		const route = fixture({ readiness });

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: false });
		expect(route.paidCalls).toEqual(['cs_paid']);
		expect(database.prepare('SELECT count(*) AS count FROM stripe_events').get()).toEqual({
			count: 1
		});
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 1 });

		route.setEvent(checkoutEvent('evt_paid_after_red'));
		await expect(route.service.handle(RAW_BODY, SIGNATURE)).rejects.toEqual(
			new StripeWebhookError('STRIPE_WEBHOOK_SERVICE_NOT_READY', true)
		);
		expect(readiness).toHaveBeenCalledTimes(2);
		expect(route.paidCalls).toEqual(['cs_paid']);
		expect(database.prepare('SELECT count(*) AS count FROM stripe_events').get()).toEqual({
			count: 1
		});
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 1 });
	});

	it('redacts a thrown per-event readiness probe behind the stable retryable code', async () => {
		const route = fixture({
			readiness: async () => {
				throw new Error('database path private@example.test became unavailable');
			}
		});

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).rejects.toEqual(
			new StripeWebhookError('STRIPE_WEBHOOK_SERVICE_NOT_READY', true)
		);
		expect(route.paidCalls).toEqual([]);
		expect(database.prepare('SELECT count(*) AS count FROM stripe_events').get()).toEqual({
			count: 0
		});
	});

	it('rejects a malformed Stripe Event ID before it can enter durable deduplication', async () => {
		const route = fixture({ event: checkoutEvent('private@example.test') });

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).rejects.toMatchObject({
			code: 'STRIPE_WEBHOOK_EVENT_INVALID',
			retryable: false
		});
		expect(database.prepare('SELECT count(*) AS count FROM stripe_events').get()).toEqual({
			count: 0
		});
	});

	it.each([
		['checkout.session.completed', 'evt_paid'],
		['checkout.session.async_payment_succeeded', 'evt_paid_async']
	] as const)('ingests a current paid checkout atomically for %s', async (type, eventId) => {
		const route = fixture({ event: checkoutEvent(eventId, type) });

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: false });

		expect(route.paidCalls).toEqual(['cs_paid']);
		expect(orders.findByCheckoutSession('cs_paid')).toEqual(
			expect.objectContaining({
				checkoutDraftId: draftId,
				paymentStatus: 'paid',
				fulfillmentStatus: 'pending_review',
				amounts: {
					subtotal: 2_000,
					discount: 0,
					shipping: 1_000,
					shippingTax: 200,
					tax: 700,
					total: 3_500
				},
				lines: [
					expect.objectContaining({
						stripePriceId: 'price_tee_medium',
						quantity: 1,
						retailUnitAmount: 2_500
					})
				]
			})
		);
		expect(database.prepare('SELECT processing_status FROM stripe_events').get()).toEqual({
			processing_status: 'completed'
		});
		expect(database.prepare('SELECT count(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 1
		});
	});

	it('revalidates a completed duplicate without repeating commercial writes', async () => {
		const route = fixture();

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: false });
		await expect(route.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: true });

		expect(route.paidCalls).toEqual(['cs_paid', 'cs_paid']);
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 1 });
		expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
			count: 1
		});
	});

	it('rejects a completed replay when the persisted paid line snapshot is corrupted', async () => {
		const route = fixture();
		await expect(route.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: false });
		database.prepare('UPDATE order_lines SET retail_unit_amount = 2499').run();

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).rejects.toEqual(
			new StripeWebhookError('ORDER_LINE_CONFLICT', false)
		);
		expect(route.paidCalls).toEqual(['cs_paid', 'cs_paid']);
		expect(database.prepare('SELECT processing_status FROM stripe_events').get()).toEqual({
			processing_status: 'completed'
		});
		expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
			count: 1
		});
	});

	it('coalesces overlapping delivery of one Event ID into one provider and commercial intake', async () => {
		const retrieval = deferred<PaidCheckoutSnapshot>();
		const route = fixture({ retrievePaidCheckout: async () => retrieval.promise });

		const first = route.service.handle(RAW_BODY, SIGNATURE);
		await vi.waitFor(() => expect(route.paidCalls).toHaveLength(1));
		const overlapping = route.service.handle(RAW_BODY, SIGNATURE);
		await Promise.resolve();

		expect(route.paidCalls).toEqual(['cs_paid']);
		retrieval.resolve(paidSnapshot(draftId));
		await expect(Promise.all([first, overlapping])).resolves.toEqual([
			{ duplicate: false },
			{ duplicate: true }
		]);
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 1 });
		expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
			count: 1
		});
		expect(database.prepare('SELECT count(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 1
		});
	});

	it('releases a failed overlapping Event ID so a later delivery can retry durably', async () => {
		const retrieval = deferred<PaidCheckoutSnapshot>();
		let providerAttempt = 0;
		const route = fixture({
			retrievePaidCheckout: async () => {
				providerAttempt += 1;
				if (providerAttempt === 1) return retrieval.promise;
				return paidSnapshot(draftId);
			}
		});

		const first = route.service.handle(RAW_BODY, SIGNATURE);
		await vi.waitFor(() => expect(route.paidCalls).toHaveLength(1));
		const overlapping = route.service.handle(RAW_BODY, SIGNATURE);
		await Promise.resolve();
		expect(route.paidCalls).toEqual(['cs_paid']);
		retrieval.reject(new PaidCheckoutError('STRIPE_PAID_CHECKOUT_RETRIEVAL_FAILED'));
		const failures = await Promise.allSettled([first, overlapping]);
		expect(failures).toEqual([
			expect.objectContaining({
				status: 'rejected',
				reason: expect.objectContaining({
					code: 'STRIPE_PAID_CHECKOUT_RETRIEVAL_FAILED',
					retryable: true
				})
			}),
			expect.objectContaining({
				status: 'rejected',
				reason: expect.objectContaining({
					code: 'STRIPE_PAID_CHECKOUT_RETRIEVAL_FAILED',
					retryable: true
				})
			})
		]);
		expect(database.prepare('SELECT processing_status FROM stripe_events').get()).toEqual({
			processing_status: 'failed'
		});

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: false });
		expect(route.paidCalls).toEqual(['cs_paid', 'cs_paid']);
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 1 });
	});

	it('retries failed and abandoned event claims without losing first-seen identity', async () => {
		let attempts = 0;
		const route = fixture({
			retrievePaidCheckout: async () => {
				attempts += 1;
				if (attempts === 1) throw new PaidCheckoutError('STRIPE_PAID_CHECKOUT_RETRIEVAL_FAILED');
				return paidSnapshot(draftId);
			}
		});

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).rejects.toMatchObject({
			code: 'STRIPE_PAID_CHECKOUT_RETRIEVAL_FAILED',
			retryable: true
		});
		expect(
			database.prepare('SELECT processing_status, last_error_code FROM stripe_events').get()
		).toEqual({
			processing_status: 'failed',
			last_error_code: 'STRIPE_PAID_CHECKOUT_RETRIEVAL_FAILED'
		});
		await expect(route.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: false });
		expect(route.paidCalls).toEqual(['cs_paid', 'cs_paid']);

		const abandoned = fixture({ event: checkoutEvent('evt_abandoned') });
		expect(stripeEvents.begin('evt_abandoned', 'checkout.session.completed', NOW)).toBe('new');
		await expect(abandoned.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({
			duplicate: false
		});
	});

	it('acknowledges an unpaid completion and completes its event without an order', async () => {
		const provider = paidCheckoutProviderFixture({
			sessionId: 'cs_paid',
			paymentIntentId: 'pi_paid',
			customerId: 'cus_paid',
			draftId
		});
		provider.session.payment_status = 'unpaid';
		const gateway = providerGateway(provider);
		const route = fixture({
			retrievePaidCheckout: gateway.retrievePaidCheckout
		});

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: false });
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 0 });
		expect(
			database
				.prepare(
					'SELECT processing_status, stripe_checkout_session_id, stripe_payment_intent_id FROM stripe_events'
				)
				.get()
		).toEqual({
			processing_status: 'completed',
			stripe_checkout_session_id: 'cs_paid',
			stripe_payment_intent_id: null
		});
	});

	it('retries an open paid Session and converges when the same Session becomes complete', async () => {
		const provider = paidCheckoutProviderFixture({
			sessionId: 'cs_paid',
			paymentIntentId: 'pi_paid',
			customerId: 'cus_paid',
			draftId
		});
		provider.session.status = 'open';
		const gateway = providerGateway(provider);
		const route = fixture({ retrievePaidCheckout: gateway.retrievePaidCheckout });

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).rejects.toMatchObject({
			code: 'STRIPE_PAID_CHECKOUT_PAYMENT_NOT_SETTLED',
			retryable: true
		});
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 0 });
		expect(
			database
				.prepare('SELECT processing_status, last_error_code, completed_at FROM stripe_events')
				.get()
		).toEqual({
			processing_status: 'failed',
			last_error_code: 'STRIPE_PAID_CHECKOUT_PAYMENT_NOT_SETTLED',
			completed_at: null
		});

		provider.session.status = 'complete';
		await expect(route.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: false });
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 1 });
		expect(
			database.prepare('SELECT processing_status, last_error_code FROM stripe_events').get()
		).toEqual({ processing_status: 'completed', last_error_code: null });
	});

	it.each([
		[
			'async paid event with an unpaid Session',
			'checkout.session.async_payment_succeeded' as const,
			'STRIPE_PAID_CHECKOUT_SESSION_UNPAID'
		],
		[
			'async paid event with unsettled payment objects',
			'checkout.session.async_payment_succeeded' as const,
			'STRIPE_PAID_CHECKOUT_PAYMENT_NOT_SETTLED'
		],
		[
			'completed paid Session with unsettled payment objects',
			'checkout.session.completed' as const,
			'STRIPE_PAID_CHECKOUT_PAYMENT_NOT_SETTLED'
		]
	])('retries %s and converges after Stripe settles', async (_label, type, code) => {
		let settled = false;
		const route = fixture({
			event: checkoutEvent('evt_settlement_retry', type),
			retrievePaidCheckout: async () => {
				if (!settled) throw new PaidCheckoutError(code);
				return paidSnapshot(draftId);
			}
		});

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).rejects.toMatchObject({
			code,
			retryable: true
		});
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 0 });
		expect(
			database
				.prepare('SELECT processing_status, last_error_code, completed_at FROM stripe_events')
				.get()
		).toEqual({
			processing_status: 'failed',
			last_error_code: code,
			completed_at: null
		});

		settled = true;
		await expect(route.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: false });
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 1 });
		expect(
			database.prepare('SELECT processing_status, last_error_code FROM stripe_events').get()
		).toEqual({ processing_status: 'completed', last_error_code: null });
	});

	it('rolls back commercial writes and leaves a stable retryable failed event', async () => {
		database.exec(`
			CREATE TRIGGER reject_paid_alert BEFORE INSERT ON outbox_jobs
			WHEN NEW.kind = 'paid-order-alert'
			BEGIN
				SELECT RAISE(ABORT, 'private@example.test at Provider Street');
			END
		`);
		const route = fixture();

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).rejects.toMatchObject({
			code: 'PAID_ORDER_COMMIT_FAILED',
			retryable: true
		});
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 0 });
		expect(database.prepare('SELECT count(*) AS count FROM order_lines').get()).toEqual({
			count: 0
		});
		expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
			count: 0
		});
		expect(database.prepare('SELECT count(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 0
		});
		expect(
			database.prepare('SELECT processing_status, last_error_code FROM stripe_events').get()
		).toEqual({
			processing_status: 'failed',
			last_error_code: 'PAID_ORDER_COMMIT_FAILED'
		});
	});

	it('converges partial and full refunds without changing fulfillment state', async () => {
		const paid = fixture();
		await paid.service.handle(RAW_BODY, SIGNATURE);
		database
			.prepare(
				"UPDATE orders SET fulfillment_status = 'in_production' WHERE stripe_payment_intent_id = ?"
			)
			.run('pi_paid');
		let currentStatus: PaymentStatus = 'partially_refunded';
		const refunds = fixture({
			event: refundEvent('evt_partial_refund'),
			retrieveRefundStatus: async () => currentStatus
		});

		await refunds.service.handle(RAW_BODY, SIGNATURE);
		expect(orders.findByCheckoutSession('cs_paid')).toMatchObject({
			paymentStatus: 'partially_refunded',
			fulfillmentStatus: 'in_production'
		});

		currentStatus = 'refunded';
		refunds.setEvent(refundEvent('evt_full_refund'));
		await refunds.service.handle(RAW_BODY, SIGNATURE);
		expect(orders.findByCheckoutSession('cs_paid')).toMatchObject({
			paymentStatus: 'refunded',
			fulfillmentStatus: 'in_production'
		});
		expect(
			database.prepare('SELECT action, prior_state, next_state FROM order_events ORDER BY id').all()
		).toEqual([
			{ action: 'paid_order_recorded', prior_state: null, next_state: 'pending_review' },
			{
				action: 'payment_status_updated',
				prior_state: 'paid',
				next_state: 'partially_refunded'
			},
			{
				action: 'payment_status_updated',
				prior_state: 'partially_refunded',
				next_state: 'refunded'
			}
		]);
	});

	it('recovers a refund delivered before its paid checkout and uses current provider state', async () => {
		let currentStatus: PaymentStatus = 'refunded';
		const refund = fixture({
			event: refundEvent('evt_refund_first'),
			retrieveRefundStatus: async () => currentStatus
		});

		await expect(refund.service.handle(RAW_BODY, SIGNATURE)).rejects.toMatchObject({
			code: 'ORDER_NOT_FOUND',
			retryable: true
		});
		expect(database.prepare('SELECT processing_status FROM stripe_events').get()).toEqual({
			processing_status: 'failed'
		});

		const paid = fixture({ event: checkoutEvent('evt_paid_after_refund') });
		await paid.service.handle(RAW_BODY, SIGNATURE);
		currentStatus = 'refunded';
		await refund.service.handle(RAW_BODY, SIGNATURE);
		expect(orders.findByCheckoutSession('cs_paid')).toMatchObject({
			paymentStatus: 'refunded',
			fulfillmentStatus: 'pending_review'
		});
	});

	it('retries a refunded Charge whose current provider state is still paid', async () => {
		const paid = fixture();
		await paid.service.handle(RAW_BODY, SIGNATURE);
		let currentStatus: PaymentStatus = 'paid';
		const refund = fixture({
			event: refundEvent('evt_stale_refund'),
			retrieveRefundStatus: async () => currentStatus
		});

		await expect(refund.service.handle(RAW_BODY, SIGNATURE)).rejects.toMatchObject({
			code: 'STRIPE_REFUND_STATUS_NOT_SETTLED',
			retryable: true
		});
		expect(orders.findByCheckoutSession('cs_paid')).toMatchObject({ paymentStatus: 'paid' });
		expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
			count: 1
		});
		expect(
			database
				.prepare(
					'SELECT processing_status, last_error_code, completed_at FROM stripe_events WHERE stripe_event_id = ?'
				)
				.get('evt_stale_refund')
		).toEqual({
			processing_status: 'failed',
			last_error_code: 'STRIPE_REFUND_STATUS_NOT_SETTLED',
			completed_at: null
		});

		currentStatus = 'partially_refunded';
		await expect(refund.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({ duplicate: false });
		expect(orders.findByCheckoutSession('cs_paid')).toMatchObject({
			paymentStatus: 'partially_refunded'
		});
		expect(
			database
				.prepare(
					'SELECT processing_status, last_error_code FROM stripe_events WHERE stripe_event_id = ?'
				)
				.get('evt_stale_refund')
		).toEqual({ processing_status: 'completed', last_error_code: null });
	});

	it.each(['audit insert', 'event completion'] as const)(
		'rolls back refund state when injected %s fails and converges on retry',
		async (failurePoint) => {
			const paid = fixture();
			await paid.service.handle(RAW_BODY, SIGNATURE);
			let rejectWrite = true;
			const realAudit = new SqliteOrderEventRepository(database);
			const realEvents = new SqliteStripeEventRepository(database);
			const audit: OrderEventRepository = {
				append(input) {
					if (rejectWrite && failurePoint === 'audit insert') {
						throw new RepositoryError('ORDER_EVENT_APPEND_FAILED');
					}
					realAudit.append(input);
				}
			};
			const events: StripeEventRepository = {
				begin: (...args) => realEvents.begin(...args),
				complete(...args) {
					if (rejectWrite && failurePoint === 'event completion') {
						throw new RepositoryError('STRIPE_EVENT_COMPLETE_FAILED');
					}
					realEvents.complete(...args);
				},
				fail: (...args) => realEvents.fail(...args)
			};
			const refundUnitOfWork = new SqliteRefundOrderUnitOfWork(database, {
				audit,
				events
			});
			const refund = fixture({
				event: refundEvent('evt_refund_atomic_retry'),
				retrieveRefundStatus: async () => 'partially_refunded',
				refunds: refundUnitOfWork
			});

			await expect(refund.service.handle(RAW_BODY, SIGNATURE)).rejects.toMatchObject({
				code: 'REFUND_ORDER_COMMIT_FAILED',
				retryable: true
			});
			expect(orders.findByCheckoutSession('cs_paid')).toMatchObject({ paymentStatus: 'paid' });
			expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
				count: 1
			});
			expect(
				database
					.prepare(
						'SELECT processing_status, last_error_code, completed_at FROM stripe_events WHERE stripe_event_id = ?'
					)
					.get('evt_refund_atomic_retry')
			).toEqual({
				processing_status: 'failed',
				last_error_code: 'REFUND_ORDER_COMMIT_FAILED',
				completed_at: null
			});

			rejectWrite = false;
			await expect(refund.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({
				duplicate: false
			});
			expect(orders.findByCheckoutSession('cs_paid')).toMatchObject({
				paymentStatus: 'partially_refunded'
			});
			expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
				count: 2
			});
			expect(
				database
					.prepare(
						'SELECT processing_status, last_error_code FROM stripe_events WHERE stripe_event_id = ?'
					)
					.get('evt_refund_atomic_retry')
			).toEqual({ processing_status: 'completed', last_error_code: null });
		}
	);

	it('completes distinct full-before-partial deliveries without downgrading current refund state', async () => {
		const paid = fixture();
		await paid.service.handle(RAW_BODY, SIGNATURE);
		const refunds = fixture({
			event: refundEvent('evt_full_first'),
			retrieveRefundStatus: async () => 'refunded'
		});

		await expect(refunds.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({
			duplicate: false
		});
		await expect(refunds.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({
			duplicate: true
		});
		refunds.setEvent(refundEvent('evt_partial_delivered_late'));
		await expect(refunds.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({
			duplicate: false
		});
		await expect(refunds.service.handle(RAW_BODY, SIGNATURE)).resolves.toEqual({
			duplicate: true
		});

		expect(orders.findByCheckoutSession('cs_paid')).toMatchObject({ paymentStatus: 'refunded' });
		expect(
			database
				.prepare(
					"SELECT stripe_event_id, processing_status FROM stripe_events WHERE event_type = 'charge.refunded' ORDER BY stripe_event_id"
				)
				.all()
		).toEqual([
			{ stripe_event_id: 'evt_full_first', processing_status: 'completed' },
			{ stripe_event_id: 'evt_partial_delivered_late', processing_status: 'completed' }
		]);
		expect(
			database.prepare('SELECT action, prior_state, next_state FROM order_events ORDER BY id').all()
		).toEqual([
			{ action: 'paid_order_recorded', prior_state: null, next_state: 'pending_review' },
			{ action: 'payment_status_updated', prior_state: 'paid', next_state: 'refunded' },
			{ action: 'payment_status_converged', prior_state: 'refunded', next_state: 'refunded' }
		]);
	});

	it('never persists the raw webhook, signature, provider PII, or failure text', async () => {
		const route = fixture();
		await route.service.handle(RAW_BODY, SIGNATURE);

		const persisted = JSON.stringify({
			drafts: database.prepare('SELECT * FROM checkout_drafts').all(),
			lines: database.prepare('SELECT * FROM checkout_draft_lines').all(),
			orders: database.prepare('SELECT * FROM orders').all(),
			events: database.prepare('SELECT * FROM stripe_events').all(),
			audit: database.prepare('SELECT * FROM order_events').all(),
			outbox: database.prepare('SELECT * FROM outbox_jobs').all()
		});

		expect(persisted).not.toContain(RAW_BODY);
		expect(persisted).not.toContain(SIGNATURE);
		expect(persisted).not.toContain('private@example.test');
		expect(persisted).not.toContain('Provider Street');
	});

	it('rejects a malformed relevant object with a stable nonretryable error', async () => {
		const route = fixture({
			event: event('evt_bad_checkout', 'checkout.session.completed', {
				id: 'prod_wrong_object',
				object: 'product'
			})
		});

		await expect(route.service.handle(RAW_BODY, SIGNATURE)).rejects.toEqual(
			new StripeWebhookError('STRIPE_WEBHOOK_EVENT_INVALID', false)
		);
		expect(database.prepare('SELECT count(*) AS count FROM stripe_events').get()).toEqual({
			count: 0
		});
	});
});
