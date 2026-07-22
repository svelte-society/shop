import type Stripe from 'stripe';
import type { StripeEventInput } from '$lib/domain/orders';
import { isStableErrorCode, RepositoryError } from '$lib/domain/orders';
import type { CheckoutDraftRepository } from '$lib/server/db/checkout-drafts.server';
import type { PaidOrderUnitOfWork } from '$lib/server/db/orders.server';
import type { StripeEventRepository } from '$lib/server/db/stripe-events.server';
import type { RefundOrderUnitOfWork } from '$lib/server/orders/intake.server';
import type { StripeOrderGateway } from './gateway';
import {
	comparePaidCheckout,
	PaidCheckoutComparisonError,
	PaidCheckoutError
} from './paid-checkout';

export interface StripeWebhookService {
	handle(rawBody: string, signature: string): Promise<{ duplicate: boolean }>;
}

export interface StripeWebhookVerifier {
	constructEvent(rawBody: string, signature: string, secret: string): Stripe.Event;
}

export function createStripeWebhookVerifier(
	client: Pick<Stripe, 'webhooks'>
): StripeWebhookVerifier {
	return {
		constructEvent(rawBody, signature, secret) {
			return client.webhooks.constructEvent(rawBody, signature, secret);
		}
	};
}

export class StripeWebhookError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, retryable: boolean) {
		super(code);
		this.name = 'StripeWebhookError';
		this.code = code;
		this.retryable = retryable;
	}
}

export type StripeWebhookProcessingDependencies = {
	stripeEvents: StripeEventRepository;
	drafts: CheckoutDraftRepository;
	stripeOrders: StripeOrderGateway;
	paidOrders: PaidOrderUnitOfWork;
	refunds: RefundOrderUnitOfWork;
};

type StripeWebhookDependencies = {
	webhookSecret: string;
	verifier: StripeWebhookVerifier;
	checkReadiness: () => Promise<{ ready: boolean }>;
	loadProcessingDependencies?: () => StripeWebhookProcessingDependencies;
	now?: () => Date;
} & Partial<StripeWebhookProcessingDependencies>;

const PAID_EVENT_TYPES = new Set<Stripe.Event.Type>([
	'checkout.session.completed',
	'checkout.session.async_payment_succeeded'
]);
const REFUND_EVENT_TYPES = new Set<Stripe.Event.Type>(['charge.refunded']);
const EVENT_ID_PATTERN = /^evt_[A-Za-z0-9_]+$/;
const CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/;
const PAYMENT_INTENT_ID_PATTERN = /^pi_[A-Za-z0-9_]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function invalidEvent(): never {
	throw new StripeWebhookError('STRIPE_WEBHOOK_EVENT_INVALID', false);
}

function verifyEventShape(value: unknown): Stripe.Event {
	if (
		!isRecord(value) ||
		!isExactNonEmptyString(value.id) ||
		!EVENT_ID_PATTERN.test(value.id) ||
		!isExactNonEmptyString(value.type) ||
		!isRecord(value.data)
	) {
		invalidEvent();
	}
	return value as unknown as Stripe.Event;
}

function checkoutSessionId(event: Stripe.Event): string {
	const object = event.data.object as unknown;
	if (
		!isRecord(object) ||
		object.object !== 'checkout.session' ||
		!isExactNonEmptyString(object.id) ||
		!CHECKOUT_SESSION_ID_PATTERN.test(object.id)
	) {
		invalidEvent();
	}
	return object.id;
}

function paymentIntentId(event: Stripe.Event): string {
	const object = event.data.object as unknown;
	if (!isRecord(object) || object.object !== 'charge') invalidEvent();
	const reference = object.payment_intent;
	const id = isRecord(reference) ? reference.id : reference;
	if (!isExactNonEmptyString(id) || !PAYMENT_INTENT_ID_PATTERN.test(id)) invalidEvent();
	return id;
}

function errorDetails(error: unknown): { code: string; retryable: boolean } {
	if (error instanceof StripeWebhookError) {
		return { code: error.code, retryable: error.retryable };
	}
	if (
		error instanceof PaidCheckoutError ||
		error instanceof PaidCheckoutComparisonError ||
		error instanceof RepositoryError
	) {
		const code = error.code;
		const retryable =
			code.endsWith('_RETRIEVAL_FAILED') ||
			code === 'STRIPE_PAID_CHECKOUT_PAYMENT_NOT_SETTLED' ||
			code === 'ORDER_NOT_FOUND' ||
			code === 'PAID_ORDER_COMMIT_FAILED' ||
			code === 'REFUND_ORDER_COMMIT_FAILED' ||
			code.endsWith('_BEGIN_FAILED') ||
			code.endsWith('_COMPLETE_FAILED') ||
			code.endsWith('_FAIL_FAILED') ||
			code.endsWith('_UPDATE_FAILED');
		return { code, retryable };
	}
	if (isRecord(error) && isStableErrorCode(error.code) && typeof error.retryable === 'boolean') {
		return { code: error.code, retryable: error.retryable };
	}
	return { code: 'STRIPE_WEBHOOK_PROCESSING_FAILED', retryable: true };
}

function eventInput(event: Stripe.Event, processedAt: Date): StripeEventInput {
	return { eventId: event.id, eventType: event.type, processedAt };
}

function isProcessingDependencies(
	value: Partial<StripeWebhookProcessingDependencies>
): value is StripeWebhookProcessingDependencies {
	return Boolean(
		value.stripeEvents && value.drafts && value.stripeOrders && value.paidOrders && value.refunds
	);
}

export function createStripeWebhookService(
	dependencies: StripeWebhookDependencies
): StripeWebhookService {
	if (
		!dependencies ||
		!isExactNonEmptyString(dependencies.webhookSecret) ||
		!dependencies.verifier ||
		typeof dependencies.checkReadiness !== 'function' ||
		(!isProcessingDependencies(dependencies) &&
			typeof dependencies.loadProcessingDependencies !== 'function')
	) {
		throw new StripeWebhookError('STRIPE_WEBHOOK_CONFIG_INVALID', false);
	}
	const now = dependencies.now ?? (() => new Date());
	let processing: StripeWebhookProcessingDependencies | undefined = isProcessingDependencies(
		dependencies
	)
		? dependencies
		: undefined;
	const loadProcessing = (): StripeWebhookProcessingDependencies => {
		if (processing) return processing;
		let loaded: StripeWebhookProcessingDependencies | undefined;
		try {
			loaded = dependencies.loadProcessingDependencies?.();
		} catch {
			throw new StripeWebhookError('STRIPE_WEBHOOK_PROCESSING_INIT_FAILED', true);
		}
		if (!loaded || !isProcessingDependencies(loaded)) {
			throw new StripeWebhookError('STRIPE_WEBHOOK_PROCESSING_INIT_FAILED', true);
		}
		processing = loaded;
		return processing;
	};
	const requireReadiness = async (): Promise<void> => {
		try {
			if (!(await dependencies.checkReadiness()).ready) {
				throw new Error('NOT_READY');
			}
		} catch {
			throw new StripeWebhookError('STRIPE_WEBHOOK_SERVICE_NOT_READY', true);
		}
	};
	const inFlight = new Map<string, Promise<{ duplicate: boolean }>>();
	const processEvent = async (
		event: Stripe.Event,
		sessionId: string | null,
		intentId: string | null
	): Promise<{ duplicate: boolean }> => {
		const processing = loadProcessing();
		const processedAt = now();
		if (!(processedAt instanceof Date) || !Number.isFinite(processedAt.getTime())) {
			throw new StripeWebhookError('STRIPE_WEBHOOK_CLOCK_INVALID', true);
		}

		let claim: 'new' | 'completed' | 'retry';
		try {
			claim = processing.stripeEvents.begin(event.id, event.type, processedAt);
		} catch (error) {
			const details = errorDetails(error);
			throw new StripeWebhookError(details.code, details.retryable);
		}
		const duplicate = claim === 'completed';

		try {
			if (sessionId !== null) {
				let paid;
				try {
					paid = await processing.stripeOrders.retrievePaidCheckout(sessionId);
				} catch (error) {
					if (
						error instanceof PaidCheckoutError &&
						error.code === 'STRIPE_PAID_CHECKOUT_SESSION_UNPAID'
					) {
						if (event.type === 'checkout.session.completed') {
							processing.stripeEvents.complete(
								event.id,
								{ checkoutSessionId: sessionId, paymentIntentId: null },
								processedAt
							);
							return { duplicate };
						}
						throw new StripeWebhookError(error.code, true);
					}
					throw error;
				}
				const draft = processing.drafts.findById(paid.draftId);
				if (!draft) {
					throw new StripeWebhookError('PAID_CHECKOUT_DRAFT_NOT_FOUND', false);
				}
				comparePaidCheckout(draft, paid);
				processing.paidOrders.commitPaidOrder(
					{
						checkoutSessionId: paid.checkoutSessionId,
						paymentIntentId: paid.paymentIntentId,
						customerId: paid.customerId,
						checkoutDraftId: paid.draftId,
						currency: paid.currency,
						amounts: paid.amounts,
						destinationCountry: paid.destinationCountry,
						updatedAt: processedAt,
						lines: paid.lines.map(({ priceId, quantity, unitAmount, retailUnitAmount }) => ({
							stripePriceId: priceId,
							quantity,
							unitAmount,
							retailUnitAmount
						}))
					},
					eventInput(event, processedAt)
				);
			} else if (intentId !== null) {
				const status = await processing.stripeOrders.retrieveRefundStatus(intentId);
				if (status === 'paid') {
					throw new StripeWebhookError('STRIPE_REFUND_STATUS_NOT_SETTLED', true);
				}
				processing.refunds.commitRefund(intentId, status, eventInput(event, processedAt));
			}
			return { duplicate };
		} catch (error) {
			const details = errorDetails(error);
			if (!duplicate) {
				try {
					processing.stripeEvents.fail(event.id, details.code);
				} catch {
					throw new StripeWebhookError('STRIPE_WEBHOOK_EVENT_FAILURE_FAILED', true);
				}
			}
			throw new StripeWebhookError(details.code, details.retryable);
		}
	};

	return {
		async handle(rawBody, signature): Promise<{ duplicate: boolean }> {
			if (typeof rawBody !== 'string' || !isExactNonEmptyString(signature)) {
				throw new StripeWebhookError('STRIPE_WEBHOOK_SIGNATURE_INVALID', false);
			}

			let event: Stripe.Event;
			try {
				event = verifyEventShape(
					dependencies.verifier.constructEvent(rawBody, signature, dependencies.webhookSecret)
				);
			} catch (error) {
				if (error instanceof StripeWebhookError) throw error;
				throw new StripeWebhookError('STRIPE_WEBHOOK_SIGNATURE_INVALID', false);
			}

			const isPaidEvent = PAID_EVENT_TYPES.has(event.type);
			const isRefundEvent = REFUND_EVENT_TYPES.has(event.type);
			if (!isPaidEvent && !isRefundEvent) return { duplicate: false };
			const sessionId = isPaidEvent ? checkoutSessionId(event) : null;
			const intentId = isRefundEvent ? paymentIntentId(event) : null;
			await requireReadiness();

			const active = inFlight.get(event.id);
			if (active) {
				await active;
				return { duplicate: true };
			}
			const operation = processEvent(event, sessionId, intentId);
			inFlight.set(event.id, operation);
			try {
				return await operation;
			} finally {
				if (inFlight.get(event.id) === operation) inFlight.delete(event.id);
			}
		}
	};
}
