import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteOutboxRepository } from '../../src/lib/server/db/outbox.server';
import { SqliteFulfillmentRepository } from '../../src/lib/server/fulfillment/repository.server';
import { PaidOrderAlertOutboxWorker } from '../../src/lib/server/jobs/outbox-worker.server';
import { SqliteStyriaSyncJob } from '../../src/lib/server/jobs/styria-sync.server';
import { createShippingEmailSender } from '../../src/lib/server/plunk/shipping-email';
import type { PlunkSendInput } from '../../src/lib/server/plunk/gateway';
import type { StyriaGateway } from '../../src/lib/server/styria/gateway';
import {
	createLifecycleDatabase,
	fulfillmentDetails,
	recordPaidOrder
} from '../fixtures/fulfillment-lifecycle';

describe('shipping email integration', () => {
	const databases: Array<ReturnType<typeof createLifecycleDatabase>> = [];

	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	it('loads the current Stripe email only when a queued tracking delivery is sent', async () => {
		const database = createLifecycleDatabase();
		databases.push(database);
		const paidOrder = recordPaidOrder(database, 'shipping');
		database
			.prepare(
				`UPDATE orders SET fulfillment_status = 'in_production', styria_order_id = ?,
					styria_status = 'printing', submitted_at = ?, updated_at = ? WHERE id = ?`
			)
			.run(
				'styria-shipping-1042',
				'2026-07-17T09:00:00.000Z',
				'2026-07-17T10:00:00.000Z',
				paidOrder.id
			);
		const styria: StyriaGateway = {
			searchByExternalId: vi.fn(async () => []),
			create: vi.fn(async () => {
				throw new Error('TEST_CREATE_NOT_EXPECTED');
			}),
			get: vi.fn(async () => ({
				id: 'styria-shipping-1042',
				external_id: paidOrder.checkoutSessionId,
				created_at: '2026-07-17T09:00:00.000Z',
				status: 'printing',
				deleted: false,
				shipping_address: { country: 'Sweden' },
				shipping: {
					shippingMethod: 'courier',
					trackingNumber: 'TRACK-JIT-2042',
					shiped_at: '2026-07-17T12:00:00.000Z'
				},
				items: []
			}))
		};
		const outbox = new SqliteOutboxRepository(database);
		const sync = new SqliteStyriaSyncJob({
			database,
			styria,
			fulfillment: new SqliteFulfillmentRepository(database),
			outbox
		});
		const stripe = {
			retrieveFulfillmentDetails: vi.fn(async () => structuredClone(fulfillmentDetails))
		};
		const messages: PlunkSendInput[] = [];
		const plunk = {
			send: vi.fn(async (input: PlunkSendInput) => {
				messages.push(input);
				return { deliveryId: 'plunk-shipping-jit' };
			})
		};
		const worker = new PaidOrderAlertOutboxWorker({
			database,
			outbox,
			plunk,
			alertEmail: {
				to: 'orders@example.test',
				from: { name: 'Svelte Society Shop', email: 'shop@example.test' },
				replyTo: 'merch@sveltesociety.dev'
			},
			shipping: {
				stripe,
				sender: createShippingEmailSender(plunk, {
					name: 'Svelte Society Shop',
					email: 'shop@example.test'
				}),
				supportEmail: 'merch@sveltesociety.dev'
			}
		});

		await worker.drain(new Date('2026-07-17T10:01:00.000Z'));
		expect(stripe.retrieveFulfillmentDetails).not.toHaveBeenCalled();

		await expect(sync.run(new Date('2026-07-17T12:00:00.000Z'))).resolves.toEqual({
			checked: 1,
			updated: 1,
			shippingQueued: 1
		});
		expect(stripe.retrieveFulfillmentDetails).not.toHaveBeenCalled();
		expect(
			JSON.stringify(
				database.prepare("SELECT * FROM outbox_jobs WHERE kind = 'shipping-email'").all()
			)
		).not.toContain(fulfillmentDetails.email);

		await expect(worker.drain(new Date('2026-07-17T12:01:00.000Z'))).resolves.toEqual({
			completed: 1,
			rescheduled: 0
		});
		expect(stripe.retrieveFulfillmentDetails).toHaveBeenCalledOnce();
		expect(stripe.retrieveFulfillmentDetails).toHaveBeenCalledWith(paidOrder.checkoutSessionId);
		expect(messages.at(-1)).toMatchObject({
			to: fulfillmentDetails.email,
			subject: 'Your Svelte Society order is on the way',
			replyTo: 'merch@sveltesociety.dev'
		});
		expect(messages.at(-1)?.html).toContain('1 × Community Tee (M)');
		expect(messages.at(-1)?.html).toContain('Tracking: TRACK-JIT-2042');
		const durable = JSON.stringify({
			jobs: database.prepare('SELECT * FROM outbox_jobs').all(),
			deliveries: database.prepare('SELECT * FROM email_deliveries').all()
		});
		expect(durable).not.toContain(fulfillmentDetails.email);
		expect(durable).not.toContain(fulfillmentDetails.address.line1);
		expect(database.prepare('SELECT * FROM email_deliveries').all()).toEqual([
			expect.objectContaining({
				kind: 'shipping',
				tracking_reference: 'TRACK-JIT-2042',
				provider_delivery_id: 'plunk-shipping-jit',
				attempt_count: 1,
				completed_at: expect.any(String)
			})
		]);
	});
});
