import { describe, expect, it } from 'vitest';
import type { FulfillmentStatus, OrderEvent, OrderWithLines } from '$lib/domain/orders';
import { RepositoryError } from '$lib/domain/orders';
import type { FulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import { StyriaError, type StyriaGateway } from '$lib/server/styria/gateway';
import type { StyriaOrder, StyriaOrderPayload } from '$lib/server/styria/types';
import { StyriaReconciliationService, type ReconciliationDependencies } from './reconcile.server';

const now = new Date('2026-07-17T11:00:00.000Z');
const paidAt = new Date('2026-07-17T09:30:00.000Z');

function orderFixture(status: FulfillmentStatus = 'review_required'): OrderWithLines {
	return {
		id: 'order_reconcile',
		checkoutSessionId: 'cs_test_reconcile',
		paymentIntentId: 'pi_test_reconcile',
		customerId: 'cus_test_reconcile',
		checkoutDraftId: 'draft_reconcile',
		currency: 'eur',
		amounts: { subtotal: 5_598, discount: 0, shipping: 0, tax: 1_400, total: 6_998 },
		destinationCountry: 'SE',
		paymentStatus: 'paid',
		fulfillmentStatus: status,
		styriaOrderId: null,
		styriaStatus: null,
		trackingNumber: null,
		submittedAt: null,
		shippedAt: null,
		updatedAt: new Date('2026-07-17T10:00:00.000Z'),
		lastErrorCode: 'STYRIA_CREATE_AMBIGUOUS',
		lines: [
			{
				orderId: 'order_reconcile',
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

function paidEvent(): OrderEvent {
	return {
		id: 1,
		orderId: 'order_reconcile',
		actor: 'stripe-webhook',
		action: 'paid_order_recorded',
		priorState: null,
		nextState: 'pending_review',
		result: 'succeeded',
		errorCode: null,
		createdAt: paidAt
	};
}

const expectedItems: StyriaOrderPayload['items'] = [
	{
		pn: 'STYRIA-TEE-M',
		quantity: 2,
		retailPrice: 27.99,
		description: 'Design reference: society-community-v1',
		designs: {
			back: 'https://cdn.example.test/designs/community-back.svg',
			front: 'https://cdn.example.test/designs/community-front.svg'
		}
	}
];

function remoteOrder(overrides: Partial<StyriaOrder> = {}): StyriaOrder {
	return {
		id: 'styria-2042',
		external_id: 'cs_test_reconcile',
		created_at: '2026-07-17T09:45:00.000Z',
		status: 'received',
		deleted: false,
		shipping_address: { country: 'Sweden' },
		shipping: { shippingMethod: 'courier', trackingNumber: null, shiped_at: null },
		items: structuredClone(expectedItems),
		...overrides
	};
}

type Inspected = NonNullable<ReturnType<FulfillmentRepository['inspect']>>;

class MemoryFulfillment {
	readonly calls: string[] = [];
	events: OrderEvent[] = [paidEvent()];
	recordFailures = 0;
	reviewFailures = 0;

	constructor(readonly order = orderFixture()) {}

	inspect(orderId: string): Inspected | null {
		this.calls.push('inspect');
		if (orderId !== this.order.id) return null;
		return {
			...structuredClone(this.order),
			events: structuredClone(this.events),
			supportNotes: []
		};
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
		if (this.reviewFailures-- > 0) {
			throw new Error('raw database failure with Ada provider data');
		}
		if (orderId !== this.order.id) throw new RepositoryError('ORDER_NOT_FOUND');
		this.order.fulfillmentStatus = 'review_required';
		this.order.lastErrorCode = errorCode;
		this.order.updatedAt = new Date(at);
	}
}

class FakeStyria implements StyriaGateway {
	readonly calls: Array<{ externalId: string; createdAfter: Date }> = [];
	matches: StyriaOrder[] = [];
	error: unknown = null;

	async searchByExternalId(externalId: string, createdAfter: Date): Promise<StyriaOrder[]> {
		this.calls.push({ externalId, createdAfter: new Date(createdAfter) });
		if (this.error) throw this.error;
		return structuredClone(this.matches);
	}

	async create(): Promise<StyriaOrder> {
		throw new Error('reconciliation must never create');
	}

	async get(): Promise<StyriaOrder> {
		throw new Error('not used');
	}
}

function setup(status: FulfillmentStatus = 'review_required') {
	const fulfillment = new MemoryFulfillment(orderFixture(status));
	const styria = new FakeStyria();
	const dependencies: ReconciliationDependencies = { fulfillment, styria };
	return {
		service: new StyriaReconciliationService(dependencies),
		fulfillment,
		styria
	};
}

describe('Styria submission reconciliation', () => {
	it.each([
		['missing', []],
		['malformed', [{ ...paidEvent(), createdAt: new Date(Number.NaN) }]]
	] as const)(
		'fails closed before Styria search when paid-order audit is %s',
		async (_label, events) => {
			const state = setup();
			state.fulfillment.events = [...events];

			await expect(state.service.reconcile('order_reconcile', now)).rejects.toMatchObject({
				name: 'ReconciliationError',
				code: 'STYRIA_RECONCILIATION_EVIDENCE_INVALID',
				message: 'STYRIA_RECONCILIATION_EVIDENCE_INVALID'
			});

			expect(state.fulfillment.calls).toEqual(['inspect']);
			expect(state.styria.calls).toEqual([]);
		}
	);

	it.each([
		['wrong order', { ...paidEvent(), orderId: 'order_other' }],
		['wrong actor', { ...paidEvent(), actor: 'codex-admin' }],
		['failed result', { ...paidEvent(), result: 'failed' }],
		['error result', { ...paidEvent(), errorCode: 'PAID_ORDER_FAILED' }]
	])('rejects a paid-order audit with %s before Styria search', async (_label, event) => {
		const state = setup();
		state.fulfillment.events = [event];

		await expect(state.service.reconcile('order_reconcile', now)).rejects.toMatchObject({
			code: 'STYRIA_RECONCILIATION_EVIDENCE_INVALID'
		});

		expect(state.styria.calls).toEqual([]);
	});

	it.each([
		['missing audit', []],
		['corrupt timestamp', [{ ...paidEvent(), createdAt: new Date(Number.NaN) }]],
		['wrong provenance', [{ ...paidEvent(), actor: 'codex-admin' }]]
	] as const)(
		'moves submitting to review when reconciliation evidence has %s',
		async (_label, events) => {
			const state = setup('submitting');
			state.fulfillment.events = [...events];

			await expect(state.service.reconcile('order_reconcile', now)).rejects.toMatchObject({
				name: 'ReconciliationError',
				code: 'STYRIA_RECONCILIATION_EVIDENCE_INVALID',
				message: 'STYRIA_RECONCILIATION_EVIDENCE_INVALID'
			});

			expect(state.fulfillment.calls).toEqual(['inspect', 'requireReview']);
			expect(state.fulfillment.order.fulfillmentStatus).toBe('review_required');
			expect(state.fulfillment.order.lastErrorCode).toBe('STYRIA_RECONCILIATION_EVIDENCE_INVALID');
			expect(state.styria.calls).toEqual([]);
		}
	);

	it('returns a stable state failure when invalid evidence and review writes both fail', async () => {
		const state = setup('submitting');
		state.fulfillment.events = [];
		state.fulfillment.reviewFailures = 1;

		const operation = state.service.reconcile('order_reconcile', now);
		await expect(operation).rejects.toMatchObject({
			name: 'ReconciliationError',
			code: 'STYRIA_RECONCILIATION_STATE_FAILED',
			message: 'STYRIA_RECONCILIATION_STATE_FAILED'
		});
		await expect(operation).rejects.not.toThrow(/Ada|provider|database failure/);

		expect(state.fulfillment.calls).toEqual(['inspect', 'requireReview']);
		expect(state.fulfillment.order.fulfillmentStatus).toBe('submitting');
		expect(state.styria.calls).toEqual([]);
	});

	it('returns not_found for zero exact matches and retains review state', async () => {
		const state = setup();

		await expect(state.service.reconcile('order_reconcile', now)).resolves.toEqual({
			outcome: 'not_found',
			matches: 0,
			fulfillmentStatus: 'review_required'
		});

		expect(state.styria.calls).toEqual([{ externalId: 'cs_test_reconcile', createdAfter: paidAt }]);
		expect(state.fulfillment.calls).toEqual(['inspect']);
	});

	it('repairs one exact match consistent with timestamp, destination, and line summary', async () => {
		const state = setup();
		state.styria.matches = [remoteOrder()];

		await expect(state.service.reconcile('order_reconcile', now)).resolves.toEqual({
			outcome: 'reconciled',
			matches: 1,
			fulfillmentStatus: 'awaiting_vendor_payment'
		});

		expect(state.fulfillment.calls).toEqual(['inspect', 'recordSubmitted']);
		expect(state.fulfillment.order).toEqual(
			expect.objectContaining({
				fulfillmentStatus: 'awaiting_vendor_payment',
				styriaOrderId: 'styria-2042',
				styriaStatus: 'received',
				lastErrorCode: null
			})
		);
	});

	it('accepts provider-copied design URLs when the reference and placement names still match', async () => {
		const state = setup();
		const copiedItems = structuredClone(expectedItems);
		copiedItems[0].designs = {
			back: 'https://styriashirts.eu/copied/community-back-77142.svg',
			front: 'https://styriashirts.eu/copied/community-front-77143.svg'
		};
		state.styria.matches = [remoteOrder({ items: copiedItems })];

		await expect(state.service.reconcile('order_reconcile', now)).resolves.toEqual({
			outcome: 'reconciled',
			matches: 1,
			fulfillmentStatus: 'awaiting_vendor_payment'
		});

		expect(state.fulfillment.calls).toEqual(['inspect', 'recordSubmitted']);
	});

	it('rejects a provider order with different design placement names', async () => {
		const state = setup();
		const changedItems = structuredClone(expectedItems);
		changedItems[0].designs = {
			back: changedItems[0].designs.back,
			left_chest: changedItems[0].designs.front
		};
		state.styria.matches = [remoteOrder({ items: changedItems })];

		await expect(state.service.reconcile('order_reconcile', now)).resolves.toEqual({
			outcome: 'ambiguous',
			matches: 1,
			fulfillmentStatus: 'review_required'
		});

		expect(state.fulfillment.calls).toEqual(['inspect']);
	});

	it('moves submitting to review when recording one consistent match fails', async () => {
		const state = setup('submitting');
		state.styria.matches = [remoteOrder()];
		state.fulfillment.recordFailures = 1;

		await expect(state.service.reconcile('order_reconcile', now)).rejects.toMatchObject({
			name: 'ReconciliationError',
			code: 'STYRIA_RECONCILIATION_RECORD_FAILED',
			message: 'STYRIA_RECONCILIATION_RECORD_FAILED'
		});

		expect(state.fulfillment.calls).toEqual(['inspect', 'recordSubmitted', 'requireReview']);
		expect(state.fulfillment.order.fulfillmentStatus).toBe('review_required');
		expect(state.fulfillment.order.lastErrorCode).toBe('STYRIA_RECONCILIATION_RECORD_FAILED');
	});

	it('returns a stable state failure when record and review writes both fail', async () => {
		const state = setup('submitting');
		state.styria.matches = [remoteOrder()];
		state.fulfillment.recordFailures = 1;
		state.fulfillment.reviewFailures = 1;

		const operation = state.service.reconcile('order_reconcile', now);
		await expect(operation).rejects.toMatchObject({
			name: 'ReconciliationError',
			code: 'STYRIA_RECONCILIATION_STATE_FAILED',
			message: 'STYRIA_RECONCILIATION_STATE_FAILED'
		});
		await expect(operation).rejects.not.toThrow(/Ada|provider|database failure/);

		expect(state.fulfillment.calls).toEqual(['inspect', 'recordSubmitted', 'requireReview']);
		expect(state.fulfillment.order.fulfillmentStatus).toBe('submitting');
		expect(state.fulfillment.order.styriaOrderId).toBeNull();
	});

	it.each([
		['created timestamp', remoteOrder({ created_at: '2026-07-17T09:29:59.999Z' })],
		['destination', remoteOrder({ shipping_address: { country: 'Austria' } })],
		[
			'line summary',
			remoteOrder({
				items: [{ ...structuredClone(expectedItems[0]), quantity: 3 }]
			})
		],
		['deletion state', remoteOrder({ deleted: true })]
	])('leaves one exact but inconsistent %s match ambiguous', async (_label, match) => {
		const state = setup();
		state.styria.matches = [match];

		await expect(state.service.reconcile('order_reconcile', now)).resolves.toEqual({
			outcome: 'ambiguous',
			matches: 1,
			fulfillmentStatus: 'review_required'
		});

		expect(state.fulfillment.calls).toEqual(['inspect']);
		expect(state.fulfillment.order.styriaOrderId).toBeNull();
	});

	it('leaves multiple exact external_id matches ambiguous even when one is consistent', async () => {
		const state = setup();
		state.styria.matches = [
			remoteOrder(),
			remoteOrder({ id: 'styria-2043', shipping_address: { country: 'Austria' } })
		];

		await expect(state.service.reconcile('order_reconcile', now)).resolves.toEqual({
			outcome: 'ambiguous',
			matches: 2,
			fulfillmentStatus: 'review_required'
		});

		expect(state.fulfillment.calls).toEqual(['inspect']);
		expect(state.fulfillment.order.styriaOrderId).toBeNull();
	});

	it('moves an orphaned submitting order to review_required when no match exists', async () => {
		const state = setup('submitting');

		await expect(state.service.reconcile('order_reconcile', now)).resolves.toEqual({
			outcome: 'not_found',
			matches: 0,
			fulfillmentStatus: 'review_required'
		});

		expect(state.fulfillment.calls).toEqual(['inspect', 'requireReview']);
		expect(state.fulfillment.order.lastErrorCode).toBe('STYRIA_CREATE_AMBIGUOUS');
	});

	it('throws a stable redacted error when provider search is unavailable', async () => {
		const state = setup();
		state.styria.error = new StyriaError('STYRIA_UNAVAILABLE');

		const operation = state.service.reconcile('order_reconcile', now);
		await expect(operation).rejects.toMatchObject({
			name: 'ReconciliationError',
			code: 'STYRIA_RECONCILIATION_FAILED',
			message: 'STYRIA_RECONCILIATION_FAILED'
		});
		await expect(operation).rejects.not.toThrow(/provider|address|Ada/);
		expect(state.fulfillment.order.fulfillmentStatus).toBe('review_required');
	});

	it('moves an orphaned submitting order to review before reporting a search failure', async () => {
		const state = setup('submitting');
		state.styria.error = new Error('ECONNRESET provider payload');

		await expect(state.service.reconcile('order_reconcile', now)).rejects.toMatchObject({
			code: 'STYRIA_RECONCILIATION_FAILED'
		});

		expect(state.fulfillment.calls).toEqual(['inspect', 'requireReview']);
		expect(state.fulfillment.order.fulfillmentStatus).toBe('review_required');
		expect(state.fulfillment.order.lastErrorCode).toBe('STYRIA_CREATE_AMBIGUOUS');
	});

	it.each([
		['non-array result', null],
		['malformed array element', [null]]
	])('moves submitting to review for a resolved %s', async (_label, result) => {
		const state = setup('submitting');
		state.styria.matches = result as unknown as StyriaOrder[];

		await expect(state.service.reconcile('order_reconcile', now)).rejects.toMatchObject({
			name: 'ReconciliationError',
			code: 'STYRIA_RECONCILIATION_FAILED',
			message: 'STYRIA_RECONCILIATION_FAILED'
		});

		expect(state.fulfillment.calls).toEqual(['inspect', 'requireReview']);
		expect(state.fulfillment.order.fulfillmentStatus).toBe('review_required');
		expect(state.fulfillment.order.lastErrorCode).toBe('STYRIA_CREATE_AMBIGUOUS');
	});
});
