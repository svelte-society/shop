import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteCheckoutDraftRepository } from '../../src/lib/server/db/checkout-drafts.server';
import { closeDatabase, openDatabase } from '../../src/lib/server/db/connection.server';
import { migrate } from '../../src/lib/server/db/migrate.server';
import {
	SqliteOrderRepository,
	SqlitePaidOrderUnitOfWork
} from '../../src/lib/server/db/orders.server';
import { SqliteOutboxRepository } from '../../src/lib/server/db/outbox.server';
import { SqliteStripeEventRepository } from '../../src/lib/server/db/stripe-events.server';
import type { ShopDatabase } from '../../src/lib/server/db/types';
import { PaidOrderAlertOutboxWorker } from '../../src/lib/server/jobs/outbox-worker.server';
import { SqliteRefundOrderUnitOfWork } from '../../src/lib/server/orders/intake.server';
import type { PlunkSendInput } from '../../src/lib/server/plunk/gateway';
import { createStripeOrderGateway } from '../../src/lib/server/stripe/paid-checkout';
import { createStripeWebhookService } from '../../src/lib/server/stripe/webhook.server';
import { createStripeFixtureClient } from '../fixtures/catalog-server';
import {
	paidCheckoutProviderFixture,
	type PaidCheckoutFixtureOptions
} from '../fixtures/stripe-paid-checkout';

const NOW = new Date('2026-07-16T12:00:00.000Z');
const SESSION_ID = 'cs_test_integration_paid';

let database: ShopDatabase;
let temporaryDirectory: string;

beforeEach(() => {
	temporaryDirectory = mkdtempSync(join(tmpdir(), 'svelte-society-checkout-'));
	database = openDatabase(join(temporaryDirectory, 'shop.sqlite'));
	migrate(database, resolve('migrations'));
});

afterEach(() => {
	closeDatabase();
	rmSync(temporaryDirectory, { recursive: true, force: true });
});

function checkoutEvent(eventId: string, sessionId = SESSION_ID): Stripe.Event {
	return {
		id: eventId,
		type: 'checkout.session.completed',
		data: { object: { object: 'checkout.session', id: sessionId } }
	} as Stripe.Event;
}

function refundEvent(eventId: string, paymentIntentId: string): Stripe.Event {
	return {
		id: eventId,
		type: 'charge.refunded',
		data: { object: { object: 'charge', payment_intent: paymentIntentId } }
	} as Stripe.Event;
}

function createDraft(quantity: number, sessionId = SESSION_ID) {
	const drafts = new SqliteCheckoutDraftRepository(database);
	const draft = drafts.create({
		contractVersion: 1,
		currency: 'eur',
		totalUnitCount: quantity,
		shippingMode: quantity === 1 ? 'paid' : 'free',
		createdAt: new Date('2026-07-16T10:00:00.000Z'),
		expiresAt: new Date('2026-07-17T10:00:00.000Z'),
		lines: [
			{
				stripeProductId: 'prod_accessory',
				stripePriceId: 'price_accessory_one',
				productName: 'Society Mug',
				variantLabel: 'One size',
				sku: 'SS-MUG',
				styriaProductNumber: 'STYRIA-MUG',
				designReference: 'society-mug-v1',
				designPlacements: { wrap: 'https://cdn.example.com/designs/mug-wrap.svg' },
				quantity,
				unitAmount: 1_600,
				currency: 'eur'
			}
		]
	});
	drafts.attachSession(draft.id, sessionId);
	return draft;
}

function webhookService(fixture: ReturnType<typeof paidCheckoutProviderFixture>) {
	return createStripeWebhookService({
		webhookSecret: 'whsec_test_integration',
		verifier: {
			constructEvent(rawBody, signature) {
				if (signature !== 'sig_test') throw new Error('INVALID_SIGNATURE');
				return JSON.parse(rawBody) as Stripe.Event;
			}
		},
		stripeEvents: new SqliteStripeEventRepository(database),
		drafts: new SqliteCheckoutDraftRepository(database),
		stripeOrders: createStripeOrderGateway(createStripeFixtureClient(fixture)),
		paidOrders: new SqlitePaidOrderUnitOfWork(database),
		refunds: new SqliteRefundOrderUnitOfWork(database),
		now: () => new Date(NOW)
	});
}

async function intakePaidOrder(
	eventId: string,
	options: PaidCheckoutFixtureOptions & { quantity: number; taxAmount: number }
) {
	const draft = createDraft(options.quantity);
	const fixture = paidCheckoutProviderFixture({
		...options,
		sessionId: SESSION_ID,
		draftId: draft.id,
		lines: [
			{
				id: 'li_mug',
				priceId: 'price_accessory_one',
				quantity: options.quantity,
				unitAmount: 1_600,
				taxAmount: options.taxAmount
			}
		]
	});
	const event = checkoutEvent(eventId);

	await expect(webhookService(fixture).handle(JSON.stringify(event), 'sig_test')).resolves.toEqual({
		duplicate: false
	});

	return {
		draft,
		fixture,
		order: new SqliteOrderRepository(database).findByCheckoutSession(SESSION_ID)
	};
}

describe('checkout to Stripe webhook intake', () => {
	it('records a paid EU consumer order from the complete provider snapshot', async () => {
		const { draft, order } = await intakePaidOrder('evt_test_eu_consumer', {
			quantity: 1,
			country: 'SE',
			shippingAmount: 1_000,
			taxAmount: 400
		});
		expect(order).toMatchObject({
			checkoutSessionId: SESSION_ID,
			checkoutDraftId: draft.id,
			currency: 'eur',
			paymentStatus: 'paid',
			fulfillmentStatus: 'pending_review',
			destinationCountry: 'SE',
			lines: [{ stripePriceId: 'price_accessory_one', quantity: 1, unitAmount: 1_600 }]
		});
		expect(JSON.stringify(order)).not.toContain('fixture.customer@example.test');
		expect(JSON.stringify(order)).not.toContain('Provider Fixture Street');
		expect(JSON.stringify(order)).not.toContain('+46701234567');
	});

	it('records a paid US customer without EU automatic tax', async () => {
		const { order } = await intakePaidOrder('evt_test_us_customer', {
			quantity: 1,
			country: 'US',
			shippingAmount: 1_000,
			shippingTaxAmount: 0,
			taxAmount: 0
		});

		expect(order).toMatchObject({
			destinationCountry: 'US',
			amounts: { shipping: 1_000, tax: 0, total: 2_600 },
			paymentStatus: 'paid'
		});
	});

	it('records a reverse-charge order only with its verified EU VAT path', async () => {
		const { order } = await intakePaidOrder('evt_test_reverse_charge', {
			quantity: 1,
			country: 'SE',
			shippingAmount: 1_000,
			shippingTaxAmount: 0,
			taxExempt: 'reverse',
			taxIds: [{ type: 'eu_vat', value: 'SE123456789001' }],
			taxAmount: 0
		});

		expect(order).toMatchObject({
			destinationCountry: 'SE',
			amounts: { shipping: 1_000, tax: 0, total: 2_600 },
			paymentStatus: 'paid'
		});
		expect(JSON.stringify(order)).not.toContain('SE123456789001');
	});

	it('keeps paid shipping for a one-unit checkout', async () => {
		const { draft, order } = await intakePaidOrder('evt_test_one_unit_shipping', {
			quantity: 1,
			country: 'SE',
			shippingAmount: 1_000,
			taxAmount: 400
		});

		expect(draft.shippingMode).toBe('paid');
		expect(order?.amounts.shipping).toBe(1_000);
	});

	it('keeps free shipping for a two-unit checkout', async () => {
		const { draft, order } = await intakePaidOrder('evt_test_two_unit_shipping', {
			quantity: 2,
			country: 'SE',
			shippingAmount: 0,
			shippingTaxAmount: 0,
			taxAmount: 800
		});

		expect(draft.shippingMode).toBe('free');
		expect(order?.amounts.shipping).toBe(0);
		expect(order?.lines).toMatchObject([{ quantity: 2 }]);
	});

	it('deduplicates a repeated paid webhook and sends one administrator alert only', async () => {
		const draft = createDraft(1);
		const fixture = paidCheckoutProviderFixture({
			sessionId: SESSION_ID,
			draftId: draft.id,
			shippingAmount: 1_000,
			lines: [
				{
					id: 'li_mug',
					priceId: 'price_accessory_one',
					quantity: 1,
					unitAmount: 1_600,
					taxAmount: 400
				}
			]
		});
		const service = webhookService(fixture);
		const event = checkoutEvent('evt_test_duplicate');
		const rawBody = JSON.stringify(event);

		await expect(service.handle(rawBody, 'sig_test')).resolves.toEqual({ duplicate: false });
		await expect(service.handle(rawBody, 'sig_test')).resolves.toEqual({ duplicate: true });

		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 1 });
		expect(database.prepare('SELECT count(*) AS count FROM order_lines').get()).toEqual({
			count: 1
		});
		expect(database.prepare('SELECT count(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 1
		});
		expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
			count: 1
		});

		const deliveries: PlunkSendInput[] = [];
		const worker = new PaidOrderAlertOutboxWorker({
			database,
			outbox: new SqliteOutboxRepository(database),
			plunk: {
				async send(input) {
					deliveries.push(input);
					return { deliveryId: 'delivery_test_paid_alert' };
				}
			},
			alertEmail: {
				to: 'orders@example.test',
				from: { name: 'Svelte Society Shop', email: 'shop@example.test' },
				replyTo: 'merch@sveltesociety.dev'
			}
		});

		await expect(worker.drain(NOW)).resolves.toEqual({ completed: 1, rescheduled: 0 });
		await expect(worker.drain(NOW)).resolves.toEqual({ completed: 0, rescheduled: 0 });
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toMatchObject({
			to: 'orders@example.test',
			replyTo: 'merch@sveltesociety.dev',
			subject: 'Svelte Society Shop: paid order awaiting review'
		});
		expect(deliveries[0].subject).not.toMatch(/receipt|invoice|order confirmation/i);
	});

	it('retries the same webhook after a transactional database failure', async () => {
		const draft = createDraft(1);
		const fixture = paidCheckoutProviderFixture({
			sessionId: SESSION_ID,
			draftId: draft.id,
			shippingAmount: 1_000,
			lines: [
				{
					id: 'li_mug',
					priceId: 'price_accessory_one',
					quantity: 1,
					unitAmount: 1_600,
					taxAmount: 400
				}
			]
		});
		const service = webhookService(fixture);
		const event = checkoutEvent('evt_test_database_retry');
		const rawBody = JSON.stringify(event);
		database.exec(`
			CREATE TRIGGER fail_paid_order_insert
			BEFORE INSERT ON orders
			BEGIN
				SELECT RAISE(ABORT, 'forced database failure');
			END
		`);

		await expect(service.handle(rawBody, 'sig_test')).rejects.toMatchObject({
			code: 'PAID_ORDER_COMMIT_FAILED',
			retryable: true
		});
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 0 });
		expect(
			database
				.prepare(
					'SELECT processing_status, last_error_code FROM stripe_events WHERE stripe_event_id = ?'
				)
				.get(event.id)
		).toEqual({
			processing_status: 'failed',
			last_error_code: 'PAID_ORDER_COMMIT_FAILED'
		});

		database.exec('DROP TRIGGER fail_paid_order_insert');
		await expect(service.handle(rawBody, 'sig_test')).resolves.toEqual({ duplicate: false });

		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 1 });
		expect(database.prepare('SELECT count(*) AS count FROM order_lines').get()).toEqual({
			count: 1
		});
		expect(database.prepare('SELECT count(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 1
		});
		expect(
			database
				.prepare(
					'SELECT processing_status, last_error_code FROM stripe_events WHERE stripe_event_id = ?'
				)
				.get(event.id)
		).toEqual({ processing_status: 'completed', last_error_code: null });
	});

	it('converges one order from paid through partial and full refund provider state', async () => {
		const draft = createDraft(1);
		const fixture = paidCheckoutProviderFixture({
			sessionId: SESSION_ID,
			draftId: draft.id,
			shippingAmount: 1_000,
			lines: [
				{
					id: 'li_mug',
					priceId: 'price_accessory_one',
					quantity: 1,
					unitAmount: 1_600,
					taxAmount: 400
				}
			]
		});
		const service = webhookService(fixture);
		const paidEvent = checkoutEvent('evt_test_paid_before_refund');
		await expect(service.handle(JSON.stringify(paidEvent), 'sig_test')).resolves.toEqual({
			duplicate: false
		});

		const paymentIntentId = fixture.refundPaymentIntent.id;
		const charge = fixture.refundPaymentIntent.latest_charge;
		if (typeof charge !== 'object' || charge === null) throw new Error('TEST_CHARGE_NOT_EXPANDED');
		charge.amount_refunded = 1_000;
		charge.refunded = false;
		const partialEvent = refundEvent('evt_test_partial_refund', paymentIntentId);
		await expect(service.handle(JSON.stringify(partialEvent), 'sig_test')).resolves.toEqual({
			duplicate: false
		});
		expect(new SqliteOrderRepository(database).findByCheckoutSession(SESSION_ID)).toMatchObject({
			paymentStatus: 'partially_refunded',
			fulfillmentStatus: 'pending_review'
		});

		charge.amount_refunded = charge.amount;
		charge.refunded = true;
		const fullEvent = refundEvent('evt_test_full_refund', paymentIntentId);
		await expect(service.handle(JSON.stringify(fullEvent), 'sig_test')).resolves.toEqual({
			duplicate: false
		});

		expect(new SqliteOrderRepository(database).findByCheckoutSession(SESSION_ID)).toMatchObject({
			paymentStatus: 'refunded',
			fulfillmentStatus: 'pending_review'
		});
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 1 });
		expect(database.prepare('SELECT count(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 1
		});
		expect(database.prepare('SELECT count(*) AS count FROM stripe_events').get()).toEqual({
			count: 3
		});
		expect(
			database.prepare('SELECT action, prior_state, next_state FROM order_events ORDER BY id').all()
		).toEqual([
			{ action: 'paid_order_recorded', prior_state: null, next_state: 'pending_review' },
			{ action: 'payment_status_updated', prior_state: 'paid', next_state: 'partially_refunded' },
			{
				action: 'payment_status_updated',
				prior_state: 'partially_refunded',
				next_state: 'refunded'
			}
		]);
	});
});
