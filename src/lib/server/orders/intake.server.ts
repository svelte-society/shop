import type { PaymentStatus, StripeEventInput } from '$lib/domain/orders';
import { RepositoryError } from '$lib/domain/orders';
import { SqliteOrderEventRepository } from '$lib/server/audit/order-events.server';
import { SqliteOrderRepository } from '$lib/server/db/orders.server';
import { SqliteStripeEventRepository } from '$lib/server/db/stripe-events.server';
import type { ShopDatabase } from '$lib/server/db/types';

export interface RefundOrderUnitOfWork {
	commitRefund(paymentIntentId: string, status: PaymentStatus, event: StripeEventInput): void;
}

type RefundOrderRow = {
	id: unknown;
	stripe_checkout_session_id: unknown;
	payment_status: unknown;
	fulfillment_status: unknown;
};

type EventStateRow = {
	event_type: unknown;
	processing_status: unknown;
	stripe_checkout_session_id: unknown;
	stripe_payment_intent_id: unknown;
};

function fail(code: string): never {
	throw new RepositoryError(code);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isPaymentStatus(value: unknown): value is PaymentStatus {
	return value === 'paid' || value === 'partially_refunded' || value === 'refunded';
}

function validateEvent(event: StripeEventInput): void {
	if (
		!event ||
		!isNonEmptyString(event.eventId) ||
		event.eventType !== 'charge.refunded' ||
		!(event.processedAt instanceof Date) ||
		!Number.isFinite(event.processedAt.getTime())
	) {
		fail('STRIPE_EVENT_INVALID');
	}
}

export class SqliteRefundOrderUnitOfWork implements RefundOrderUnitOfWork {
	private readonly orders: SqliteOrderRepository;
	private readonly events: SqliteStripeEventRepository;
	private readonly audit: SqliteOrderEventRepository;

	constructor(private readonly database: ShopDatabase) {
		this.orders = new SqliteOrderRepository(database);
		this.events = new SqliteStripeEventRepository(database);
		this.audit = new SqliteOrderEventRepository(database);
	}

	commitRefund(paymentIntentId: string, status: PaymentStatus, event: StripeEventInput): void {
		if (!isNonEmptyString(paymentIntentId) || !isPaymentStatus(status)) {
			fail('REFUND_ORDER_INVALID');
		}
		validateEvent(event);

		const findEvent = this.database.prepare(`
			SELECT event_type, processing_status, stripe_checkout_session_id,
				stripe_payment_intent_id
			FROM stripe_events WHERE stripe_event_id = ?
		`);
		const findOrder = this.database.prepare(`
			SELECT id, stripe_checkout_session_id, payment_status, fulfillment_status
			FROM orders WHERE stripe_payment_intent_id = ?
		`);
		const commit = this.database.transaction(() => {
			const eventState = findEvent.get(event.eventId) as EventStateRow | undefined;
			if (!eventState) fail('STRIPE_EVENT_NOT_FOUND');
			if (eventState.event_type !== event.eventType) fail('STRIPE_EVENT_TYPE_CONFLICT');

			const before = findOrder.get(paymentIntentId) as RefundOrderRow | undefined;
			if (!before) fail('ORDER_NOT_FOUND');
			if (
				!isNonEmptyString(before.id) ||
				!isNonEmptyString(before.stripe_checkout_session_id) ||
				!isPaymentStatus(before.payment_status) ||
				!isNonEmptyString(before.fulfillment_status)
			) {
				fail('ORDER_ROW_INVALID');
			}

			if (eventState.processing_status === 'completed') {
				if (
					eventState.stripe_checkout_session_id !== before.stripe_checkout_session_id ||
					eventState.stripe_payment_intent_id !== paymentIntentId
				) {
					fail('STRIPE_EVENT_REFERENCE_CONFLICT');
				}
				return;
			}
			if (eventState.processing_status !== 'processing') fail('STRIPE_EVENT_STATE_CONFLICT');

			this.orders.updatePaymentStatus(paymentIntentId, status, event.processedAt);
			const after = findOrder.get(paymentIntentId) as RefundOrderRow | undefined;
			if (!after || !isPaymentStatus(after.payment_status)) fail('ORDER_ROW_INVALID');
			this.audit.append({
				orderId: before.id,
				actor: 'stripe-webhook',
				action:
					before.payment_status === after.payment_status
						? 'payment_status_converged'
						: 'payment_status_updated',
				priorState: before.payment_status,
				nextState: after.payment_status,
				result: 'succeeded',
				errorCode: null,
				createdAt: event.processedAt
			});
			this.events.complete(
				event.eventId,
				{
					checkoutSessionId: before.stripe_checkout_session_id,
					paymentIntentId
				},
				event.processedAt
			);
		});

		try {
			commit.immediate();
		} catch (error) {
			if (
				error instanceof RepositoryError &&
				error.code !== 'PAYMENT_STATUS_UPDATE_FAILED' &&
				error.code !== 'ORDER_EVENT_APPEND_FAILED' &&
				error.code !== 'STRIPE_EVENT_COMPLETE_FAILED'
			) {
				throw error;
			}
			fail('REFUND_ORDER_COMMIT_FAILED');
		}
	}
}
