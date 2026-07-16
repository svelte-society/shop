import type Stripe from 'stripe';
import { ALLOWED_DESTINATIONS } from '$lib/domain/destinations';
import type { CheckoutDraftWithLines, PaymentStatus } from '$lib/domain/orders';
import {
	CHECKOUT_CONTRACT_VERSION,
	type PaidCheckoutSnapshot,
	type StripeOrderGateway
} from './gateway';

const CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/;
const PAYMENT_INTENT_ID_PATTERN = /^pi_[A-Za-z0-9_]+$/;
const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/;
const CHARGE_ID_PATTERN = /^ch_[A-Za-z0-9_]+$/;
const LINE_ITEM_ID_PATTERN = /^li_[A-Za-z0-9_]+$/;
const PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]+$/;
const PAID_SHIPPING_AMOUNT = 1_000;
const LINE_PAGE_LIMIT = 100;
const MAX_CHECKOUT_LINES = 20;
const MAX_CHECKOUT_UNITS = 20;
const SESSION_EXPANSIONS = [
	'customer',
	'customer.tax_ids',
	'payment_intent',
	'payment_intent.latest_charge'
] as const;
const LINE_ITEM_EXPANSIONS = ['data.price'] as const;
const PAYMENT_INTENT_EXPANSIONS = ['latest_charge'] as const;
const TAX_EXEMPT_VALUES = new Set(['none', 'exempt', 'reverse']);
const ALLOWED_DESTINATION_SET = new Set(ALLOWED_DESTINATIONS);

type UnknownRecord = Record<string, unknown>;

export type StripeOrderClient = {
	checkout: {
		sessions: {
			retrieve(sessionId: string, params?: Stripe.Checkout.SessionRetrieveParams): Promise<unknown>;
			listLineItems(
				sessionId: string,
				params?: Stripe.Checkout.SessionListLineItemsParams
			): Promise<unknown>;
		};
	};
	paymentIntents: {
		retrieve(
			paymentIntentId: string,
			params?: Stripe.PaymentIntentRetrieveParams
		): Promise<unknown>;
	};
};

export class PaidCheckoutError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = 'PaidCheckoutError';
		this.code = code;
	}
}

export class PaidCheckoutComparisonError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = 'PaidCheckoutComparisonError';
		this.code = code;
	}
}

function fail(code: string): never {
	throw new PaidCheckoutError(code);
}

function comparisonFail(code: string): never {
	throw new PaidCheckoutComparisonError(code);
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isProviderId(value: unknown, pattern: RegExp): value is string {
	return isExactNonEmptyString(value) && pattern.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeSum(values: number[], code: string): number {
	let total = 0;
	for (const value of values) {
		total += value;
		if (!Number.isSafeInteger(total)) fail(code);
	}
	return total;
}

function safeProduct(left: number, right: number, code: string): number {
	const product = left * right;
	if (!Number.isSafeInteger(product)) fail(code);
	return product;
}

function referenceId(value: unknown, pattern: RegExp): string | null {
	if (isProviderId(value, pattern)) return value;
	if (!isRecord(value) || !isProviderId(value.id, pattern)) return null;
	return value.id;
}

function requireCurrency(value: unknown): void {
	if (value !== 'eur') fail('STRIPE_PAID_CHECKOUT_CURRENCY_INVALID');
}

function validateMetadata(value: unknown, expectedDraftId?: string): string {
	if (!isRecord(value)) fail('STRIPE_PAID_CHECKOUT_DRAFT_INVALID');
	const draftId = value.checkout_draft_id;
	if (
		!isExactNonEmptyString(draftId) ||
		value.product_type !== 'merch' ||
		value.checkout_contract_version !== String(CHECKOUT_CONTRACT_VERSION) ||
		(expectedDraftId !== undefined && draftId !== expectedDraftId)
	) {
		fail('STRIPE_PAID_CHECKOUT_DRAFT_INVALID');
	}
	return draftId;
}

function validateAddress(value: unknown): UnknownRecord {
	if (!isRecord(value) || !isExactNonEmptyString(value.country)) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}
	return value;
}

function shippingAddress(session: UnknownRecord): UnknownRecord {
	const collected = session.collected_information;
	if (isRecord(collected)) {
		const currentShipping = collected.shipping_details;
		if (isRecord(currentShipping)) return validateAddress(currentShipping.address);
	}

	const legacyShipping = session.shipping_details;
	if (isRecord(legacyShipping)) return validateAddress(legacyShipping.address);
	fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
}

function validateTaxIds(value: unknown): Array<{ type: string; value: string }> {
	if (value === null) return [];
	if (!Array.isArray(value)) fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	return value.map((taxId) => {
		if (
			!isRecord(taxId) ||
			!isExactNonEmptyString(taxId.type) ||
			!isExactNonEmptyString(taxId.value)
		) {
			fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
		}
		return { type: taxId.type, value: taxId.value };
	});
}

function taxIdKey(taxId: { type: string; value: string }): string {
	return `${taxId.type}\u0000${taxId.value}`;
}

function validateCustomer(session: UnknownRecord): {
	customerId: string;
	destinationCountry: string;
} {
	const customer = session.customer;
	if (
		!isRecord(customer) ||
		customer.object !== 'customer' ||
		customer.deleted === true ||
		!isProviderId(customer.id, CUSTOMER_ID_PATTERN) ||
		!isExactNonEmptyString(customer.phone) ||
		!TAX_EXEMPT_VALUES.has(customer.tax_exempt as string)
	) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}

	const customerDetails = session.customer_details;
	if (
		!isRecord(customerDetails) ||
		!isExactNonEmptyString(customerDetails.phone) ||
		!TAX_EXEMPT_VALUES.has(customerDetails.tax_exempt as string) ||
		customerDetails.tax_exempt !== customer.tax_exempt
	) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}
	validateAddress(customerDetails.address);

	const sessionTaxIds = validateTaxIds(customerDetails.tax_ids);
	const customerTaxIds = customer.tax_ids;
	if (
		!isRecord(customerTaxIds) ||
		customerTaxIds.object !== 'list' ||
		customerTaxIds.has_more !== false ||
		!Array.isArray(customerTaxIds.data)
	) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}
	const expandedTaxIds = customerTaxIds.data.map((taxId) => {
		if (
			!isRecord(taxId) ||
			taxId.object !== 'tax_id' ||
			!isExactNonEmptyString(taxId.id) ||
			!isExactNonEmptyString(taxId.type) ||
			!isExactNonEmptyString(taxId.value)
		) {
			fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
		}
		return { type: taxId.type, value: taxId.value };
	});
	if (
		JSON.stringify(sessionTaxIds.map(taxIdKey).sort()) !==
		JSON.stringify(expandedTaxIds.map(taxIdKey).sort())
	) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}

	const address = shippingAddress(session);
	const destinationCountry = address.country as string;
	if (!ALLOWED_DESTINATION_SET.has(destinationCountry)) {
		fail('STRIPE_PAID_CHECKOUT_DESTINATION_INVALID');
	}
	return { customerId: customer.id, destinationCountry };
}

type NormalizedLineDetails = {
	id: string;
	priceId: string;
	quantity: number;
	unitAmount: number;
	discount: number;
	subtotal: number;
	tax: number;
	total: number;
};

function normalizeLine(value: unknown): NormalizedLineDetails {
	if (
		!isRecord(value) ||
		value.object !== 'item' ||
		!isProviderId(value.id, LINE_ITEM_ID_PATTERN) ||
		!isSafePositiveInteger(value.quantity) ||
		value.quantity > MAX_CHECKOUT_UNITS ||
		!isSafeNonNegativeInteger(value.amount_discount) ||
		!isSafeNonNegativeInteger(value.amount_subtotal) ||
		!isSafeNonNegativeInteger(value.amount_tax) ||
		!isSafeNonNegativeInteger(value.amount_total) ||
		!isRecord(value.price) ||
		value.price.object !== 'price' ||
		!isProviderId(value.price.id, PRICE_ID_PATTERN) ||
		!isSafeNonNegativeInteger(value.price.unit_amount)
	) {
		fail('STRIPE_PAID_CHECKOUT_LINES_INVALID');
	}
	requireCurrency(value.currency);
	requireCurrency(value.price.currency);
	if (
		value.amount_subtotal !==
		safeProduct(value.price.unit_amount, value.quantity, 'STRIPE_PAID_CHECKOUT_LINES_INVALID')
	) {
		fail('STRIPE_PAID_CHECKOUT_LINES_INVALID');
	}

	return {
		id: value.id,
		priceId: value.price.id,
		quantity: value.quantity,
		unitAmount: value.price.unit_amount,
		discount: value.amount_discount,
		subtotal: value.amount_subtotal,
		tax: value.amount_tax,
		total: value.amount_total
	};
}

async function retrieveLines(
	client: StripeOrderClient,
	sessionId: string
): Promise<NormalizedLineDetails[]> {
	const lines: NormalizedLineDetails[] = [];
	const cursors = new Set<string>();
	let startingAfter: string | undefined;

	while (true) {
		const page = await client.checkout.sessions.listLineItems(sessionId, {
			limit: LINE_PAGE_LIMIT,
			expand: [...LINE_ITEM_EXPANSIONS],
			...(startingAfter ? { starting_after: startingAfter } : {})
		});
		if (
			!isRecord(page) ||
			page.object !== 'list' ||
			!Array.isArray(page.data) ||
			typeof page.has_more !== 'boolean'
		) {
			fail('STRIPE_PAID_CHECKOUT_LINES_INVALID');
		}
		lines.push(...page.data.map(normalizeLine));
		if (lines.length > MAX_CHECKOUT_LINES) fail('STRIPE_PAID_CHECKOUT_LINES_INVALID');
		if (!page.has_more) break;

		const last = page.data.at(-1);
		if (!isRecord(last) || !isProviderId(last.id, LINE_ITEM_ID_PATTERN) || cursors.has(last.id)) {
			fail('STRIPE_PAID_CHECKOUT_LINES_INVALID');
		}
		cursors.add(last.id);
		startingAfter = last.id;
	}

	const units = safeSum(
		lines.map((line) => line.quantity),
		'STRIPE_PAID_CHECKOUT_LINES_INVALID'
	);
	if (lines.length === 0 || units < 1 || units > MAX_CHECKOUT_UNITS) {
		fail('STRIPE_PAID_CHECKOUT_LINES_INVALID');
	}
	return lines;
}

function validatePaymentIntent(
	value: unknown,
	expected: { customerId: string; draftId: string; total: number }
): { paymentIntentId: string; charge: UnknownRecord } {
	if (
		!isRecord(value) ||
		value.object !== 'payment_intent' ||
		!isProviderId(value.id, PAYMENT_INTENT_ID_PATTERN)
	) {
		fail('STRIPE_PAID_CHECKOUT_PAYMENT_INTENT_INVALID');
	}
	if (value.status !== 'succeeded') fail('STRIPE_PAID_CHECKOUT_UNPAID');
	requireCurrency(value.currency);
	if (
		!isSafeNonNegativeInteger(value.amount) ||
		!isSafeNonNegativeInteger(value.amount_received) ||
		value.amount !== expected.total ||
		value.amount_received !== expected.total
	) {
		fail('STRIPE_PAID_CHECKOUT_TOTALS_INVALID');
	}
	if (
		referenceId(value.customer, CUSTOMER_ID_PATTERN) !== expected.customerId ||
		validateMetadata(value.metadata, expected.draftId) !== expected.draftId
	) {
		fail('STRIPE_PAID_CHECKOUT_PAYMENT_INTENT_INVALID');
	}

	const charge = value.latest_charge;
	if (
		!isRecord(charge) ||
		charge.object !== 'charge' ||
		!isProviderId(charge.id, CHARGE_ID_PATTERN) ||
		!isSafeNonNegativeInteger(charge.amount) ||
		!isSafeNonNegativeInteger(charge.amount_captured) ||
		!isSafeNonNegativeInteger(charge.amount_refunded) ||
		charge.amount_refunded > charge.amount ||
		charge.amount !== expected.total ||
		charge.amount_captured !== expected.total ||
		charge.captured !== true ||
		charge.paid !== true ||
		typeof charge.refunded !== 'boolean' ||
		charge.refunded !== (charge.amount_refunded === charge.amount) ||
		referenceId(charge.payment_intent, PAYMENT_INTENT_ID_PATTERN) !== value.id ||
		referenceId(charge.customer, CUSTOMER_ID_PATTERN) !== expected.customerId
	) {
		fail('STRIPE_PAID_CHECKOUT_PAYMENT_INTENT_INVALID');
	}
	if (charge.status !== 'succeeded') fail('STRIPE_PAID_CHECKOUT_UNPAID');
	requireCurrency(charge.currency);
	return { paymentIntentId: value.id, charge };
}

function normalizePaidCheckout(
	requestedSessionId: string,
	session: unknown,
	lines: NormalizedLineDetails[]
): PaidCheckoutSnapshot {
	if (
		!isRecord(session) ||
		session.object !== 'checkout.session' ||
		session.id !== requestedSessionId ||
		!isProviderId(session.id, CHECKOUT_SESSION_ID_PATTERN) ||
		session.mode !== 'payment'
	) {
		fail('STRIPE_PAID_CHECKOUT_INVALID');
	}
	if (session.status !== 'complete' || session.payment_status !== 'paid') {
		fail('STRIPE_PAID_CHECKOUT_UNPAID');
	}
	requireCurrency(session.currency);

	const draftId = validateMetadata(session.metadata);
	if (session.client_reference_id !== draftId) fail('STRIPE_PAID_CHECKOUT_DRAFT_INVALID');
	const { customerId, destinationCountry } = validateCustomer(session);

	if (
		!isRecord(session.automatic_tax) ||
		session.automatic_tax.enabled !== true ||
		session.automatic_tax.status !== 'complete'
	) {
		fail('STRIPE_PAID_CHECKOUT_TAX_INVALID');
	}
	if (
		!isSafeNonNegativeInteger(session.amount_subtotal) ||
		!isSafeNonNegativeInteger(session.amount_total) ||
		!isRecord(session.total_details) ||
		!isSafeNonNegativeInteger(session.total_details.amount_discount) ||
		!isSafeNonNegativeInteger(session.total_details.amount_shipping) ||
		!isRecord(session.shipping_cost) ||
		!isSafeNonNegativeInteger(session.shipping_cost.amount_subtotal) ||
		!isSafeNonNegativeInteger(session.shipping_cost.amount_total) ||
		!isExactNonEmptyString(session.shipping_cost.shipping_rate)
	) {
		fail('STRIPE_PAID_CHECKOUT_TOTALS_INVALID');
	}
	if (
		!isSafeNonNegativeInteger(session.total_details.amount_tax) ||
		!isSafeNonNegativeInteger(session.shipping_cost.amount_tax)
	) {
		fail('STRIPE_PAID_CHECKOUT_TAX_INVALID');
	}

	const lineSubtotal = safeSum(
		lines.map((line) => line.subtotal),
		'STRIPE_PAID_CHECKOUT_TOTALS_INVALID'
	);
	const lineDiscount = safeSum(
		lines.map((line) => line.discount),
		'STRIPE_PAID_CHECKOUT_TOTALS_INVALID'
	);
	const lineTax = safeSum(
		lines.map((line) => line.tax),
		'STRIPE_PAID_CHECKOUT_TAX_INVALID'
	);
	const providerTax = safeSum(
		[lineTax, session.shipping_cost.amount_tax],
		'STRIPE_PAID_CHECKOUT_TAX_INVALID'
	);
	const providerTotal = safeSum(
		[...lines.map((line) => line.total), session.shipping_cost.amount_total],
		'STRIPE_PAID_CHECKOUT_TOTALS_INVALID'
	);
	if (providerTax !== session.total_details.amount_tax) {
		fail('STRIPE_PAID_CHECKOUT_TAX_INVALID');
	}
	if (
		lineSubtotal !== session.amount_subtotal ||
		lineDiscount !== session.total_details.amount_discount ||
		session.shipping_cost.amount_total !== session.total_details.amount_shipping ||
		providerTotal !== session.amount_total
	) {
		fail('STRIPE_PAID_CHECKOUT_TOTALS_INVALID');
	}

	const { paymentIntentId } = validatePaymentIntent(session.payment_intent, {
		customerId,
		draftId,
		total: session.amount_total
	});
	return {
		checkoutSessionId: session.id,
		paymentIntentId,
		customerId,
		draftId,
		currency: 'eur',
		paymentStatus: 'paid',
		destinationCountry,
		amounts: {
			subtotal: session.amount_subtotal,
			discount: session.total_details.amount_discount,
			shipping: session.total_details.amount_shipping,
			tax: session.total_details.amount_tax,
			total: session.amount_total
		},
		lines: lines.map(({ priceId, quantity, unitAmount }) => ({
			priceId,
			quantity,
			unitAmount
		}))
	};
}

function normalizeRefundStatus(requestedPaymentIntentId: string, value: unknown): PaymentStatus {
	if (
		!isRecord(value) ||
		value.object !== 'payment_intent' ||
		value.id !== requestedPaymentIntentId ||
		!isProviderId(value.id, PAYMENT_INTENT_ID_PATTERN) ||
		value.status !== 'succeeded' ||
		!isSafeNonNegativeInteger(value.amount) ||
		!isSafeNonNegativeInteger(value.amount_received) ||
		value.amount !== value.amount_received
	) {
		fail('STRIPE_REFUND_STATUS_INVALID');
	}
	if (value.currency !== 'eur') fail('STRIPE_REFUND_STATUS_INVALID');

	const charge = value.latest_charge;
	if (
		!isRecord(charge) ||
		charge.object !== 'charge' ||
		!isProviderId(charge.id, CHARGE_ID_PATTERN) ||
		charge.status !== 'succeeded' ||
		charge.paid !== true ||
		charge.captured !== true ||
		charge.currency !== 'eur' ||
		referenceId(charge.payment_intent, PAYMENT_INTENT_ID_PATTERN) !== value.id ||
		!isSafeNonNegativeInteger(charge.amount) ||
		!isSafeNonNegativeInteger(charge.amount_captured) ||
		!isSafeNonNegativeInteger(charge.amount_refunded) ||
		charge.amount !== value.amount ||
		charge.amount_captured !== value.amount ||
		charge.amount_refunded > charge.amount ||
		typeof charge.refunded !== 'boolean' ||
		charge.refunded !== (charge.amount_refunded === charge.amount)
	) {
		fail('STRIPE_REFUND_STATUS_INVALID');
	}
	if (charge.amount_refunded === 0) return 'paid';
	if (charge.amount_refunded === charge.amount) return 'refunded';
	return 'partially_refunded';
}

export function createStripeOrderGateway(client: StripeOrderClient): StripeOrderGateway {
	return {
		async retrievePaidCheckout(sessionId: string): Promise<PaidCheckoutSnapshot> {
			if (!isProviderId(sessionId, CHECKOUT_SESSION_ID_PATTERN)) {
				fail('STRIPE_PAID_CHECKOUT_INVALID');
			}
			try {
				const session = await client.checkout.sessions.retrieve(sessionId, {
					expand: [...SESSION_EXPANSIONS]
				});
				const lines = await retrieveLines(client, sessionId);
				return normalizePaidCheckout(sessionId, session, lines);
			} catch (error) {
				if (error instanceof PaidCheckoutError) throw error;
				fail('STRIPE_PAID_CHECKOUT_RETRIEVAL_FAILED');
			}
		},

		async retrieveRefundStatus(paymentIntentId: string): Promise<PaymentStatus> {
			if (!isProviderId(paymentIntentId, PAYMENT_INTENT_ID_PATTERN)) {
				fail('STRIPE_REFUND_STATUS_INVALID');
			}
			try {
				const paymentIntent = await client.paymentIntents.retrieve(paymentIntentId, {
					expand: [...PAYMENT_INTENT_EXPANSIONS]
				});
				return normalizeRefundStatus(paymentIntentId, paymentIntent);
			} catch (error) {
				if (error instanceof PaidCheckoutError) throw error;
				fail('STRIPE_REFUND_STATUS_RETRIEVAL_FAILED');
			}
		}
	};
}

type ComparableLine = { priceId: string; quantity: number; unitAmount: number };

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function canonicalLines(lines: ComparableLine[]): ComparableLine[] {
	return lines
		.map((line) => ({ ...line }))
		.sort(
			(left, right) =>
				compareText(left.priceId, right.priceId) ||
				left.quantity - right.quantity ||
				left.unitAmount - right.unitAmount
		);
}

function isComparableLine(value: unknown): value is ComparableLine {
	return (
		isRecord(value) &&
		isProviderId(value.priceId, PRICE_ID_PATTERN) &&
		isSafePositiveInteger(value.quantity) &&
		value.quantity <= MAX_CHECKOUT_UNITS &&
		isSafeNonNegativeInteger(value.unitAmount)
	);
}

export function comparePaidCheckout(
	draft: CheckoutDraftWithLines,
	paid: PaidCheckoutSnapshot
): void {
	if (
		!draft ||
		!paid ||
		draft.id !== paid.draftId ||
		draft.contractVersion !== CHECKOUT_CONTRACT_VERSION
	) {
		comparisonFail('PAID_CHECKOUT_DRAFT_MISMATCH');
	}
	if (!draft.checkoutSessionId || draft.checkoutSessionId !== paid.checkoutSessionId) {
		comparisonFail('PAID_CHECKOUT_SESSION_MISMATCH');
	}
	if (
		draft.currency !== 'eur' ||
		paid.currency !== 'eur' ||
		draft.lines.some((line) => line.currency !== 'eur')
	) {
		comparisonFail('PAID_CHECKOUT_CURRENCY_MISMATCH');
	}

	const draftLines = draft.lines.map((line) => ({
		priceId: line.stripePriceId,
		quantity: line.quantity,
		unitAmount: line.unitAmount
	}));
	if (
		!Array.isArray(paid.lines) ||
		!draftLines.every(isComparableLine) ||
		!paid.lines.every(isComparableLine) ||
		JSON.stringify(canonicalLines(draftLines)) !== JSON.stringify(canonicalLines(paid.lines))
	) {
		comparisonFail('PAID_CHECKOUT_LINES_MISMATCH');
	}

	const paidUnitCount = paid.lines.reduce((total, line) => total + line.quantity, 0);
	if (!Number.isSafeInteger(paidUnitCount) || paidUnitCount !== draft.totalUnitCount) {
		comparisonFail('PAID_CHECKOUT_UNIT_COUNT_MISMATCH');
	}
	const expectedShipping = draft.shippingMode === 'paid' ? PAID_SHIPPING_AMOUNT : 0;
	if (paid.amounts.shipping !== expectedShipping) {
		comparisonFail('PAID_CHECKOUT_SHIPPING_MISMATCH');
	}

	const draftSubtotal = draft.lines.reduce((subtotal, line) => {
		const lineSubtotal = line.quantity * line.unitAmount;
		if (!Number.isSafeInteger(lineSubtotal) || !Number.isSafeInteger(subtotal + lineSubtotal)) {
			comparisonFail('PAID_CHECKOUT_SUBTOTAL_MISMATCH');
		}
		return subtotal + lineSubtotal;
	}, 0);
	if (paid.amounts.subtotal !== draftSubtotal) {
		comparisonFail('PAID_CHECKOUT_SUBTOTAL_MISMATCH');
	}
	if (paid.amounts.discount !== 0) comparisonFail('PAID_CHECKOUT_DISCOUNT_MISMATCH');
	if (
		paid.paymentStatus !== 'paid' ||
		!ALLOWED_DESTINATION_SET.has(paid.destinationCountry) ||
		!isProviderId(paid.paymentIntentId, PAYMENT_INTENT_ID_PATTERN) ||
		!isProviderId(paid.customerId, CUSTOMER_ID_PATTERN) ||
		!Object.values(paid.amounts).every(isSafeNonNegativeInteger) ||
		paid.amounts.total < paid.amounts.subtotal + paid.amounts.shipping
	) {
		comparisonFail('PAID_CHECKOUT_TOTALS_MISMATCH');
	}
}
