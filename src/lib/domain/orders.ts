export type PaymentStatus = 'paid' | 'partially_refunded' | 'refunded';

export type FulfillmentStatus =
	| 'pending_review'
	| 'submitting'
	| 'submitted'
	| 'awaiting_vendor_payment'
	| 'in_production'
	| 'shipped'
	| 'review_required'
	| 'cancelled';

export type ShippingMode = 'paid' | 'free';

export type DesignPlacements = Record<string, string>;

export type NewCheckoutDraftLine = {
	stripeProductId: string;
	stripePriceId: string;
	productName: string;
	variantLabel: string;
	sku: string;
	styriaProductNumber: string;
	designReference: string;
	designPlacements: DesignPlacements;
	quantity: number;
	unitAmount: number;
	currency: 'eur';
};

export type CheckoutDraftLine = NewCheckoutDraftLine & {
	lineIndex: number;
};

export type NewCheckoutDraft = {
	contractVersion: number;
	currency: 'eur';
	totalUnitCount: number;
	shippingMode: ShippingMode;
	createdAt: Date;
	expiresAt: Date;
	lines: NewCheckoutDraftLine[];
};

export type CheckoutDraft = Omit<NewCheckoutDraft, 'lines'> & {
	id: string;
	checkoutSessionId: string | null;
	completedAt: Date | null;
};

export type CheckoutDraftWithLines = CheckoutDraft & {
	lines: CheckoutDraftLine[];
};

export type OrderAmounts = {
	subtotal: number;
	discount: number;
	shipping: number;
	tax: number;
	total: number;
};

export type PaidOrderInput = {
	checkoutSessionId: string;
	paymentIntentId: string;
	customerId: string;
	checkoutDraftId: string;
	currency: 'eur';
	amounts: OrderAmounts;
	destinationCountry: string;
	updatedAt: Date;
};

export type Order = PaidOrderInput & {
	id: string;
	paymentStatus: PaymentStatus;
	fulfillmentStatus: FulfillmentStatus;
	styriaOrderId: string | null;
	styriaStatus: string | null;
	trackingNumber: string | null;
	submittedAt: Date | null;
	shippedAt: Date | null;
	lastErrorCode: string | null;
};

export type OrderLine = CheckoutDraftLine & {
	orderId: string;
};

export type OrderWithLines = Order & {
	lines: OrderLine[];
};

export type ProviderReferences = {
	checkoutSessionId: string | null;
	paymentIntentId: string | null;
};

export type StripeEventInput = {
	eventId: string;
	eventType: string;
	processedAt: Date;
};

export type NewOutboxJob = {
	kind: string;
	idempotencyKey: string;
	orderId: string | null;
	nextAttemptAt: Date;
};

export type OutboxJob = NewOutboxJob & {
	id: number;
	attemptCount: number;
	completedAt: Date | null;
	lastErrorCode: string | null;
};

export type NewOrderEvent = {
	orderId: string;
	actor: string;
	action: string;
	priorState: string | null;
	nextState: string | null;
	result: string;
	errorCode: string | null;
	createdAt: Date;
};

export type OrderEvent = NewOrderEvent & {
	id: number;
};

export class RepositoryError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = 'RepositoryError';
		this.code = code;
	}
}

const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export function isStableErrorCode(value: unknown): value is string {
	return typeof value === 'string' && STABLE_ERROR_CODE_PATTERN.test(value);
}
