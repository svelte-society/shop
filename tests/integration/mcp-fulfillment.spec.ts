import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteOutboxRepository } from '../../src/lib/server/db/outbox.server';
import { SqliteFulfillmentRepository } from '../../src/lib/server/fulfillment/repository.server';
import { PaidOrderAlertOutboxWorker } from '../../src/lib/server/jobs/outbox-worker.server';
import { SqliteStyriaSyncJob } from '../../src/lib/server/jobs/styria-sync.server';
import { createRuntimeMcpServices } from '../../src/lib/server/mcp/runtime.server';
import { createShippingEmailSender } from '../../src/lib/server/plunk/shipping-email';
import type { PlunkSendInput } from '../../src/lib/server/plunk/gateway';
import type { StyriaGateway } from '../../src/lib/server/styria/gateway';
import type { StyriaOrder, StyriaOrderPayload } from '../../src/lib/server/styria/types';
import {
	createLifecycleDatabase,
	createLocalMcpClient,
	durableDatabaseDump,
	expectNoFixturePii,
	fulfillmentDetails,
	MCP_TOKEN,
	orderFromPayload,
	recordPaidOrder
} from '../fixtures/fulfillment-lifecycle';

const runtimeEnvironment = {
	STRIPE_SECRET_KEY: 'sk_test_lifecycle',
	STYRIA_APP_ID: 'app-lifecycle',
	STYRIA_SECRET_KEY: 'secret-lifecycle',
	STYRIA_BASE_URL: 'https://styria.example.test',
	STYRIA_BRAND_NAME: 'Svelte Society',
	PLUNK_SECRET_KEY: 'plunk-test-lifecycle',
	PLUNK_FROM_NAME: 'Svelte Society Shop',
	PLUNK_FROM_EMAIL: 'shop@example.test',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev'
};

describe('Codex MCP fulfillment lifecycle', () => {
	const databases: Array<ReturnType<typeof createLifecycleDatabase>> = [];

	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
		vi.useRealTimers();
	});

	it('moves a paid order through MCP approval, hourly tracking sync, and just-in-time shipping email', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-17T10:00:00.000Z'));
		const database = createLifecycleDatabase();
		databases.push(database);
		const paidOrder = recordPaidOrder(database, 'success');
		let providerOrder: StyriaOrder | undefined;
		const create = vi.fn(async (payload: StyriaOrderPayload) => {
			providerOrder = orderFromPayload(payload);
			return structuredClone(providerOrder);
		});
		const get = vi.fn(async () => {
			if (!providerOrder) throw new Error('TEST_STYRIA_ORDER_MISSING');
			return structuredClone(providerOrder);
		});
		const styria: StyriaGateway = {
			searchByExternalId: vi.fn(async () => []),
			create,
			get
		};
		const stripe = {
			retrieveFulfillmentDetails: vi.fn(async () => structuredClone(fulfillmentDetails))
		};
		const plunkMessages: PlunkSendInput[] = [];
		const plunk = {
			send: vi.fn(async (input: PlunkSendInput) => {
				plunkMessages.push(input);
				return { deliveryId: `plunk-${plunkMessages.length}` };
			})
		};
		const createServices = vi.fn(() =>
			createRuntimeMcpServices(database, runtimeEnvironment, {
				createStripeGateway: () => stripe,
				createStyriaGateway: () => styria,
				createPlunkGateway: () => plunk
			})
		);
		const client = createLocalMcpClient(createServices);
		expect(createServices).not.toHaveBeenCalled();

		const initialized = await client.initialize();
		expect(createServices).toHaveBeenCalledOnce();
		expect(initialized.response.status).toBe(200);
		expect(initialized.response.headers.get('mcp-session-id')).toBeTruthy();
		expect(initialized.response.headers.get('mcp-session-id')).not.toBe('integration-mcp-session');
		expect(initialized.message.result).toMatchObject({
			serverInfo: { name: 'svelte-society-shop', version: '1.0.0' }
		});

		const listedTools = await client.listTools();
		expect(listedTools.response.headers.get('mcp-session-id')).toBe(
			initialized.response.headers.get('mcp-session-id')
		);
		const tools = listedTools.message.result.tools as Array<{
			name: string;
			annotations: { readOnlyHint: boolean };
		}>;
		expect(tools.map((tool) => tool.name)).toContain('list_pending_orders');
		expect(
			tools.find((tool) => tool.name === 'prepare_styria_submission')?.annotations
		).toMatchObject({ readOnlyHint: false });

		const pending = await client.call('list_pending_orders', { limit: 10 });
		expect(pending.message.result).toMatchObject({
			structuredContent: {
				orders: [
					expect.objectContaining({
						order_id: paidOrder.id,
						fulfillment_status: 'pending_review'
					})
				]
			}
		});

		const inspected = await client.call('inspect_order', {
			order_id: paidOrder.id,
			include_shipping_details: false
		});
		expect(inspected.message.result).toMatchObject({
			structuredContent: {
				order_id: paidOrder.id,
				payment: { status: 'paid' },
				fulfillment: { status: 'pending_review' }
			}
		});
		expectNoFixturePii(inspected.message.result);

		const prepared = await client.call('prepare_styria_submission', { order_id: paidOrder.id });
		const preparation = prepared.message.result.structuredContent as {
			status: string;
			approvalId: string;
			payload: StyriaOrderPayload;
		};
		expect(preparation).toMatchObject({
			status: 'ready',
			approvalId: expect.any(String),
			payload: { external_id: paidOrder.checkoutSessionId, brandName: 'Svelte Society' }
		});

		const submitted = await client.call('submit_styria_order', {
			order_id: paidOrder.id,
			approval_id: preparation.approvalId
		});
		expect(submitted.message.result).toMatchObject({
			structuredContent: {
				orderId: paidOrder.id,
				fulfillmentStatus: 'awaiting_vendor_payment',
				manualPaymentRequired: true
			}
		});
		expect(create).toHaveBeenCalledOnce();

		const outbox = new SqliteOutboxRepository(database);
		const sync = new SqliteStyriaSyncJob({
			database,
			styria,
			fulfillment: new SqliteFulfillmentRepository(database),
			outbox
		});
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
		await worker.drain(new Date('2026-07-17T10:00:00.000Z'));

		providerOrder = orderFromPayload(preparation.payload, {
			id: providerOrder?.id,
			status: 'printing'
		});
		await expect(sync.run(new Date('2026-07-17T11:00:00.000Z'))).resolves.toEqual({
			checked: 1,
			updated: 1,
			shippingQueued: 0
		});
		expect(new SqliteFulfillmentRepository(database).inspect(paidOrder.id)?.fulfillmentStatus).toBe(
			'in_production'
		);

		providerOrder = orderFromPayload(preparation.payload, {
			id: providerOrder.id,
			status: 'printing',
			shipping: {
				shippingMethod: 'courier',
				trackingNumber: 'TRACK-SOCIETY-2042',
				shiped_at: '2026-07-17T12:00:00.000Z'
			}
		});
		await expect(sync.run(new Date('2026-07-17T12:00:00.000Z'))).resolves.toEqual({
			checked: 1,
			updated: 1,
			shippingQueued: 1
		});
		await expect(worker.drain(new Date('2026-07-17T12:01:00.000Z'))).resolves.toEqual({
			completed: 1,
			rescheduled: 0
		});

		expect(stripe.retrieveFulfillmentDetails).toHaveBeenCalledTimes(3);
		expect(plunkMessages.at(-1)).toMatchObject({
			to: fulfillmentDetails.email,
			replyTo: 'merch@sveltesociety.dev',
			subject: 'Your Svelte Society order is on the way'
		});
		expect(plunkMessages.at(-1)?.html).toContain('Tracking: TRACK-SOCIETY-2042');
		expect(
			database
				.prepare(
					'SELECT kind, tracking_reference, provider_delivery_id, completed_at FROM email_deliveries'
				)
				.all()
		).toEqual([
			expect.objectContaining({
				kind: 'shipping',
				tracking_reference: 'TRACK-SOCIETY-2042',
				provider_delivery_id: 'plunk-2',
				completed_at: expect.any(String)
			})
		]);
		expectNoFixturePii(durableDatabaseDump(database));
	});

	it('rejects disabled and invalid bearer requests before protocol handling without echoing tokens', async () => {
		const createDisabledServices = vi.fn(() => ({}));
		const disabled = createLocalMcpClient(createDisabledServices, { enabled: 'false' });
		const disabledResponse = await disabled.post({ jsonrpc: '2.0', id: 1, method: 'initialize' });
		expect(disabledResponse.status).toBe(404);
		expect(createDisabledServices).not.toHaveBeenCalled();

		const createServices = vi.fn(() => ({}));
		const client = createLocalMcpClient(createServices);
		const rejected = await client.post(
			{ jsonrpc: '2.0', id: 2, method: 'initialize' },
			'invalid-bearer-never-echo'
		);
		const observable = `${rejected.status}\n${JSON.stringify([...rejected.headers])}\n${await rejected.text()}`;
		expect(rejected.status).toBe(401);
		expect(rejected.headers.get('www-authenticate')).toBe('Bearer');
		expect(createServices).not.toHaveBeenCalled();
		expect(observable).not.toContain('invalid-bearer-never-echo');
		expect(observable).not.toContain(MCP_TOKEN);
	});

	it('documents the shared Codex host, exact bearer config, and a pending live-host gate', () => {
		const document = readFileSync(resolve('docs/operations/codex-mcp.md'), 'utf8');
		const exactConfig = `[mcp_servers.svelte_society_shop]\nurl = "https://shop.sveltesociety.dev/mcp"\nbearer_token_env_var = "SVELTE_SHOP_MCP_TOKEN"\ndefault_tools_approval_mode = "writes"`;

		expect(document).toContain('openssl rand -hex 32');
		expect(document).not.toMatch(/mktemp|token_file/i);
		expect(document).toContain('IFS= read -r SVELTE_SHOP_MCP_TOKEN < <(openssl rand -hex 32)');
		expect(document).toContain(`printf '%s' "$SVELTE_SHOP_MCP_TOKEN" | pbcopy`);
		expect(document).toMatch(/clear.*clipboard/is);
		expect(document).toMatch(/clipboard manager.*risk/is);
		expect(document).toMatch(/approved secret manager/is);
		expect(document).toMatch(/memory.*not.*disk/is);
		expect(document).toContain('MCP_BEARER_TOKEN');
		expect(document).toContain('SVELTE_SHOP_MCP_TOKEN');
		expect(document).toContain(exactConfig);
		expect(document).toMatch(/ChatGPT desktop app.*Codex CLI.*share/is);
		expect(document).toMatch(/MCP_ENABLED=false.*404/is);
		expect(document).toMatch(/invalid.*401/is);
		expect(document).toMatch(/redact/is);
		expect(document).toMatch(/rotation/is);
		expect(document).toMatch(/rollback/is);
		expect(document).toMatch(/2026-07-17\s*\|\s*unavailable\s*\|\s*PENDING/i);
	});
});
