import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '$lib/server/db/migrate.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { createLogger } from '$lib/server/logging/logger.server';
import type { PlunkGateway } from '$lib/server/plunk/gateway';
import type { FulfillmentDetails, StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import type { StyriaGateway } from '$lib/server/styria/gateway';
import type { StyriaOrder } from '$lib/server/styria/types';
import { encryptWithdrawalPayload } from '$lib/server/withdrawals/crypto.server';
import { SqliteWithdrawalRepository } from '$lib/server/withdrawals/repository.server';
import { _createMcpRequestHandler } from '../../../routes/mcp/+server';
import { createRuntimeMcpServices } from './runtime.server';
import { createMcpResponder } from './transport.server';

const migrationsDirectory = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const TOKEN = 'runtime-test-token';
const withdrawalDataKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const environment = {
	PRODUCTION_ORIGIN: 'https://shop.runtime.test',
	STRIPE_SECRET_KEY: 'sk_test_runtime',
	STYRIA_APP_ID: 'runtime-app',
	STYRIA_SECRET_KEY: 'runtime-secret',
	STYRIA_BASE_URL: 'https://styria.runtime.test',
	STYRIA_TIMEOUT_MS: '4321',
	STYRIA_BRAND_NAME: 'Svelte Society',
	PLUNK_SECRET_KEY: 'plunk-runtime-secret',
	PLUNK_FROM_NAME: 'Svelte Society Shop',
	PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	WITHDRAWAL_DATA_KEY: withdrawalDataKey.toString('base64')
};

type JsonRpcResponse = {
	jsonrpc: '2.0';
	id: number;
	result: Record<string, unknown>;
};

function seedPendingOrder(database: ShopDatabase): void {
	database
		.prepare(
			`INSERT INTO checkout_drafts (
				id, stripe_checkout_session_id, contract_version, currency, total_unit_count,
				shipping_mode, created_at, expires_at, completed_at
			) VALUES ('draft_runtime', 'cs_runtime', 1, 'eur', 1, 'paid',
				'2026-07-17T08:00:00.000Z', '2026-07-17T09:00:00.000Z',
				'2026-07-17T08:30:00.000Z')`
		)
		.run();
	database
		.prepare(
			`INSERT INTO orders (
				id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
				checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
				tax_amount, total_amount, destination_country, payment_status, fulfillment_status,
				styria_order_id, styria_status, tracking_number, submitted_at, shipped_at,
				updated_at, last_error_code
			) VALUES ('order_runtime', 'cs_runtime', 'pi_runtime', 'cus_runtime', 'draft_runtime',
				'eur', 2799, 0, 1000, 950, 4749, 'SE', 'paid', 'pending_review',
				'styria-secret-runtime', 'provider-secret-runtime', 'tracking-secret-runtime',
				NULL, NULL, '2026-07-16T08:30:00.000Z', NULL)`
		)
		.run();
	database
		.prepare(
			`INSERT INTO order_lines (
				order_id, line_index, stripe_product_id, stripe_price_id, product_name,
				variant_label, sku, styria_product_number, design_reference, design_json,
				quantity, unit_amount, currency
			) VALUES ('order_runtime', 0, 'prod_runtime', 'price_runtime', 'Community Tee',
				'M', 'SS-TEE-M', 'STYRIA-TEE-M', 'community-v1',
				'{"front":"https://cdn.example.test/front.svg"}', 1, 2799, 'eur')`
		)
		.run();
}

function seedWithdrawal(database: ShopDatabase): void {
	new SqliteWithdrawalRepository(database).createSubmission({
		id: 'case_runtime_private',
		reference: 'WDR-RRRRRRRRRRRRRRRRRRRRRR',
		scope: 'specific_items',
		encryptedPayload: encryptWithdrawalPayload(
			{
				fullName: 'Runtime Private Customer',
				receiptEmail: 'runtime.withdrawal@example.test',
				enteredOrderReference: 'RUNTIME-PRIVATE-ORDER',
				items: [{ description: 'Runtime private hoodie', quantity: 1 }],
				reconciliation: null
			},
			'case_runtime_private',
			withdrawalDataKey
		),
		dedupeFingerprint: 'd'.repeat(64),
		createdAt: new Date('2026-07-17T08:45:00.000Z')
	});
}

function stripeGateway(): StripeFulfillmentGateway {
	const details: FulfillmentDetails = {
		recipient: { firstName: 'Ada', lastName: 'Lovelace', company: '', phone: '+46701234567' },
		address: {
			line1: 'Currentgatan 9',
			line2: '',
			city: 'Stockholm',
			state: '',
			postalCode: '11122',
			countryCode: 'SE'
		},
		email: 'ada@example.test'
	};
	return { retrieveFulfillmentDetails: vi.fn(async () => details) };
}

function styriaGateway(): StyriaGateway {
	const unavailable = async (): Promise<StyriaOrder> => {
		throw new Error('TEST_PROVIDER_NOT_CALLED');
	};
	return {
		searchByExternalId: vi.fn(async () => []),
		create: vi.fn(unavailable),
		get: vi.fn(unavailable)
	};
}

function plunkGateway(): PlunkGateway {
	return { send: vi.fn(async () => ({ deliveryId: 'plunk-runtime-delivery' })) };
}

function rpcRequest(
	body: Record<string, unknown>,
	options: { token?: string; sessionId?: string } = {}
): Request {
	const headers = new Headers({
		'content-type': 'application/json',
		authorization: `Bearer ${options.token ?? TOKEN}`
	});
	if (options.sessionId) headers.set('mcp-session-id', options.sessionId);
	return new Request('https://shop.sveltesociety.dev/mcp', {
		method: 'POST',
		headers,
		body: JSON.stringify(body)
	});
}

async function eventData(response: Response): Promise<JsonRpcResponse> {
	const payload = await response.text();
	const data = payload
		.split('\n')
		.find((line) => line.startsWith('data: '))
		?.slice('data: '.length);
	if (!data) throw new Error('MCP_EVENT_DATA_MISSING');
	return JSON.parse(data) as JsonRpcResponse;
}

function initializeBody(): Record<string, unknown> {
	return {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'runtime-composition-test', version: '1.0.0' }
		}
	};
}

function createComposedRuntimeHandler(database: ShopDatabase) {
	const respond = createMcpResponder(() =>
		createRuntimeMcpServices(database, environment, {
			createStripeGateway: () => stripeGateway(),
			createStyriaGateway: () => styriaGateway(),
			createPlunkGateway: () => plunkGateway()
		})
	);
	return _createMcpRequestHandler({ MCP_ENABLED: 'true', MCP_BEARER_TOKEN: TOKEN }, respond);
}

async function initializeRuntimeSession(
	handler: ReturnType<typeof createComposedRuntimeHandler>,
	sessionId: string
): Promise<void> {
	const initialized = await handler({
		request: rpcRequest(initializeBody(), { sessionId })
	} as Parameters<typeof handler>[0]);
	expect(initialized.status).toBe(200);
}

async function inspectWithdrawal(
	handler: ReturnType<typeof createComposedRuntimeHandler>,
	sessionId: string,
	reference: string
): Promise<JsonRpcResponse> {
	const response = await handler({
		request: rpcRequest(
			{
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'inspect_withdrawal_case', arguments: { reference } }
			},
			{ sessionId }
		)
	} as Parameters<typeof handler>[0]);
	return eventData(response);
}

describe('runtime MCP composition', () => {
	const databases: Database.Database[] = [];

	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	it('composes once after authentication and serves core tools from the current database', async () => {
		const database = new Database(':memory:');
		databases.push(database);
		migrate(database, migrationsDirectory);
		seedPendingOrder(database);
		seedWithdrawal(database);
		const stripe = stripeGateway();
		const styria = styriaGateway();
		const plunk = plunkGateway();
		const plunkSend = vi.mocked(plunk.send);
		const createStripeGateway = vi.fn(() => stripe);
		const createStyriaGateway = vi.fn(() => styria);
		const createPlunkGateway = vi.fn(() => plunk);
		let composed: ReturnType<typeof createRuntimeMcpServices> | undefined;
		const compose = vi.fn(() => {
			composed = createRuntimeMcpServices(database, environment, {
				createStripeGateway,
				createStyriaGateway,
				createPlunkGateway
			});
			return composed;
		});
		const respond = createMcpResponder(compose);
		const handler = _createMcpRequestHandler(
			{ MCP_ENABLED: 'true', MCP_BEARER_TOKEN: TOKEN },
			respond
		);

		const rejected = await handler({
			request: rpcRequest(initializeBody(), { token: 'wrong-token' })
		} as Parameters<typeof handler>[0]);
		expect(rejected.status).toBe(401);
		expect(compose).not.toHaveBeenCalled();

		const sessionId = 'runtime-composed-session';
		const initialized = await handler({
			request: rpcRequest(initializeBody(), { sessionId })
		} as Parameters<typeof handler>[0]);
		expect(initialized.status).toBe(200);
		expect(compose).toHaveBeenCalledOnce();
		expect(composed?.fulfillment).toBeDefined();
		expect(composed?.stripe).toBeDefined();
		expect(composed?.preparation).toBeDefined();
		expect(composed?.submission).toBeDefined();
		expect(composed?.reconciliation).toBeDefined();
		expect(composed?.status).toBeDefined();
		expect(composed?.shipping).toBeDefined();
		expect(composed?.withdrawals).toBeDefined();
		expect(createStripeGateway).toHaveBeenCalledWith('sk_test_runtime');
		expect(createStyriaGateway).toHaveBeenCalledWith({
			appId: 'runtime-app',
			secretKey: 'runtime-secret',
			baseUrl: 'https://styria.runtime.test',
			timeoutMs: 4321
		});
		expect(createPlunkGateway).toHaveBeenCalledWith('plunk-runtime-secret');

		const called = await handler({
			request: rpcRequest(
				{
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'list_pending_orders', arguments: { limit: 10 } }
				},
				{ sessionId }
			)
		} as Parameters<typeof handler>[0]);
		const message = await eventData(called);
		const result = message.result as {
			isError?: boolean;
			content: Array<{ text: string }>;
			structuredContent: { orders: Array<Record<string, unknown>> };
		};

		expect(compose).toHaveBeenCalledOnce();
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent.orders).toEqual([
			expect.objectContaining({ order_id: 'order_runtime', fulfillment_status: 'pending_review' })
		]);
		expect(result.content[0].text).toBe(JSON.stringify(result.structuredContent));
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('SERVICE_UNAVAILABLE');
		expect(serialized).not.toContain('styria-secret-runtime');
		expect(serialized).not.toContain('provider-secret-runtime');
		expect(serialized).not.toContain('tracking-secret-runtime');

		vi.mocked(styria.get).mockResolvedValueOnce({
			id: 'styria-secret-runtime',
			external_id: 'cs_runtime',
			created_at: '2026-07-17T08:30:00.000Z',
			status: 'unexpected provider status',
			deleted: false,
			shipping_address: { country: 'Sweden' },
			shipping: { shippingMethod: 'courier', trackingNumber: null, shiped_at: null },
			items: []
		});
		const statusCalled = await handler({
			request: rpcRequest(
				{
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: { name: 'check_fulfillment_status', arguments: { order_id: 'order_runtime' } }
				},
				{ sessionId }
			)
		} as Parameters<typeof handler>[0]);
		const statusMessage = await eventData(statusCalled);
		expect(statusMessage.result).toMatchObject({
			structuredContent: {
				orderId: 'order_runtime',
				fulfillmentStatus: 'review_required',
				styriaStatus: 'unexpected provider status',
				trackingNumber: 'tracking-secret-runtime'
			}
		});

		const previewed = await handler({
			request: rpcRequest(
				{
					jsonrpc: '2.0',
					id: 4,
					method: 'tools/call',
					params: { name: 'resend_shipping_email', arguments: { order_id: 'order_runtime' } }
				},
				{ sessionId }
			)
		} as Parameters<typeof handler>[0]);
		const previewMessage = await eventData(previewed);
		expect(previewMessage.result).toMatchObject({
			structuredContent: {
				order_id: 'order_runtime',
				mode: 'preview',
				email: 'ada@example.test',
				tracking_number: 'tracking-secret-runtime',
				sent: false
			}
		});

		const sent = await handler({
			request: rpcRequest(
				{
					jsonrpc: '2.0',
					id: 5,
					method: 'tools/call',
					params: {
						name: 'resend_shipping_email',
						arguments: {
							order_id: 'order_runtime',
							mode: 'send',
							expected_email: 'ada@example.test',
							expected_tracking_number: 'tracking-secret-runtime'
						}
					}
				},
				{ sessionId }
			)
		} as Parameters<typeof handler>[0]);
		const sentMessage = await eventData(sent);
		expect(sentMessage.result).toMatchObject({
			structuredContent: { order_id: 'order_runtime', mode: 'send', sent: true }
		});
		expect(plunk.send).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'ada@example.test',
				replyTo: 'merch@sveltesociety.dev',
				subject: 'Your Svelte Society order is on the way',
				html: expect.stringContaining(
					'<a href="https://shop.runtime.test/withdraw">Withdraw from this purchase</a>'
				)
			})
		);
		expect(JSON.stringify(plunkSend.mock.calls)).not.toContain('order_runtime?');
		expect(
			database
				.prepare('SELECT kind, tracking_reference, provider_delivery_id FROM email_deliveries')
				.all()
		).toEqual([
			{
				kind: 'shipping-support',
				tracking_reference: 'tracking-secret-runtime',
				provider_delivery_id: 'plunk-runtime-delivery'
			}
		]);
		const persisted = JSON.stringify(database.prepare('SELECT * FROM email_deliveries').all());
		expect(persisted).not.toContain('ada@example.test');
		expect(persisted).not.toContain('Currentgatan');

		const listedWithdrawals = await handler({
			request: rpcRequest(
				{
					jsonrpc: '2.0',
					id: 6,
					method: 'tools/call',
					params: { name: 'list_withdrawal_cases', arguments: {} }
				},
				{ sessionId }
			)
		} as Parameters<typeof handler>[0]);
		const listedWithdrawalMessage = await eventData(listedWithdrawals);
		expect(listedWithdrawalMessage.result).toMatchObject({
			structuredContent: {
				cases: [
					expect.objectContaining({
						reference: 'WDR-RRRRRRRRRRRRRRRRRRRRRR',
						status: 'submitted'
					})
				]
			}
		});
		expect(JSON.stringify(listedWithdrawalMessage)).not.toContain('Runtime Private Customer');
		expect(JSON.stringify(listedWithdrawalMessage)).not.toContain(
			'runtime.withdrawal@example.test'
		);

		const inspectedWithdrawal = await handler({
			request: rpcRequest(
				{
					jsonrpc: '2.0',
					id: 7,
					method: 'tools/call',
					params: {
						name: 'inspect_withdrawal_case',
						arguments: { reference: 'WDR-RRRRRRRRRRRRRRRRRRRRRR' }
					}
				},
				{ sessionId }
			)
		} as Parameters<typeof handler>[0]);
		const inspectedWithdrawalMessage = await eventData(inspectedWithdrawal);
		expect(inspectedWithdrawalMessage.result).toMatchObject({
			structuredContent: {
				reference: 'WDR-RRRRRRRRRRRRRRRRRRRRRR',
				customer: {
					full_name: 'Runtime Private Customer',
					receipt_email: 'runtime.withdrawal@example.test',
					entered_order_reference: 'RUNTIME-PRIVATE-ORDER'
				},
				events: [expect.objectContaining({ result_code: 'NOTICE_RECEIVED' })],
				messages: [
					expect.objectContaining({
						source_message_id: expect.any(Number),
						kind: 'receipt',
						attempt_count: 0
					})
				]
			}
		});
		expect(JSON.stringify(inspectedWithdrawalMessage)).not.toContain('case_runtime_private');
		expect(JSON.stringify(inspectedWithdrawalMessage)).not.toContain('withdrawal:receipt');

		const encrypted = database
			.prepare("SELECT encrypted_payload FROM withdrawal_cases WHERE id = 'case_runtime_private'")
			.get() as { encrypted_payload: Buffer };
		const tampered = Buffer.from(encrypted.encrypted_payload);
		tampered[0] ^= 255;
		database
			.prepare(
				"UPDATE withdrawal_cases SET encrypted_payload = ? WHERE id = 'case_runtime_private'"
			)
			.run(tampered);
		const beforeCorruptInspection = {
			cases: database.prepare('SELECT * FROM withdrawal_cases').all(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		};
		const historyRead = vi.spyOn(SqliteWithdrawalRepository.prototype, 'getInspectionHistory');
		const corruptWithdrawal = await handler({
			request: rpcRequest(
				{
					jsonrpc: '2.0',
					id: 8,
					method: 'tools/call',
					params: {
						name: 'inspect_withdrawal_case',
						arguments: { reference: 'WDR-RRRRRRRRRRRRRRRRRRRRRR' }
					}
				},
				{ sessionId }
			)
		} as Parameters<typeof handler>[0]);
		const corruptWithdrawalMessage = await eventData(corruptWithdrawal);
		expect(corruptWithdrawalMessage.result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'WITHDRAWAL_DECRYPT_FAILED' } }
		});
		expect(historyRead).not.toHaveBeenCalled();
		historyRead.mockRestore();
		expect({
			cases: database.prepare('SELECT * FROM withdrawal_cases').all(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		}).toEqual(beforeCorruptInspection);
		expect(
			database
				.prepare(
					`SELECT alert_code, alert_subject_id FROM outbox_jobs
					 WHERE alert_code = 'WITHDRAWAL_DATA_UNREADABLE'`
				)
				.all()
		).toEqual([
			{
				alert_code: 'WITHDRAWAL_DATA_UNREADABLE',
				alert_subject_id: 'WDR-RRRRRRRRRRRRRRRRRRRRRR'
			}
		]);
	});

	it('redacts withdrawal PII from MCP route logs while retaining public operations metadata', () => {
		const lines: string[] = [];
		const logger = createLogger((serialized) => lines.push(serialized));

		logger({
			level: 'warn',
			code: 'HTTP_REQUEST_REJECTED',
			fields: {
				reference: 'WDR-RRRRRRRRRRRRRRRRRRRRRR',
				status: 400,
				last_error_code: 'WITHDRAWAL_CASE_NOT_FOUND',
				fullName: 'Runtime Private Customer',
				receiptEmail: 'runtime.withdrawal@example.test',
				enteredOrderReference: 'RUNTIME-PRIVATE-ORDER',
				items: [{ description: 'Runtime private hoodie', quantity: 1 }],
				messagePreview: 'Private message preview',
				cookie: 'withdrawal_receipt_session=private',
				requestBody: '{"fullName":"Runtime Private Customer"}'
			}
		});

		expect(JSON.parse(lines[0])).toEqual({
			reference: 'WDR-RRRRRRRRRRRRRRRRRRRRRR',
			status: 400,
			last_error_code: 'WITHDRAWAL_CASE_NOT_FOUND',
			fullName: '[REDACTED]',
			receiptEmail: '[REDACTED]',
			enteredOrderReference: '[REDACTED]',
			items: '[REDACTED]',
			messagePreview: '[REDACTED]',
			cookie: '[REDACTED]',
			requestBody: '[REDACTED]',
			level: 'warn',
			code: 'HTTP_REQUEST_REJECTED'
		});
	});

	it('returns a stable not-found inspection error through the authenticated composed runtime without reading history', async () => {
		const database = new Database(':memory:');
		databases.push(database);
		migrate(database, migrationsDirectory);
		const handler = createComposedRuntimeHandler(database);
		const historyRead = vi.spyOn(SqliteWithdrawalRepository.prototype, 'getInspectionHistory');

		try {
			const unauthorized = await handler({
				request: rpcRequest(initializeBody(), { token: 'wrong-token' })
			} as Parameters<typeof handler>[0]);
			expect(unauthorized.status).toBe(401);

			const sessionId = 'runtime-missing-withdrawal-session';
			await initializeRuntimeSession(handler, sessionId);
			const message = await inspectWithdrawal(handler, sessionId, 'WDR-MMMMMMMMMMMMMMMMMMMMMM');

			expect(message.result).toMatchObject({
				isError: true,
				structuredContent: { error: { code: 'WITHDRAWAL_CASE_NOT_FOUND' } }
			});
			expect(historyRead).not.toHaveBeenCalled();
		} finally {
			historyRead.mockRestore();
		}
	});

	it('returns a stable PII-purged inspection error through the authenticated composed runtime without reading history', async () => {
		const database = new Database(':memory:');
		databases.push(database);
		migrate(database, migrationsDirectory);
		seedWithdrawal(database);
		database
			.prepare(
				`UPDATE withdrawal_cases SET schema_version = NULL,
				 encryption_key_version = NULL, encrypted_payload = NULL,
				 payload_nonce = NULL, payload_tag = NULL, dedupe_fingerprint = NULL,
				 purged_at = '2026-07-17T09:00:00.000Z'
				 WHERE id = 'case_runtime_private'`
			)
			.run();
		const handler = createComposedRuntimeHandler(database);
		const historyRead = vi.spyOn(SqliteWithdrawalRepository.prototype, 'getInspectionHistory');

		try {
			const sessionId = 'runtime-purged-withdrawal-session';
			await initializeRuntimeSession(handler, sessionId);
			const message = await inspectWithdrawal(handler, sessionId, 'WDR-RRRRRRRRRRRRRRRRRRRRRR');

			expect(message.result).toMatchObject({
				isError: true,
				structuredContent: { error: { code: 'WITHDRAWAL_PII_PURGED' } }
			});
			expect(historyRead).not.toHaveBeenCalled();
		} finally {
			historyRead.mockRestore();
		}
	});
});
