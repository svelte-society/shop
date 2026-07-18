import { describe, expect, it, vi } from 'vitest';
import type { FulfillmentStatus, OrderEvent, OrderWithLines } from '$lib/domain/orders';
import type { WithdrawalPayloadV1, WithdrawalStatus } from '$lib/domain/withdrawals';
import type {
	OrderSummary,
	OrderWithLinesAndEvents,
	SupportNote
} from '$lib/server/fulfillment/repository.server';
import type { FulfillmentDetails } from '$lib/server/stripe/gateway';
import { WITHDRAWAL_LEGAL_STATUS_COPY } from '$lib/server/withdrawals/messages.server';
import { createMcpServer, type McpServices } from '../server';

type RpcResult = {
	jsonrpc: '2.0';
	id: number;
	result: Record<string, unknown>;
};

const now = new Date('2026-07-17T10:00:00.000Z');
const withdrawalPayload: WithdrawalPayloadV1 = {
	fullName: 'Private Withdrawal Customer',
	receiptEmail: 'withdrawal.private@example.test',
	enteredOrderReference: 'PRIVATE-ORDER-WDR-42',
	items: [{ description: 'Private orange hoodie', quantity: 2 }],
	reconciliation: {
		internalOrderReference: 'private-internal-order',
		countryCode: 'SE',
		customerInstructions: 'Private return instructions',
		returnOutcome: null,
		parcelReference: null
	}
};

function withdrawalCaseFixture(
	overrides: Partial<{
		id: string;
		reference: string;
		status: WithdrawalStatus;
		createdAt: Date;
		updatedAt: Date;
	}> = {}
) {
	return {
		id: 'case_private_newer',
		reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
		status: 'reviewing' as WithdrawalStatus,
		revision: 2,
		scope: 'specific_items' as const,
		eligibility: 'eligible_eu' as const,
		outcomeCode: 'RETURN_LABEL_SENT',
		createdAt: new Date('2026-07-17T09:30:00.000Z'),
		updatedAt: new Date('2026-07-17T09:45:00.000Z'),
		reconciledAt: new Date('2026-07-17T09:40:00.000Z'),
		closedAt: null,
		piiPurgeDueAt: null,
		purgedAt: null,
		...overrides
	};
}

function orderFixture(overrides: Partial<OrderWithLinesAndEvents> = {}): OrderWithLinesAndEvents {
	const order: OrderWithLines = {
		id: 'order_2042',
		checkoutSessionId: 'cs_test_2042',
		paymentIntentId: 'pi_test_2042',
		customerId: 'cus_test_2042',
		checkoutDraftId: 'draft_2042',
		currency: 'eur',
		amounts: { subtotal: 5_598, discount: 0, shipping: 0, tax: 1_400, total: 6_998 },
		destinationCountry: 'SE',
		paymentStatus: 'paid',
		fulfillmentStatus: 'pending_review',
		styriaOrderId: null,
		styriaStatus: null,
		trackingNumber: null,
		submittedAt: null,
		shippedAt: null,
		updatedAt: new Date('2026-07-17T09:30:00.000Z'),
		lastErrorCode: null,
		lines: [
			{
				orderId: 'order_2042',
				lineIndex: 0,
				stripeProductId: 'prod_tee',
				stripePriceId: 'price_tee_m',
				productName: 'Community Tee',
				variantLabel: 'M',
				sku: 'SS-TEE-M',
				styriaProductNumber: 'STYRIA-TEE-M',
				designReference: 'community-v1',
				designPlacements: { front: 'https://cdn.example.test/community-front.svg' },
				quantity: 2,
				unitAmount: 2_799,
				currency: 'eur'
			}
		]
	};
	const events: OrderEvent[] = [
		{
			id: 1,
			orderId: order.id,
			actor: 'stripe-webhook',
			action: 'paid_order_recorded',
			priorState: null,
			nextState: 'pending_review',
			result: 'succeeded',
			errorCode: null,
			createdAt: new Date('2026-07-17T09:00:00.000Z')
		}
	];
	const supportNotes: SupportNote[] = [
		{
			id: 1,
			orderId: order.id,
			outcome: 'return_approved',
			note: 'Reviewed in support mailbox',
			externalReference: 'ticket-2042',
			actor: 'codex-admin',
			createdAt: new Date('2026-07-17T09:45:00.000Z')
		}
	];
	return { ...order, events, supportNotes, ...overrides };
}

function summaryFixture(
	id: string,
	updatedAt: string,
	fulfillmentStatus: FulfillmentStatus = 'pending_review'
): OrderSummary {
	return {
		id,
		checkoutSessionId: `cs_${id}`,
		paymentStatus: 'paid',
		fulfillmentStatus,
		currency: 'eur',
		totalAmount: 6_998,
		destinationCountry: 'SE',
		styriaOrderId: `styria-private-${id}`,
		styriaStatus: `provider-private-${id}`,
		trackingNumber: `tracking-private-${id}`,
		updatedAt: new Date(updatedAt),
		lastErrorCode: null
	};
}

function shippingFixture(): FulfillmentDetails {
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
		email: 'ada@example.test'
	};
}

function setup(options: { inspected?: OrderWithLinesAndEvents | null } = {}) {
	const inspected = options.inspected === undefined ? orderFixture() : options.inspected;
	const fulfillment = {
		listPending: vi.fn(() => [
			summaryFixture('order_newer', '2026-07-17T09:50:00.000Z'),
			summaryFixture('order_oldest', '2026-07-17T09:10:00.000Z')
		]),
		inspect: vi.fn(() => inspected),
		recordSupportNote: vi.fn()
	};
	const stripe = { retrieveFulfillmentDetails: vi.fn(async () => shippingFixture()) };
	const preparation = {
		prepare: vi.fn(async (orderId: string) => ({
			status: 'blocked' as const,
			orderId,
			approvalId: null,
			expiresAt: null,
			payloadHash: null,
			payload: null,
			warnings: [],
			blockers: [{ code: 'DESTINATION_COUNTRY_UNSUPPORTED', message: 'Not supported.' }] as [
				{ code: string; message: string }
			]
		}))
	};
	const submission = {
		submit: vi.fn(async ({ orderId }: { orderId: string; approvalId: string }) => ({
			orderId,
			styriaOrderId: 'styria-2042',
			fulfillmentStatus: 'awaiting_vendor_payment' as const,
			manualPaymentRequired: true as const
		}))
	};
	const reconciliation = {
		reconcile: vi.fn(async () => ({
			outcome: 'reconciled' as const,
			matches: 1,
			fulfillmentStatus: 'awaiting_vendor_payment' as const
		}))
	};
	const status = {
		check: vi.fn(async (orderId: string) => ({
			orderId,
			fulfillmentStatus: 'in_production' as const,
			styriaStatus: 'printing',
			trackingNumber: null,
			customerEmail: 'status-private@example.test'
		}))
	};
	const shipping = {
		getTarget: vi.fn(async () => ({
			email: 'ada@example.test',
			trackingNumber: 'TRACK-2042'
		})),
		send: vi.fn(async (input: Record<string, string>) => ({
			orderId: input.orderId,
			email: input.expectedEmail,
			trackingNumber: input.expectedTrackingNumber,
			sent: true as const
		}))
	};
	const withdrawalCases = [
		withdrawalCaseFixture({
			id: 'case_private_older',
			reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
			status: 'submitted',
			createdAt: new Date('2026-07-17T08:30:00.000Z'),
			updatedAt: new Date('2026-07-17T08:30:00.000Z')
		}),
		withdrawalCaseFixture()
	];
	const withdrawals = {
		listCases: vi.fn(({ status, limit }: { status?: WithdrawalStatus; limit: number }) =>
			withdrawalCases
				.filter((entry) => status === undefined || entry.status === status)
				.slice(0, limit)
		),
		inspectCase: vi.fn(() => ({
			inspection: { ...withdrawalCaseFixture(), payload: withdrawalPayload },
			history: {
				events: [
					{
						actor: 'codex-admin' as const,
						action: 'review_started',
						priorStatus: 'submitted' as const,
						nextStatus: 'reviewing' as const,
						resultCode: 'REVIEW_STARTED',
						createdAt: new Date('2026-07-17T09:35:00.000Z')
					}
				],
				messages: [
					{
						kind: 'receipt' as const,
						attemptCount: 1,
						nextAttemptAt: new Date('2026-07-17T09:31:00.000Z'),
						providerDeliveryId: 'delivery_2042',
						completedAt: new Date('2026-07-17T09:31:00.000Z'),
						lastErrorCode: null
					}
				]
			}
		}))
	};
	const withdrawalWorkflow = {
		beginReview: vi.fn((input) => ({
			reference: input.reference,
			status: 'reviewing' as const,
			revision: input.expectedRevision + 1
		})),
		recordEligibility: vi.fn((input) => ({
			reference: input.reference,
			status:
				input.decision === 'eligible_eu'
					? ('awaiting_return' as const)
					: input.decision === 'ineligible_non_eu'
						? ('ineligible' as const)
						: ('support_handling' as const),
			revision: input.expectedRevision + 1
		})),
		recordReturn: vi.fn((input) => ({
			reference: input.reference,
			status: 'awaiting_return' as const,
			revision: input.expectedRevision + 1
		})),
		closeCase: vi.fn((input) => ({
			reference: input.reference,
			status: 'closed' as const,
			revision: input.expectedRevision + 1
		})),
		resendMessage: vi.fn<NonNullable<McpServices['withdrawalWorkflow']>['resendMessage']>(
			(input) => ({
				mode: 'preview',
				reference: input.reference,
				sourceMessageId: input.sourceMessageId,
				destination: 'withdrawal.private@example.test',
				subject: 'Withdrawal return instructions — WDR-BBBBBBBBBBBBBBBBBBBBBB',
				textBody: 'Private exact preview body',
				previewToken: 'v1.preview-token',
				expiresAt: new Date('2026-07-17T10:10:00.000Z'),
				queued: false
			})
		)
	} satisfies NonNullable<McpServices['withdrawalWorkflow']>;
	const services = {
		fulfillment,
		stripe,
		preparation,
		submission,
		reconciliation,
		status,
		shipping,
		withdrawals,
		withdrawalWorkflow,
		now: () => now
	} satisfies McpServices;
	return {
		server: createMcpServer(services),
		services: {
			fulfillment,
			stripe,
			preparation,
			submission,
			reconciliation,
			status,
			shipping,
			withdrawals,
			withdrawalWorkflow
		}
	};
}

async function request(
	server: ReturnType<typeof createMcpServer>,
	method: 'tools/list' | 'tools/call',
	params: Record<string, unknown>
): Promise<RpcResult> {
	return (await server.receive({ jsonrpc: '2.0', id: 1, method, params })) as RpcResult;
}

async function listTools(server: ReturnType<typeof createMcpServer>) {
	const response = await request(server, 'tools/list', {});
	return response.result.tools as Array<{
		name: string;
		inputSchema: Record<string, unknown>;
		outputSchema?: {
			type?: unknown;
			additionalProperties?: unknown;
			properties?: Record<string, unknown>;
		};
		annotations: Record<string, boolean>;
	}>;
}

async function callTool(
	server: ReturnType<typeof createMcpServer>,
	name: string,
	args: Record<string, unknown>
) {
	const response = await request(server, 'tools/call', { name, arguments: args });
	return response.result as {
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
		structuredContent?: Record<string, unknown>;
	};
}

function expectMirrored(result: Awaited<ReturnType<typeof callTool>>): void {
	expect(result.isError).not.toBe(true);
	expect(result.content).toHaveLength(1);
	expect(result.content[0]).toEqual({
		type: 'text',
		text: JSON.stringify(result.structuredContent)
	});
}

describe('fulfillment MCP protocol', () => {
	it('lists the exact tools with Valibot object schemas and exact annotations', async () => {
		const { server } = setup();
		const tools = await listTools(server);

		expect(tools.map((tool) => tool.name)).toEqual([
			'list_pending_orders',
			'inspect_order',
			'prepare_styria_submission',
			'submit_styria_order',
			'reconcile_styria_order',
			'check_fulfillment_status',
			'resend_shipping_email',
			'record_return_or_replacement',
			'list_withdrawal_cases',
			'inspect_withdrawal_case',
			'begin_withdrawal_review',
			'record_withdrawal_eligibility',
			'record_withdrawal_return',
			'close_withdrawal_case',
			'resend_withdrawal_message'
		]);
		expect(Object.fromEntries(tools.map(({ name, annotations }) => [name, annotations]))).toEqual({
			list_pending_orders: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			},
			inspect_order: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			},
			prepare_styria_submission: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true
			},
			submit_styria_order: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true
			},
			reconcile_styria_order: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true
			},
			check_fulfillment_status: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true
			},
			resend_shipping_email: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true
			},
			record_return_or_replacement: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false
			},
			list_withdrawal_cases: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			},
			inspect_withdrawal_case: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			},
			begin_withdrawal_review: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false
			},
			record_withdrawal_eligibility: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false
			},
			record_withdrawal_return: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false
			},
			close_withdrawal_case: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false
			},
			resend_withdrawal_message: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false
			}
		});
		for (const tool of tools) {
			expect(tool.inputSchema.type).toBe('object');
			expect(tool.outputSchema?.type).toBe('object');
			expect(tool.outputSchema?.additionalProperties).toBe(false);
			expect(Object.keys(tool.outputSchema?.properties ?? {})).not.toHaveLength(0);
			expect(tool.outputSchema?.properties).toHaveProperty('error');
		}
		const pendingOutput = tools.find((tool) => tool.name === 'list_pending_orders')?.outputSchema;
		const pendingItem = (
			pendingOutput?.properties as {
				orders?: {
					items?: { additionalProperties?: boolean; properties?: Record<string, unknown> };
				};
			}
		)?.orders?.items;
		expect(pendingItem?.additionalProperties).toBe(false);
		expect(pendingItem?.properties).not.toHaveProperty('styria_order_id');
		expect(pendingItem?.properties).not.toHaveProperty('styria_status');
		expect(pendingItem?.properties).not.toHaveProperty('tracking_number');

		const withdrawalList = tools.find((tool) => tool.name === 'list_withdrawal_cases');
		expect(withdrawalList?.inputSchema).toMatchObject({
			type: 'object',
			additionalProperties: false,
			properties: { status: expect.any(Object), limit: expect.any(Object) }
		});
		const withdrawalListItem = (
			withdrawalList?.outputSchema?.properties as {
				cases?: {
					items?: { additionalProperties?: boolean; properties?: Record<string, unknown> };
				};
			}
		)?.cases?.items;
		expect(withdrawalListItem?.additionalProperties).toBe(false);
		expect(Object.keys(withdrawalListItem?.properties ?? {})).toEqual([
			'reference',
			'status',
			'scope',
			'eligibility',
			'outcome_code',
			'created_at',
			'updated_at',
			'closed_at',
			'purged_at'
		]);

		const withdrawalInspection = tools.find((tool) => tool.name === 'inspect_withdrawal_case');
		expect(withdrawalInspection?.inputSchema).toMatchObject({
			type: 'object',
			additionalProperties: false,
			required: ['reference'],
			properties: { reference: expect.any(Object) }
		});
		expect(withdrawalInspection?.outputSchema?.properties).toMatchObject({
			reference: expect.any(Object),
			customer: expect.any(Object),
			events: expect.any(Object),
			messages: expect.any(Object),
			error: expect.any(Object)
		});

		for (const name of [
			'begin_withdrawal_review',
			'record_withdrawal_eligibility',
			'record_withdrawal_return',
			'close_withdrawal_case',
			'resend_withdrawal_message'
		]) {
			const tool = tools.find((entry) => entry.name === name);
			expect(tool?.inputSchema).toMatchObject({
				type: 'object',
				additionalProperties: false,
				properties: { reference: expect.any(Object) }
			});
			expect(tool?.outputSchema?.properties).toHaveProperty('error');
		}
	});

	it.each([
		['list_pending_orders', { limit: 0 }],
		['list_pending_orders', { limit: 101 }],
		['list_pending_orders', { limit: 1.5 }],
		['list_withdrawal_cases', { limit: 0 }],
		['list_withdrawal_cases', { limit: 101 }],
		['list_withdrawal_cases', { limit: 1.5 }],
		['list_withdrawal_cases', { status: 'unknown' }],
		['list_withdrawal_cases', { extra: true }],
		['inspect_withdrawal_case', { reference: '' }],
		['inspect_withdrawal_case', { reference: ' WDR-AAAAAAAAAAAAAAAAAAAAAA' }],
		['inspect_withdrawal_case', { reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA', extra: true }],
		[
			'begin_withdrawal_review',
			{ reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA', expected_status: 'submitted' }
		],
		[
			'begin_withdrawal_review',
			{
				reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				expected_status: 'submitted',
				expected_revision: 0
			}
		],
		[
			'begin_withdrawal_review',
			{
				reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				expected_status: 'reviewing',
				expected_revision: 1
			}
		],
		[
			'record_withdrawal_eligibility',
			{
				reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				expected_status: 'reviewing',
				expected_revision: 1.5,
				decision: 'support_handling',
				internal_order_reference: 'internal-order-42',
				country_code: 'SE'
			}
		],
		[
			'record_withdrawal_eligibility',
			{
				reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				expected_status: 'reviewing',
				expected_revision: 2,
				decision: 'voluntary_non_eu',
				internal_order_reference: 'internal-order-42',
				country_code: 'US'
			}
		],
		[
			'record_withdrawal_return',
			{
				reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				expected_status: 'reviewing',
				expected_revision: 3,
				outcome: 'parcel_received'
			}
		],
		[
			'record_withdrawal_return',
			{
				reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				expected_status: 'awaiting_return',
				expected_revision: -1,
				outcome: 'parcel_received'
			}
		],
		[
			'close_withdrawal_case',
			{
				reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				expected_status: 'closed',
				expected_revision: 4,
				outcome_code: 'eligible_return_received'
			}
		],
		[
			'resend_withdrawal_message',
			{
				reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				source_message_id: 0,
				mode: 'preview'
			}
		],
		[
			'resend_withdrawal_message',
			{
				reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				source_message_id: 1,
				mode: 'confirm',
				preview_token: 'v1.preview-token',
				idempotency_key: 'not-a-uuid'
			}
		],
		['inspect_order', { order_id: '' }],
		['inspect_order', { order_id: ' order_2042' }],
		['inspect_order', { order_id: 'order_2042', include_shipping_details: 'yes' }],
		['prepare_styria_submission', {}],
		['submit_styria_order', { order_id: 'order_2042' }],
		['reconcile_styria_order', { order_id: 'order_2042', extra: true }],
		['check_fulfillment_status', { order_id: 'order_2042\n' }],
		['record_return_or_replacement', { order_id: 'order_2042', outcome: 'refunded_in_stripe' }],
		[
			'record_return_or_replacement',
			{ order_id: 'order_2042', outcome: 'return_approved', note: 'x'.repeat(161) }
		]
	])('rejects invalid Valibot input for %s before calling services', async (name, args) => {
		const fixture = setup();
		const result = await callTool(fixture.server, name, args as Record<string, unknown>);

		expect(result).toEqual({
			isError: true,
			content: [
				{
					type: 'text',
					text: JSON.stringify({ error: { code: 'INVALID_TOOL_ARGUMENTS' } })
				}
			],
			structuredContent: { error: { code: 'INVALID_TOOL_ARGUMENTS' } }
		});
		const serialized = JSON.stringify(result);
		for (const rejected of Object.values(args as Record<string, unknown>)) {
			if (typeof rejected === 'string' && rejected.length > 2) {
				expect(serialized).not.toContain(rejected);
			}
		}
		for (const service of Object.values(fixture.services)) {
			for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
		}
	});

	it('returns a stable review-required error when send expectations are omitted', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'resend_shipping_email', {
			order_id: 'order_2042',
			mode: 'send'
		});

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			error: { code: 'SHIPPING_EMAIL_REVIEW_REQUIRED' }
		});
		expect(fixture.services.shipping.getTarget).not.toHaveBeenCalled();
		expect(fixture.services.shipping.send).not.toHaveBeenCalled();
	});

	it('returns oldest pending orders first without customer contact or provider identifiers', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'list_pending_orders', {});

		expectMirrored(result);
		expect(result.structuredContent).toEqual({
			orders: [
				{
					order_id: 'order_oldest',
					payment_status: 'paid',
					fulfillment_status: 'pending_review',
					currency: 'eur',
					total_amount: 6_998,
					destination_country: 'SE',
					updated_at: '2026-07-17T09:10:00.000Z',
					last_error_code: null
				},
				expect.objectContaining({ order_id: 'order_newer' })
			]
		});
		expect(fixture.services.fulfillment.listPending).toHaveBeenCalledWith(50);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('checkoutSessionId');
		expect(serialized).not.toContain('cs_order');
		expect(serialized).not.toContain('email');
		expect(serialized).not.toContain('phone');
		expect(serialized).not.toContain('address');
		expect(serialized).not.toContain('styria-private');
		expect(serialized).not.toContain('provider-private');
		expect(serialized).not.toContain('tracking-private');
	});

	it('lists withdrawal cases newest first with default limit and no PII or decryption', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'list_withdrawal_cases', {});

		expectMirrored(result);
		expect(fixture.services.withdrawals.listCases).toHaveBeenCalledWith({ limit: 50 });
		expect(fixture.services.withdrawals.inspectCase).not.toHaveBeenCalled();
		expect(result.structuredContent).toEqual({
			cases: [
				{
					reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
					status: 'reviewing',
					scope: 'specific_items',
					eligibility: 'eligible_eu',
					outcome_code: 'RETURN_LABEL_SENT',
					created_at: '2026-07-17T09:30:00.000Z',
					updated_at: '2026-07-17T09:45:00.000Z',
					closed_at: null,
					purged_at: null
				},
				expect.objectContaining({ reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA' })
			]
		});
		const serialized = JSON.stringify(result);
		for (const forbidden of [
			'"fullName"',
			'"receiptEmail"',
			'"enteredOrderReference"',
			'"items"',
			'Private Withdrawal Customer',
			'withdrawal.private@example.test',
			'PRIVATE-ORDER-WDR-42',
			'Private orange hoodie',
			'case_private',
			'encryptedPayload'
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it.each([
		'submitted',
		'reviewing',
		'awaiting_return',
		'ineligible',
		'support_handling',
		'closed'
	] as WithdrawalStatus[])(
		'passes the %s withdrawal status filter with an explicit limit',
		async (status) => {
			const fixture = setup();

			await callTool(fixture.server, 'list_withdrawal_cases', { status, limit: 17 });

			expect(fixture.services.withdrawals.listCases).toHaveBeenCalledWith({ status, limit: 17 });
		}
	);

	it('inspects one active withdrawal with decrypted customer data and PII-free history', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'inspect_withdrawal_case', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB'
		});

		expectMirrored(result);
		expect(fixture.services.withdrawals.inspectCase).toHaveBeenCalledWith(
			'WDR-BBBBBBBBBBBBBBBBBBBBBB'
		);
		expect(result.structuredContent).toMatchObject({
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			status: 'reviewing',
			revision: 2,
			customer: {
				full_name: 'Private Withdrawal Customer',
				receipt_email: 'withdrawal.private@example.test',
				entered_order_reference: 'PRIVATE-ORDER-WDR-42',
				items: [{ description: 'Private orange hoodie', quantity: 2 }]
			},
			events: [
				{
					actor: 'codex-admin',
					action: 'review_started',
					prior_status: 'submitted',
					next_status: 'reviewing',
					result_code: 'REVIEW_STARTED',
					created_at: '2026-07-17T09:35:00.000Z'
				}
			],
			messages: [
				{
					kind: 'receipt',
					attempt_count: 1,
					next_attempt_at: '2026-07-17T09:31:00.000Z',
					provider_delivery_id: 'delivery_2042',
					completed_at: '2026-07-17T09:31:00.000Z',
					last_error_code: null
				}
			]
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('case_private_newer');
		expect(serialized).not.toContain('idempotency');
	});

	it('begins withdrawal review with the expected state and revision', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'begin_withdrawal_review', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			expected_status: 'submitted',
			expected_revision: 1
		});

		expectMirrored(result);
		expect(result.structuredContent).toEqual({
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			status: 'reviewing',
			revision: 2
		});
		expect(fixture.services.withdrawalWorkflow.beginReview).toHaveBeenCalledWith({
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			expectedStatus: 'submitted',
			expectedRevision: 1
		});
	});

	it('records eligible EU review with normalized country and required instructions', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'record_withdrawal_eligibility', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			expected_status: 'reviewing',
			expected_revision: 2,
			decision: 'eligible_eu',
			internal_order_reference: 'internal-order-42',
			country_code: ' se ',
			customer_instructions: 'Use the reviewed return address.'
		});

		expectMirrored(result);
		expect(result.structuredContent).toEqual({
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			status: 'awaiting_return',
			revision: 3
		});
		expect(fixture.services.withdrawalWorkflow.recordEligibility).toHaveBeenCalledWith({
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			expectedStatus: 'reviewing',
			expectedRevision: 2,
			decision: 'eligible_eu',
			internalOrderReference: 'internal-order-42',
			countryCode: 'SE',
			customerInstructions: 'Use the reviewed return address.'
		});
	});

	it.each([
		[
			'eligible without instructions',
			{
				decision: 'eligible_eu',
				country_code: 'SE'
			}
		],
		[
			'non-EU with instructions',
			{
				decision: 'ineligible_non_eu',
				country_code: 'US',
				customer_instructions: 'Unexpected instructions'
			}
		],
		[
			'support with instructions',
			{
				decision: 'support_handling',
				country_code: 'SE',
				customer_instructions: 'Unexpected instructions'
			}
		]
	])('rejects conditional eligibility input: %s', async (_label, conditional) => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'record_withdrawal_eligibility', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			expected_status: 'reviewing',
			expected_revision: 2,
			internal_order_reference: 'internal-order-42',
			...conditional
		});

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'WITHDRAWAL_ELIGIBILITY_INVALID' } }
		});
		expect(fixture.services.withdrawalWorkflow.recordEligibility).not.toHaveBeenCalled();
	});

	it.each([
		['ineligible_non_eu', 'US', 'ineligible'],
		['support_handling', 'SE', 'support_handling']
	] as const)(
		'records %s without a voluntary non-EU path',
		async (decision, countryCode, status) => {
			const fixture = setup();
			const result = await callTool(fixture.server, 'record_withdrawal_eligibility', {
				reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
				expected_status: 'reviewing',
				expected_revision: 2,
				decision,
				internal_order_reference: 'internal-order-42',
				country_code: countryCode
			});

			expectMirrored(result);
			expect(result.structuredContent).toEqual({
				reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
				status,
				revision: 3
			});
			expect(fixture.services.withdrawalWorkflow.recordEligibility).toHaveBeenCalledWith({
				reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
				expectedStatus: 'reviewing',
				expectedRevision: 2,
				decision,
				internalOrderReference: 'internal-order-42',
				countryCode,
				customerInstructions: undefined
			});
			for (const provider of [
				fixture.services.stripe,
				fixture.services.preparation,
				fixture.services.submission,
				fixture.services.reconciliation,
				fixture.services.status,
				fixture.services.shipping
			]) {
				for (const method of Object.values(provider)) expect(method).not.toHaveBeenCalled();
			}
		}
	);

	it('retains the exact ineligible and support-handoff customer copy', () => {
		expect(WITHDRAWAL_LEGAL_STATUS_COPY.ineligible_decision).toBe(
			'This order is not eligible for a change-of-mind return. Damaged or incorrect-item support remains available at merch@sveltesociety.dev.'
		);
		expect(WITHDRAWAL_LEGAL_STATUS_COPY.support_handoff).toBe(
			'We will handle this request through damaged or incorrect-item support. Support remains available at merch@sveltesociety.dev.'
		);
		expect(WITHDRAWAL_LEGAL_STATUS_COPY.eligible_instructions).toContain(
			"Do not send the parcel to the seller's registered address unless the instructions say so."
		);
	});

	it('maps reviewed return and close actions to the workflow service', async () => {
		const fixture = setup();
		const recorded = await callTool(fixture.server, 'record_withdrawal_return', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			expected_status: 'awaiting_return',
			expected_revision: 3,
			outcome: 'parcel_received',
			parcel_reference: 'parcel-42'
		});
		const closed = await callTool(fixture.server, 'close_withdrawal_case', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			expected_status: 'awaiting_return',
			expected_revision: 4,
			outcome_code: 'eligible_return_received'
		});

		expectMirrored(recorded);
		expectMirrored(closed);
		expect(recorded.structuredContent).toMatchObject({
			status: 'awaiting_return',
			revision: 4
		});
		expect(closed.structuredContent).toMatchObject({ status: 'closed', revision: 5 });
		expect(fixture.services.withdrawalWorkflow.recordReturn).toHaveBeenCalledWith({
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			expectedStatus: 'awaiting_return',
			expectedRevision: 3,
			outcome: 'parcel_received',
			parcelReference: 'parcel-42'
		});
		expect(fixture.services.withdrawalWorkflow.closeCase).toHaveBeenCalledWith({
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			expectedStatus: 'awaiting_return',
			expectedRevision: 4,
			outcomeCode: 'eligible_return_received'
		});
	});

	it('returns the current safe status and revision for a workflow conflict', async () => {
		const fixture = setup();
		fixture.services.withdrawalWorkflow.beginReview.mockImplementationOnce(() => {
			throw Object.assign(new Error('private stale detail'), {
				code: 'WITHDRAWAL_CASE_CONFLICT',
				currentStatus: 'reviewing',
				currentRevision: 2
			});
		});

		const result = await callTool(fixture.server, 'begin_withdrawal_review', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			expected_status: 'submitted',
			expected_revision: 1
		});

		expect(result).toEqual({
			isError: true,
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						error: { code: 'WITHDRAWAL_CASE_CONFLICT' },
						current_status: 'reviewing',
						current_revision: 2
					})
				}
			],
			structuredContent: {
				error: { code: 'WITHDRAWAL_CASE_CONFLICT' },
				current_status: 'reviewing',
				current_revision: 2
			}
		});
		expect(JSON.stringify(result)).not.toContain('private stale detail');
	});

	it('returns only a stable fallback for a private workflow failure', async () => {
		const fixture = setup();
		fixture.services.withdrawalWorkflow.closeCase.mockImplementationOnce(() => {
			throw new Error('private database path /data/shop.sqlite');
		});

		const result = await callTool(fixture.server, 'close_withdrawal_case', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			expected_status: 'ineligible',
			expected_revision: 3,
			outcome_code: 'ineligible_non_eu'
		});

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'WITHDRAWAL_CLOSE_ACTION_FAILED' } }
		});
		expect(JSON.stringify(result)).not.toContain('database path');
		expect(JSON.stringify(result)).not.toContain('/data/shop.sqlite');
	});

	it('returns a read-like withdrawal resend preview without queueing', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'resend_withdrawal_message', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			source_message_id: 1,
			mode: 'preview'
		});

		expectMirrored(result);
		expect(result.structuredContent).toEqual({
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			source_message_id: 1,
			mode: 'preview',
			destination: 'withdrawal.private@example.test',
			subject: 'Withdrawal return instructions — WDR-BBBBBBBBBBBBBBBBBBBBBB',
			text_body: 'Private exact preview body',
			preview_token: 'v1.preview-token',
			expires_at: '2026-07-17T10:10:00.000Z',
			queued: false
		});
		expect(fixture.services.withdrawalWorkflow.resendMessage).toHaveBeenCalledWith({
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			sourceMessageId: 1,
			mode: 'preview',
			previewToken: undefined,
			idempotencyKey: undefined
		});
	});

	it('rejects withdrawal resend confirm without both reviewed fields', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'resend_withdrawal_message', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			source_message_id: 1,
			mode: 'confirm'
		});

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'WITHDRAWAL_MESSAGE_PREVIEW_REQUIRED' } }
		});
		expect(fixture.services.withdrawalWorkflow.resendMessage).not.toHaveBeenCalled();
	});

	it('queues withdrawal resend confirm without echoing preview content', async () => {
		const fixture = setup();
		fixture.services.withdrawalWorkflow.resendMessage.mockImplementationOnce((input) => ({
			mode: 'confirm',
			reference: input.reference,
			sourceMessageId: input.sourceMessageId,
			messageId: 17,
			queued: true
		}));
		const result = await callTool(fixture.server, 'resend_withdrawal_message', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			source_message_id: 1,
			mode: 'confirm',
			preview_token: 'v1.preview-token',
			idempotency_key: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1'
		});

		expectMirrored(result);
		expect(result.structuredContent).toEqual({
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			source_message_id: 1,
			mode: 'confirm',
			message_id: 17,
			queued: true
		});
		expect(JSON.stringify(result)).not.toContain('withdrawal.private@example.test');
		expect(JSON.stringify(result)).not.toContain('Private exact preview body');
		expect(JSON.stringify(result)).not.toContain('v1.preview-token');
		expect(fixture.services.withdrawalWorkflow.resendMessage).toHaveBeenCalledWith({
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			sourceMessageId: 1,
			mode: 'confirm',
			previewToken: 'v1.preview-token',
			idempotencyKey: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1'
		});
	});

	it.each([
		['WITHDRAWAL_CASE_NOT_FOUND', 'WITHDRAWAL_CASE_NOT_FOUND'],
		['WITHDRAWAL_PII_PURGED', 'WITHDRAWAL_PII_PURGED'],
		['WITHDRAWAL_DECRYPT_FAILED', 'WITHDRAWAL_DECRYPT_FAILED'],
		['private database failure', 'WITHDRAWAL_CASE_INSPECTION_FAILED']
	])('returns only stable inspection error %s', async (failure, expected) => {
		const fixture = setup();
		fixture.services.withdrawals.inspectCase.mockImplementationOnce(() => {
			throw Object.assign(new Error(`private detail: ${failure}`), {
				code: /^[A-Z][A-Z0-9_]+$/u.test(failure) ? failure : undefined
			});
		});

		const result = await callTool(fixture.server, 'inspect_withdrawal_case', {
			reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB'
		});

		expect(result).toEqual({
			isError: true,
			content: [{ type: 'text', text: JSON.stringify({ error: { code: expected } }) }],
			structuredContent: { error: { code: expected } }
		});
		expect(JSON.stringify(result)).not.toContain('private detail');
	});

	it('inspects local summaries without retrieving or returning contact data by default', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'inspect_order', { order_id: 'order_2042' });

		expectMirrored(result);
		expect(result.structuredContent).toMatchObject({
			order_id: 'order_2042',
			payment: {
				status: 'paid',
				currency: 'eur',
				amounts: { subtotal: 5_598, discount: 0, shipping: 0, tax: 1_400, total: 6_998 }
			},
			fulfillment: { status: 'pending_review' },
			lines: [{ product_name: 'Community Tee', quantity: 2 }],
			support: [
				{
					outcome: 'return_approved',
					note: 'Reviewed in support mailbox',
					external_reference: 'ticket-2042'
				}
			]
		});
		expect(fixture.services.stripe.retrieveFulfillmentDetails).not.toHaveBeenCalled();
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('ada@example.test');
		expect(serialized).not.toContain('Currentgatan');
		expect(serialized).not.toContain('+46 70');
	});

	it('retrieves shipping details only when explicitly requested for an order under review', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'inspect_order', {
			order_id: 'order_2042',
			include_shipping_details: true
		});

		expectMirrored(result);
		expect(fixture.services.stripe.retrieveFulfillmentDetails).toHaveBeenCalledOnce();
		expect(fixture.services.stripe.retrieveFulfillmentDetails).toHaveBeenCalledWith('cs_test_2042');
		expect(result.structuredContent?.shipping_details).toEqual(shippingFixture());
	});

	it('does not retrieve shipping details for an order that no longer needs review', async () => {
		const fixture = setup({ inspected: orderFixture({ fulfillmentStatus: 'shipped' }) });
		const result = await callTool(fixture.server, 'inspect_order', {
			order_id: 'order_2042',
			include_shipping_details: true
		});

		expectMirrored(result);
		expect(fixture.services.stripe.retrieveFulfillmentDetails).not.toHaveBeenCalled();
		expect(result.structuredContent).not.toHaveProperty('shipping_details');
	});

	it('wraps preparation, submission, reconciliation, and status services with mirrored results', async () => {
		const fixture = setup();
		const calls = [
			await callTool(fixture.server, 'prepare_styria_submission', { order_id: 'order_2042' }),
			await callTool(fixture.server, 'submit_styria_order', {
				order_id: 'order_2042',
				approval_id: 'approval-2042'
			}),
			await callTool(fixture.server, 'reconcile_styria_order', { order_id: 'order_2042' }),
			await callTool(fixture.server, 'check_fulfillment_status', { order_id: 'order_2042' })
		];

		for (const result of calls) expectMirrored(result);
		expect(JSON.stringify(calls[3])).not.toContain('status-private@example.test');
		expect(fixture.services.preparation.prepare).toHaveBeenCalledWith('order_2042');
		expect(fixture.services.submission.submit).toHaveBeenCalledWith({
			orderId: 'order_2042',
			approvalId: 'approval-2042'
		});
		expect(fixture.services.reconciliation.reconcile).toHaveBeenCalledWith('order_2042');
		expect(fixture.services.status.check).toHaveBeenCalledWith('order_2042');
	});

	it('returns only a stable code for a domain/provider failure', async () => {
		const fixture = setup();
		fixture.services.status.check.mockRejectedValueOnce(
			Object.assign(new Error('raw provider body ada@example.test'), {
				code: 'STYRIA_UNAVAILABLE',
				stack: 'secret-stack'
			})
		);

		const result = await callTool(fixture.server, 'check_fulfillment_status', {
			order_id: 'order_2042'
		});

		expect(result).toEqual({
			isError: true,
			content: [
				{
					type: 'text',
					text: JSON.stringify({ error: { code: 'STYRIA_UNAVAILABLE' } })
				}
			],
			structuredContent: { error: { code: 'STYRIA_UNAVAILABLE' } }
		});
		expect(JSON.stringify(result)).not.toContain('provider body');
		expect(JSON.stringify(result)).not.toContain('ada@example.test');
		expect(JSON.stringify(result)).not.toContain('secret-stack');
	});

	it('previews shipping by default without sending', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'resend_shipping_email', {
			order_id: 'order_2042'
		});

		expectMirrored(result);
		expect(result.structuredContent).toEqual({
			order_id: 'order_2042',
			mode: 'preview',
			email: 'ada@example.test',
			tracking_number: 'TRACK-2042',
			sent: false
		});
		expect(fixture.services.shipping.getTarget).toHaveBeenCalledWith('order_2042');
		expect(fixture.services.shipping.send).not.toHaveBeenCalled();
	});

	it('refuses to send when reviewed email or tracking does not exactly match', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'resend_shipping_email', {
			order_id: 'order_2042',
			mode: 'send',
			expected_email: 'other@example.test',
			expected_tracking_number: 'TRACK-2042'
		});

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			error: { code: 'SHIPPING_EMAIL_REVIEW_MISMATCH' }
		});
		expect(fixture.services.shipping.send).not.toHaveBeenCalled();
	});

	it('sends only after exact reviewed email and tracking matches', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'resend_shipping_email', {
			order_id: 'order_2042',
			mode: 'send',
			expected_email: 'ada@example.test',
			expected_tracking_number: 'TRACK-2042'
		});

		expectMirrored(result);
		expect(fixture.services.shipping.send).toHaveBeenCalledWith({
			orderId: 'order_2042',
			expectedEmail: 'ada@example.test',
			expectedTrackingNumber: 'TRACK-2042'
		});
	});

	it.each([
		['line break', { note: 'Approved\nsee mailbox' }],
		['email', { note: 'Contact ada@example.test' }],
		['phone', { note: 'Call +46 70 123 45 67' }],
		['address', { note: 'Send to Currentgatan 9' }],
		['abbreviated street', { note: '123 Main St' }],
		['abbreviated road', { note: '10 Downing Rd' }],
		['PO box', { note: 'PO Box 123' }],
		['external reference PII', { external_reference: 'ada@example.test' }],
		['external reference too long', { external_reference: 'x'.repeat(121) }]
	])('rejects support %s before writing', async (_label, unsafe) => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'record_return_or_replacement', {
			order_id: 'order_2042',
			outcome: 'return_approved',
			...unsafe
		});

		expect(result).toEqual({
			isError: true,
			content: [
				{
					type: 'text',
					text: JSON.stringify({ error: { code: 'INVALID_TOOL_ARGUMENTS' } })
				}
			],
			structuredContent: { error: { code: 'INVALID_TOOL_ARGUMENTS' } }
		});
		expect(JSON.stringify(result)).not.toContain(
			Object.values(unsafe).find((value) => typeof value === 'string') as string
		);
		expect(fixture.services.fulfillment.recordSupportNote).not.toHaveBeenCalled();
	});

	it('records only the reviewed support outcome/reference with the repository-owned actor', async () => {
		const fixture = setup();
		const result = await callTool(fixture.server, 'record_return_or_replacement', {
			order_id: 'order_2042',
			outcome: 'replacement_ordered',
			note: 'Replacement approved in support mailbox',
			external_reference: 'ticket-2042'
		});

		expectMirrored(result);
		expect(fixture.services.fulfillment.recordSupportNote).toHaveBeenCalledWith({
			orderId: 'order_2042',
			outcome: 'replacement_ordered',
			note: 'Replacement approved in support mailbox',
			externalReference: 'ticket-2042',
			createdAt: now
		});
		expect(result.structuredContent).toEqual({
			order_id: 'order_2042',
			outcome: 'replacement_ordered',
			note: 'Replacement approved in support mailbox',
			external_reference: 'ticket-2042',
			recorded: true
		});
		expect(fixture.services.preparation.prepare).not.toHaveBeenCalled();
		expect(fixture.services.submission.submit).not.toHaveBeenCalled();
		expect(fixture.services.reconciliation.reconcile).not.toHaveBeenCalled();
		expect(fixture.services.status.check).not.toHaveBeenCalled();
		expect(fixture.services.shipping.send).not.toHaveBeenCalled();
	});
});
