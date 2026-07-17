import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { HttpTransport } from '@tmcp/transport-http';
import { SqliteCheckoutDraftRepository } from '../../src/lib/server/db/checkout-drafts.server';
import { SqlitePaidOrderUnitOfWork } from '../../src/lib/server/db/orders.server';
import { SqliteStripeEventRepository } from '../../src/lib/server/db/stripe-events.server';
import { migrate } from '../../src/lib/server/db/migrate.server';
import type { ShopDatabase } from '../../src/lib/server/db/types';
import { authorizeBearer } from '../../src/lib/server/mcp/auth.server';
import { createMcpServer, type McpServices } from '../../src/lib/server/mcp/server';
import type { FulfillmentDetails } from '../../src/lib/server/stripe/gateway';
import type { StyriaOrder, StyriaOrderPayload } from '../../src/lib/server/styria/types';

export const MCP_TOKEN = 'integration-mcp-token.never-log';
export const PAID_AT = new Date('2026-07-16T08:00:00.000Z');

export const fulfillmentDetails: FulfillmentDetails = {
	recipient: {
		firstName: 'Ada',
		lastName: 'Lovelace',
		company: 'Analytical Engines AB',
		phone: '+46701234567'
	},
	address: {
		line1: 'Sveltegatan 5',
		line2: 'Suite 3',
		city: 'Stockholm',
		state: 'Stockholm',
		postalCode: '111 22',
		countryCode: 'SE'
	},
	email: 'ada@example.test'
};

export function createLifecycleDatabase(): ShopDatabase {
	const database = new Database(':memory:');
	migrate(database, resolve('migrations'));
	return database;
}

export function recordPaidOrder(database: ShopDatabase, suffix: string) {
	const checkoutSessionId = `cs_test_lifecycle_${suffix}`;
	const paymentIntentId = `pi_test_lifecycle_${suffix}`;
	const customerId = `cus_test_lifecycle_${suffix}`;
	const drafts = new SqliteCheckoutDraftRepository(database);
	const draft = drafts.create({
		contractVersion: 1,
		currency: 'eur',
		totalUnitCount: 1,
		shippingMode: 'paid',
		createdAt: new Date(PAID_AT.getTime() - 60 * 60_000),
		expiresAt: new Date(PAID_AT.getTime() + 24 * 60 * 60_000),
		lines: [
			{
				stripeProductId: `prod_lifecycle_${suffix}`,
				stripePriceId: `price_lifecycle_${suffix}`,
				productName: 'Community Tee',
				variantLabel: 'M',
				sku: `SS-TEE-M-${suffix}`,
				styriaProductNumber: 'STYRIA-TEE-M',
				designReference: 'society-community-v1',
				designPlacements: {
					front: 'https://cdn.example.test/designs/community-front.svg'
				},
				quantity: 1,
				unitAmount: 2_799,
				currency: 'eur'
			}
		]
	});
	drafts.attachSession(draft.id, checkoutSessionId);

	const eventId = `evt_lifecycle_${suffix}`;
	const eventType = 'checkout.session.completed';
	new SqliteStripeEventRepository(database).begin(eventId, eventType, PAID_AT);
	return new SqlitePaidOrderUnitOfWork(database).commitPaidOrder(
		{
			checkoutSessionId,
			paymentIntentId,
			customerId,
			checkoutDraftId: draft.id,
			currency: 'eur',
			amounts: {
				subtotal: 2_799,
				discount: 0,
				shipping: 1_000,
				tax: 950,
				total: 4_749
			},
			destinationCountry: 'SE',
			updatedAt: PAID_AT
		},
		{ eventId, eventType, processedAt: PAID_AT }
	);
}

export function orderFromPayload(
	payload: StyriaOrderPayload,
	overrides: Partial<StyriaOrder> = {}
): StyriaOrder {
	return {
		id: 'styria-lifecycle-1042',
		external_id: payload.external_id,
		created_at: '2026-07-17T09:00:00.000Z',
		status: 'received',
		deleted: false,
		shipping_address: { country: payload.shipping_address.country },
		shipping: {
			shippingMethod: payload.shipping.shippingMethod,
			trackingNumber: null,
			shiped_at: null
		},
		items: structuredClone(payload.items),
		...overrides
	};
}

type RpcResponse = {
	jsonrpc: '2.0';
	id: number;
	result: Record<string, unknown>;
};

async function eventData(response: Response): Promise<RpcResponse> {
	const payload = await response.text();
	const data = payload
		.split('\n')
		.find((line) => line.startsWith('data: '))
		?.slice('data: '.length);
	if (!data) throw new Error('MCP_EVENT_DATA_MISSING');
	return JSON.parse(data) as RpcResponse;
}

export function createLocalMcpClient(
	services: McpServices,
	options: { token?: string; enabled?: string; sessionId?: string } = {}
) {
	const token = options.token ?? MCP_TOKEN;
	const sessionId = options.sessionId ?? 'integration-mcp-session';
	const transport = new HttpTransport(createMcpServer(services), { path: '/mcp' });
	const handler = async ({ request }: { request: Request }): Promise<Response> => {
		if ((options.enabled ?? 'true') === 'false') return new Response(null, { status: 404 });
		if (!authorizeBearer(request.headers.get('authorization'), MCP_TOKEN)) {
			return new Response(null, {
				status: 401,
				headers: { 'www-authenticate': 'Bearer' }
			});
		}
		return (await transport.respond(request)) ?? new Response(null, { status: 404 });
	};
	let nextId = 1;

	async function post(body: Record<string, unknown>, suppliedToken = token): Promise<Response> {
		const request = new Request('https://shop.sveltesociety.dev/mcp', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${suppliedToken}`,
				'mcp-session-id': sessionId
			},
			body: JSON.stringify(body)
		});
		return handler({ request });
	}

	return {
		handler,
		sessionId,
		async initialize() {
			const id = nextId++;
			const response = await post({
				jsonrpc: '2.0',
				id,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'codex-lifecycle-integration', version: '1.0.0' }
				}
			});
			return { response, message: await eventData(response) };
		},
		async listTools() {
			const id = nextId++;
			const response = await post({
				jsonrpc: '2.0',
				id,
				method: 'tools/list',
				params: {}
			});
			return { response, message: await eventData(response) };
		},
		async call(name: string, arguments_: Record<string, unknown>) {
			const id = nextId++;
			const response = await post({
				jsonrpc: '2.0',
				id,
				method: 'tools/call',
				params: { name, arguments: arguments_ }
			});
			return { response, message: await eventData(response) };
		},
		post
	};
}
