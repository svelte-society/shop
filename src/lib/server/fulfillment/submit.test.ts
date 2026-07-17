import { describe, expect, it, vi } from 'vitest';
import type { OrderEvent, OrderWithLines } from '$lib/domain/orders';
import { RepositoryError } from '$lib/domain/orders';
import type { FulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import {
	createStripeFulfillmentGateway,
	type StripeFulfillmentClient
} from '$lib/server/stripe/client.server';
import type { FulfillmentDetails, StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import { StyriaError, type StyriaGateway } from '$lib/server/styria/gateway';
import { buildStyriaPayload, hashStyriaPayload } from '$lib/server/styria/payload';
import type { StyriaOrder, StyriaOrderPayload } from '$lib/server/styria/types';
import type { AlertService } from '$lib/server/monitoring/alerts.server';
import {
	FulfillmentSubmissionService,
	RECONCILIATION_INSTRUCTION,
	type SubmissionDependencies
} from './submit.server';

const now = new Date('2026-07-17T10:00:00.000Z');
const paidAt = new Date('2026-07-17T09:30:00.000Z');
const brandName = 'Svelte Society';
const comment = 'Approved Svelte Society fulfillment';

function paidEvent(): OrderEvent {
	return {
		id: 1,
		orderId: 'order_submit',
		actor: 'stripe-webhook',
		action: 'paid_order_recorded',
		priorState: null,
		nextState: 'pending_review',
		result: 'succeeded',
		errorCode: null,
		createdAt: paidAt
	};
}

function orderFixture(): OrderWithLines {
	return {
		id: 'order_submit',
		checkoutSessionId: 'cs_test_submit',
		paymentIntentId: 'pi_test_submit',
		customerId: 'cus_test_submit',
		checkoutDraftId: 'draft_submit',
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
		updatedAt: paidAt,
		lastErrorCode: null,
		lines: [
			{
				orderId: 'order_submit',
				lineIndex: 0,
				stripeProductId: 'prod_community_tee',
				stripePriceId: 'price_community_tee_m',
				productName: 'Community Tee',
				variantLabel: 'M',
				sku: 'SS-TEE-M',
				styriaProductNumber: 'STYRIA-TEE-M',
				designReference: 'society-community-v1',
				designPlacements: {
					back: 'https://cdn.example.test/designs/community-back.svg',
					front: 'https://cdn.example.test/designs/community-front.svg'
				},
				quantity: 2,
				unitAmount: 2_799,
				currency: 'eur'
			}
		]
	};
}

function fulfillmentFixture(): FulfillmentDetails {
	return {
		recipient: {
			firstName: 'Ada',
			lastName: 'Lovelace',
			company: 'Analytical Engines AB',
			phone: '+46 70 123 45 67'
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
}

function payloadFor(order = orderFixture(), details = fulfillmentFixture()): StyriaOrderPayload {
	return buildStyriaPayload({
		order,
		fulfillment: { recipient: details.recipient, address: details.address },
		brandName,
		comment
	});
}

function remoteOrder(
	overrides: Partial<StyriaOrder> = {},
	payload: StyriaOrderPayload = payloadFor()
): StyriaOrder {
	return {
		id: 'styria-1042',
		external_id: payload.external_id,
		created_at: now.toISOString(),
		status: 'received',
		deleted: false,
		shipping_address: { country: payload.shipping_address.country },
		shipping: { shippingMethod: 'courier', trackingNumber: null, shiped_at: null },
		items: structuredClone(payload.items),
		...overrides
	};
}

type Inspected = NonNullable<ReturnType<FulfillmentRepository['inspect']>>;

class MemoryFulfillment {
	readonly calls: string[] = [];
	readonly events: OrderEvent[] = [paidEvent()];
	approvalUsed = false;
	beginError: string | null = null;
	recordFailures = 0;
	reviewFailures = 0;
	lastErrorCode: string | null = null;
	transactionOpen = false;

	constructor(
		readonly order: OrderWithLines = orderFixture(),
		readonly approvedHash: string = hashStyriaPayload(payloadFor())
	) {}

	inspect(orderId: string): Inspected | null {
		this.calls.push('inspect');
		if (orderId !== this.order.id) return null;
		return {
			...structuredClone(this.order),
			events: structuredClone(this.events),
			supportNotes: []
		};
	}

	beginSubmission(orderId: string, approvalId: string, payloadHash: string, at: Date): void {
		this.calls.push('beginSubmission');
		this.transactionOpen = true;
		try {
			if (this.beginError) throw new RepositoryError(this.beginError);
			if (orderId !== this.order.id || approvalId === 'approval_wrong') {
				throw new RepositoryError('SUBMISSION_APPROVAL_ORDER_MISMATCH');
			}
			if (approvalId === 'approval_expired') {
				throw new RepositoryError('SUBMISSION_APPROVAL_EXPIRED');
			}
			if (this.approvalUsed) throw new RepositoryError('SUBMISSION_APPROVAL_USED');
			if (payloadHash !== this.approvedHash) {
				throw new RepositoryError('SUBMISSION_APPROVAL_HASH_MISMATCH');
			}
			this.approvalUsed = true;
			this.order.fulfillmentStatus = 'submitting';
			this.order.updatedAt = new Date(at);
		} finally {
			this.transactionOpen = false;
		}
	}

	recordSubmitted(orderId: string, styriaOrderId: string, status: string, at: Date): void {
		this.calls.push('recordSubmitted');
		if (this.recordFailures-- > 0) throw new RepositoryError('STYRIA_SUBMISSION_RECORD_FAILED');
		if (orderId !== this.order.id) throw new RepositoryError('ORDER_NOT_FOUND');
		this.order.fulfillmentStatus = 'awaiting_vendor_payment';
		this.order.styriaOrderId = styriaOrderId;
		this.order.styriaStatus = status;
		this.order.submittedAt = new Date(at);
		this.order.updatedAt = new Date(at);
		this.order.lastErrorCode = null;
	}

	requireReview(orderId: string, errorCode: string, at: Date): void {
		this.calls.push('requireReview');
		if (this.reviewFailures-- > 0) throw new RepositoryError('FULFILLMENT_REVIEW_FAILED');
		if (orderId !== this.order.id) throw new RepositoryError('ORDER_NOT_FOUND');
		this.order.fulfillmentStatus = 'review_required';
		this.order.updatedAt = new Date(at);
		this.order.lastErrorCode = errorCode;
		this.lastErrorCode = errorCode;
	}
}

class CurrentStripe implements StripeFulfillmentGateway {
	readonly calls: string[] = [];

	constructor(readonly details = fulfillmentFixture()) {}

	async retrieveFulfillmentDetails(checkoutSessionId: string): Promise<FulfillmentDetails> {
		this.calls.push(checkoutSessionId);
		return structuredClone(this.details);
	}
}

class FakeStyria implements StyriaGateway {
	readonly calls: string[] = [];
	readonly createPayloads: StyriaOrderPayload[] = [];
	searchMatches: StyriaOrder[] = [];
	searchError: unknown = null;
	createError: unknown = null;
	createResult: StyriaOrder = remoteOrder();
	assertNoTransaction: (() => boolean) | null = null;

	async searchByExternalId(externalId: string, createdAfter: Date): Promise<StyriaOrder[]> {
		this.calls.push(`search:${externalId}:${createdAfter.toISOString()}`);
		if (this.assertNoTransaction?.()) throw new Error('network called inside transaction');
		if (this.searchError) throw this.searchError;
		return structuredClone(this.searchMatches);
	}

	async create(payload: StyriaOrderPayload): Promise<StyriaOrder> {
		this.calls.push('create');
		if (this.assertNoTransaction?.()) throw new Error('network called inside transaction');
		this.createPayloads.push(structuredClone(payload));
		if (this.createError) throw this.createError;
		return structuredClone(this.createResult);
	}

	async get(): Promise<StyriaOrder> {
		throw new Error('not used');
	}
}

function setup(
	overrides: {
		order?: OrderWithLines;
		details?: FulfillmentDetails;
		approvedHash?: string;
		fulfillment?: MemoryFulfillment;
		stripe?: StripeFulfillmentGateway;
		styria?: FakeStyria;
		alerts?: AlertService;
	} = {}
): {
	service: FulfillmentSubmissionService;
	fulfillment: MemoryFulfillment;
	stripe: StripeFulfillmentGateway;
	styria: FakeStyria;
} {
	const fulfillment =
		overrides.fulfillment ??
		new MemoryFulfillment(overrides.order ?? orderFixture(), overrides.approvedHash);
	const stripe = overrides.stripe ?? new CurrentStripe(overrides.details);
	const styria = overrides.styria ?? new FakeStyria();
	styria.assertNoTransaction = () => fulfillment.transactionOpen;
	const dependencies: SubmissionDependencies = {
		fulfillment,
		stripe,
		styria,
		brandName,
		comment,
		alerts: overrides.alerts
	};
	return {
		service: new FulfillmentSubmissionService(dependencies),
		fulfillment,
		stripe,
		styria
	};
}

function submit(service: FulfillmentSubmissionService, approvalId = 'approval_valid') {
	return service.submit({ orderId: 'order_submit', approvalId }, now);
}

describe('fulfillment submission approval binding', () => {
	it('invalidates approval after the current Customer company changes while Session snapshot stays stale', async () => {
		const session = {
			id: 'cs_test_submit',
			object: 'checkout.session',
			customer_details: { business_name: 'Analytical Engines AB' },
			customer: {
				id: 'cus_test_submit',
				object: 'customer',
				business_name: 'Analytical Engines AB',
				email: 'ada@example.test',
				shipping: {
					name: 'Ada Lovelace',
					phone: '+46 70 123 45 67',
					address: {
						line1: 'Sveltegatan 5',
						line2: 'Suite 3',
						city: 'Stockholm',
						state: 'Stockholm',
						postal_code: '111 22',
						country: 'SE'
					}
				}
			}
		};
		const calls: string[] = [];
		const client: StripeFulfillmentClient = {
			checkout: {
				sessions: {
					async retrieve(checkoutSessionId) {
						calls.push(checkoutSessionId);
						return structuredClone(session);
					}
				}
			}
		};
		const state = setup({ stripe: createStripeFulfillmentGateway(client) });
		session.customer.business_name = 'Updated Current Company AB';

		await expect(submit(state.service)).rejects.toMatchObject({
			code: 'SUBMISSION_APPROVAL_HASH_MISMATCH'
		});

		expect(session.customer_details.business_name).toBe('Analytical Engines AB');
		expect(calls).toEqual(['cs_test_submit']);
		expect(state.fulfillment.order.fulfillmentStatus).toBe('pending_review');
		expect(state.styria.calls).toEqual([]);
	});

	it.each([
		['expired', 'approval_expired', 'SUBMISSION_APPROVAL_EXPIRED'],
		['wrong order', 'approval_wrong', 'SUBMISSION_APPROVAL_ORDER_MISMATCH']
	])('rejects a %s approval before Styria access', async (_label, approvalId, code) => {
		const state = setup();

		await expect(submit(state.service, approvalId)).rejects.toMatchObject({ code });

		expect(state.fulfillment.order.fulfillmentStatus).toBe('pending_review');
		expect(state.styria.calls).toEqual([]);
	});

	it.each([
		[
			'current Stripe address',
			(order: OrderWithLines, details: FulfillmentDetails) => {
				details.address.line1 = 'Changed address 7';
			}
		],
		[
			'line quantity',
			(order: OrderWithLines) => {
				order.lines[0].quantity = 3;
			}
		],
		[
			'design',
			(order: OrderWithLines) => {
				order.lines[0].designReference = 'society-community-v2';
				order.lines[0].designPlacements.front =
					'https://cdn.example.test/designs/community-front-v2.svg';
			}
		],
		[
			'price',
			(order: OrderWithLines) => {
				order.lines[0].unitAmount = 2_899;
			}
		]
	] as const)('invalidates approval after a changed %s', async (_label, mutate) => {
		const order = orderFixture();
		const details = fulfillmentFixture();
		mutate(order, details);
		const state = setup({
			order,
			details,
			approvedHash: hashStyriaPayload(payloadFor())
		});

		await expect(submit(state.service)).rejects.toMatchObject({
			code: 'SUBMISSION_APPROVAL_HASH_MISMATCH'
		});

		expect(state.fulfillment.order.fulfillmentStatus).toBe('pending_review');
		expect(state.styria.calls).toEqual([]);
	});
});

describe('fulfillment submission provider sequence', () => {
	it('records one consistent preflight match without creating', async () => {
		const state = setup();
		state.styria.searchMatches = [remoteOrder()];

		await expect(submit(state.service)).resolves.toEqual({
			orderId: 'order_submit',
			styriaOrderId: 'styria-1042',
			fulfillmentStatus: 'awaiting_vendor_payment',
			manualPaymentRequired: true
		});

		expect(state.fulfillment.calls).toEqual(['inspect', 'beginSubmission', 'recordSubmitted']);
		expect(state.styria.calls).toEqual([`search:cs_test_submit:${paidAt.toISOString()}`]);
		expect(state.styria.createPayloads).toEqual([]);
	});

	it('searches first, creates exactly once, validates success, and records manual payment wait', async () => {
		const state = setup();

		await expect(submit(state.service)).resolves.toEqual({
			orderId: 'order_submit',
			styriaOrderId: 'styria-1042',
			fulfillmentStatus: 'awaiting_vendor_payment',
			manualPaymentRequired: true
		});

		expect(state.styria.calls).toEqual([`search:cs_test_submit:${paidAt.toISOString()}`, 'create']);
		expect(state.styria.createPayloads).toEqual([payloadFor()]);
		expect(state.fulfillment.calls).toEqual(['inspect', 'beginSubmission', 'recordSubmitted']);
		expect(state.fulfillment.order.fulfillmentStatus).toBe('awaiting_vendor_payment');
	});

	it('blocks an inconsistent single preflight match without creating', async () => {
		const state = setup();
		state.styria.searchMatches = [remoteOrder({ shipping_address: { country: 'Austria' } })];

		await expect(submit(state.service)).rejects.toMatchObject({
			code: 'STYRIA_RECONCILIATION_REQUIRED',
			instruction: RECONCILIATION_INSTRUCTION
		});

		expect(state.styria.calls).toHaveLength(1);
		expect(state.fulfillment.order.fulfillmentStatus).toBe('review_required');
		expect(state.fulfillment.lastErrorCode).toBe('STYRIA_CREATE_AMBIGUOUS');
	});

	it('commits deterministic 4xx rejection to review_required', async () => {
		const alerts = { enqueueAlert: vi.fn() };
		const state = setup({ alerts });
		state.styria.createError = new StyriaError('STYRIA_REQUEST_REJECTED');

		await expect(submit(state.service)).rejects.toMatchObject({
			name: 'SubmissionError',
			code: 'STYRIA_REQUEST_REJECTED',
			message: 'STYRIA_REQUEST_REJECTED'
		});

		expect(state.styria.calls.filter((call) => call === 'create')).toHaveLength(1);
		expect(state.fulfillment.order.fulfillmentStatus).toBe('review_required');
		expect(state.fulfillment.lastErrorCode).toBe('STYRIA_REQUEST_REJECTED');
		expect(alerts.enqueueAlert).toHaveBeenCalledWith('STYRIA_REVIEW_REQUIRED', 'order_submit', now);
	});

	it.each([
		['timeout', new StyriaError('STYRIA_TIMEOUT')],
		['connection reset', new Error('ECONNRESET from provider')],
		['malformed 2xx', new StyriaError('STYRIA_RESPONSE_INVALID')]
	])(
		'requires reconciliation after %s, rejects approval replay, and never retries create',
		async (_label, error) => {
			const state = setup();
			state.styria.createError = error;

			await expect(submit(state.service)).rejects.toMatchObject({
				name: 'SubmissionError',
				code: 'STYRIA_RECONCILIATION_REQUIRED',
				message: 'STYRIA_RECONCILIATION_REQUIRED',
				instruction: RECONCILIATION_INSTRUCTION
			});
			await expect(submit(state.service)).rejects.toMatchObject({
				code: 'SUBMISSION_APPROVAL_USED'
			});

			expect(state.styria.calls.filter((call) => call === 'create')).toHaveLength(1);
			expect(state.fulfillment.order.fulfillmentStatus).toBe('review_required');
			expect(state.fulfillment.lastErrorCode).toBe('STYRIA_CREATE_AMBIGUOUS');
		}
	);

	it('treats database failure after confirmed create as ambiguous and review-required', async () => {
		const state = setup();
		state.fulfillment.recordFailures = 1;

		await expect(submit(state.service)).rejects.toMatchObject({
			code: 'STYRIA_RECONCILIATION_REQUIRED',
			instruction: RECONCILIATION_INSTRUCTION
		});

		expect(state.styria.calls.filter((call) => call === 'create')).toHaveLength(1);
		expect(state.fulfillment.calls).toEqual([
			'inspect',
			'beginSubmission',
			'recordSubmitted',
			'requireReview'
		]);
		expect(state.fulfillment.order.fulfillmentStatus).toBe('review_required');
		expect(state.fulfillment.lastErrorCode).toBe('STYRIA_CREATE_AMBIGUOUS');
	});
});
