import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteFulfillmentRepository } from '../../src/lib/server/fulfillment/repository.server';
import { createRuntimeMcpServices } from '../../src/lib/server/mcp/runtime.server';
import { StyriaError, type StyriaGateway } from '../../src/lib/server/styria/gateway';
import type { StyriaOrder, StyriaOrderPayload } from '../../src/lib/server/styria/types';
import {
	createLifecycleDatabase,
	createLocalMcpClient,
	fulfillmentDetails,
	orderFromPayload,
	recordPaidOrder
} from '../fixtures/fulfillment-lifecycle';

const environment = {
	STRIPE_SECRET_KEY: 'sk_test_ambiguity',
	STYRIA_SUPPORTED_COUNTRIES: 'SE,JP,TW',
	STYRIA_APP_ID: 'app-ambiguity',
	STYRIA_SECRET_KEY: 'secret-ambiguity',
	STYRIA_BRAND_NAME: 'Svelte Society',
	PLUNK_SECRET_KEY: 'plunk-test-ambiguity',
	PLUNK_FROM_NAME: 'Svelte Society Shop',
	PLUNK_FROM_EMAIL: 'shop@example.test',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	WITHDRAWAL_DATA_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
};

describe('ambiguous Styria create reconciliation', () => {
	const databases: Array<ReturnType<typeof createLifecycleDatabase>> = [];

	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	it('creates once, blocks ordinary retry, and repairs one consistent provider match', async () => {
		const database = createLifecycleDatabase();
		databases.push(database);
		const paidOrder = recordPaidOrder(database, 'ambiguity');
		let capturedPayload: StyriaOrderPayload | undefined;
		const providerMatches: StyriaOrder[] = [];
		const searchByExternalId = vi.fn(async () => structuredClone(providerMatches));
		const create = vi.fn(async (payload: StyriaOrderPayload): Promise<StyriaOrder> => {
			capturedPayload = structuredClone(payload);
			throw new StyriaError('STYRIA_TIMEOUT');
		});
		const styria: StyriaGateway = {
			searchByExternalId,
			create,
			get: vi.fn(async () => {
				throw new Error('TEST_STATUS_NOT_EXPECTED');
			})
		};
		const services = createRuntimeMcpServices(database, environment, {
			createStripeGateway: () => ({
				retrieveFulfillmentDetails: vi.fn(async () => structuredClone(fulfillmentDetails))
			}),
			createStyriaGateway: () => styria,
			createPlunkGateway: () => ({
				send: vi.fn(async () => ({ deliveryId: 'unused' }))
			})
		});
		const client = createLocalMcpClient(() => services);
		await client.initialize();

		const prepared = await client.call('prepare_styria_submission', { order_id: paidOrder.id });
		const preparation = prepared.message.result.structuredContent as { approvalId: string };
		const firstSubmission = await client.call('submit_styria_order', {
			order_id: paidOrder.id,
			approval_id: preparation.approvalId
		});
		expect(firstSubmission.message.result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'STYRIA_RECONCILIATION_REQUIRED' } }
		});
		expect(create).toHaveBeenCalledOnce();
		expect(new SqliteFulfillmentRepository(database).inspect(paidOrder.id)).toMatchObject({
			fulfillmentStatus: 'review_required',
			lastErrorCode: 'STYRIA_CREATE_AMBIGUOUS'
		});

		const retry = await client.call('submit_styria_order', {
			order_id: paidOrder.id,
			approval_id: preparation.approvalId
		});
		expect(retry.message.result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'SUBMISSION_APPROVAL_USED' } }
		});
		expect(create).toHaveBeenCalledOnce();
		expect(searchByExternalId).toHaveBeenCalledOnce();

		if (!capturedPayload) throw new Error('TEST_CAPTURED_PAYLOAD_MISSING');
		providerMatches.push(orderFromPayload(capturedPayload, { id: 'styria-reconciled-2042' }));
		const reconciled = await client.call('reconcile_styria_order', { order_id: paidOrder.id });
		expect(reconciled.message.result).toMatchObject({
			structuredContent: {
				outcome: 'reconciled',
				matches: 1,
				fulfillmentStatus: 'awaiting_vendor_payment'
			}
		});
		expect(create).toHaveBeenCalledOnce();
		expect(searchByExternalId).toHaveBeenCalledTimes(2);
		expect(new SqliteFulfillmentRepository(database).inspect(paidOrder.id)).toMatchObject({
			fulfillmentStatus: 'awaiting_vendor_payment',
			styriaOrderId: 'styria-reconciled-2042',
			lastErrorCode: null
		});
	});
});
