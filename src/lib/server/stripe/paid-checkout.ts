import type Stripe from 'stripe';
import { isSupportedDestination } from '$lib/domain/destinations';
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
const SHIPPING_RATE_ID_PATTERN = /^shr_[A-Za-z0-9_]+$/;
const TAX_RATE_ID_PATTERN = /^txr_[A-Za-z0-9_]+$/;
const PAID_SHIPPING_AMOUNT = 800;
const LINE_PAGE_LIMIT = 100;
const MAX_CHECKOUT_LINES = 20;
const MAX_CHECKOUT_UNITS = 20;
const SESSION_EXPANSIONS = [
	'customer',
	'customer.tax_ids',
	'payment_intent',
	'payment_intent.latest_charge',
	'shipping_cost.shipping_rate',
	'shipping_cost.taxes'
] as const;
const LINE_ITEM_EXPANSIONS = ['data.price'] as const;
const PAYMENT_INTENT_EXPANSIONS = ['latest_charge'] as const;
type TaxExempt = 'none' | 'exempt' | 'reverse';
const TAX_EXEMPT_VALUES: ReadonlySet<string> = new Set<TaxExempt>(['none', 'exempt', 'reverse']);
const SUPPORTED_TAX_ID_TYPES = [
	'bg_uic',
	'de_stn',
	'es_cif',
	'eu_oss_vat',
	'eu_vat',
	'hr_oib',
	'hu_tin',
	'it_cf',
	'pl_nip',
	'ro_tin',
	'si_tin',
	'us_ein'
] as const satisfies readonly Stripe.Checkout.Session.CustomerDetails.TaxId.Type[];
const SUPPORTED_TAX_ID_TYPE_SET: ReadonlySet<string> = new Set(SUPPORTED_TAX_ID_TYPES);

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

function safeDifference(left: number, right: number, code: string): number {
	const difference = left - right;
	if (!Number.isSafeInteger(difference) || difference < 0) fail(code);
	return difference;
}

function referenceId(value: unknown, pattern: RegExp): string | null {
	if (isProviderId(value, pattern)) return value;
	if (!isRecord(value) || !isProviderId(value.id, pattern)) return null;
	return value.id;
}

function requireCurrency(value: unknown): void {
	if (value !== 'eur') fail('STRIPE_PAID_CHECKOUT_CURRENCY_INVALID');
}

type CheckoutMetadata = {
	draftId: string;
	contractVersion: 2;
	destinationCountry: string;
};

function validateMetadata(value: unknown, expected?: CheckoutMetadata): CheckoutMetadata {
	if (!isRecord(value)) fail('STRIPE_PAID_CHECKOUT_DRAFT_INVALID');
	const draftId = value.checkout_draft_id;
	const destinationCountry = value.destination_country;
	if (
		!isExactNonEmptyString(draftId) ||
		!isExactNonEmptyString(destinationCountry) ||
		value.product_type !== 'merch' ||
		value.checkout_contract_version !== String(CHECKOUT_CONTRACT_VERSION) ||
		(expected !== undefined &&
			(draftId !== expected.draftId || destinationCountry !== expected.destinationCountry))
	) {
		fail('STRIPE_PAID_CHECKOUT_DRAFT_INVALID');
	}
	return { draftId, contractVersion: 2, destinationCountry };
}

type NormalizedAddress = {
	city: string;
	country: string;
	line1: string;
	line2: string | null;
	postalCode: string;
	state: string | null;
};

function optionalExactString(value: unknown): string | null {
	if (value === null) return null;
	if (!isExactNonEmptyString(value)) fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	return value;
}

function validateTaxAddress(value: unknown): void {
	if (!isRecord(value) || !isExactNonEmptyString(value.country)) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}
}

function normalizeShippingAddress(value: unknown): NormalizedAddress {
	if (
		!isRecord(value) ||
		!isExactNonEmptyString(value.city) ||
		!isExactNonEmptyString(value.country) ||
		!isExactNonEmptyString(value.line1) ||
		!isExactNonEmptyString(value.postal_code)
	) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}
	const line2 = optionalExactString(value.line2);
	const state = optionalExactString(value.state);
	return {
		city: value.city,
		country: value.country,
		line1: value.line1,
		line2,
		postalCode: value.postal_code,
		state
	};
}

function shippingIdentity(session: UnknownRecord): { name: string; address: NormalizedAddress } {
	const collected = session.collected_information;
	if (isRecord(collected)) {
		const currentShipping = collected.shipping_details;
		if (isRecord(currentShipping) && isExactNonEmptyString(currentShipping.name)) {
			return {
				name: currentShipping.name,
				address: normalizeShippingAddress(currentShipping.address)
			};
		}
	}

	const legacyShipping = session.shipping_details;
	if (isRecord(legacyShipping) && isExactNonEmptyString(legacyShipping.name)) {
		return { name: legacyShipping.name, address: normalizeShippingAddress(legacyShipping.address) };
	}
	fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
}

function addressesEqual(left: NormalizedAddress, right: NormalizedAddress): boolean {
	return (
		left.city === right.city &&
		left.country === right.country &&
		left.line1 === right.line1 &&
		left.line2 === right.line2 &&
		left.postalCode === right.postalCode &&
		left.state === right.state
	);
}

type NormalizedTaxId = {
	type: Stripe.Checkout.Session.CustomerDetails.TaxId.Type;
	value: string;
};

function normalizeTaxId(type: unknown, value: unknown): NormalizedTaxId {
	if (
		!isExactNonEmptyString(type) ||
		!SUPPORTED_TAX_ID_TYPE_SET.has(type) ||
		!isExactNonEmptyString(value)
	) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}
	return {
		type: type as Stripe.Checkout.Session.CustomerDetails.TaxId.Type,
		value
	};
}

function rejectDuplicateTaxIds(taxIds: NormalizedTaxId[]): void {
	const keys = new Set<string>();
	for (const taxId of taxIds) {
		const key = taxIdKey(taxId);
		if (keys.has(key)) fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
		keys.add(key);
	}
}

function validateTaxIds(value: unknown): NormalizedTaxId[] {
	if (value === null) return [];
	if (!Array.isArray(value)) fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	const taxIds = value.map((taxId) => {
		if (!isRecord(taxId)) {
			fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
		}
		return normalizeTaxId(taxId.type, taxId.value);
	});
	rejectDuplicateTaxIds(taxIds);
	return taxIds;
}

function taxIdKey(taxId: { type: string; value: string }): string {
	return `${taxId.type}\u0000${taxId.value}`;
}

function validateCustomer(session: UnknownRecord): {
	customerId: string;
	destinationCountry: string;
	taxExempt: TaxExempt;
} {
	const customer = session.customer;
	if (
		!isRecord(customer) ||
		customer.object !== 'customer' ||
		customer.deleted === true ||
		!isProviderId(customer.id, CUSTOMER_ID_PATTERN) ||
		!isExactNonEmptyString(customer.email) ||
		!isExactNonEmptyString(customer.name) ||
		!isExactNonEmptyString(customer.phone) ||
		!isRecord(customer.shipping) ||
		!isExactNonEmptyString(customer.shipping.name) ||
		!TAX_EXEMPT_VALUES.has(customer.tax_exempt as string)
	) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}

	const customerDetails = session.customer_details;
	if (
		!isRecord(customerDetails) ||
		!isExactNonEmptyString(customerDetails.email) ||
		!isExactNonEmptyString(customerDetails.name) ||
		!isExactNonEmptyString(customerDetails.phone) ||
		!TAX_EXEMPT_VALUES.has(customerDetails.tax_exempt as string) ||
		customerDetails.tax_exempt !== customer.tax_exempt ||
		customerDetails.email !== customer.email ||
		customerDetails.name !== customer.name ||
		customerDetails.phone !== customer.phone
	) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}
	validateTaxAddress(customerDetails.address);

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
		if (!isRecord(taxId) || taxId.object !== 'tax_id' || !isExactNonEmptyString(taxId.id)) {
			fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
		}
		return normalizeTaxId(taxId.type, taxId.value);
	});
	rejectDuplicateTaxIds(expandedTaxIds);
	if (
		JSON.stringify(sessionTaxIds.map(taxIdKey).sort()) !==
		JSON.stringify(expandedTaxIds.map(taxIdKey).sort())
	) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}
	if (
		customer.tax_exempt === 'reverse' &&
		!sessionTaxIds.some((taxId) => taxId.type === 'eu_vat')
	) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}

	const sessionShipping = shippingIdentity(session);
	const customerShippingAddress = normalizeShippingAddress(customer.shipping.address);
	const customerShippingPhone = customer.shipping.phone;
	if (
		customer.shipping.name !== sessionShipping.name ||
		(customerShippingPhone !== null &&
			customerShippingPhone !== undefined &&
			customerShippingPhone !== customerDetails.phone) ||
		!addressesEqual(customerShippingAddress, sessionShipping.address)
	) {
		fail('STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID');
	}
	const destinationCountry = sessionShipping.address.country;
	if (!isSupportedDestination(destinationCountry)) {
		fail('STRIPE_PAID_CHECKOUT_DESTINATION_INVALID');
	}
	return {
		customerId: customer.id,
		destinationCountry,
		taxExempt: customer.tax_exempt as TaxExempt
	};
}

type NormalizedLineDetails = {
	id: string;
	priceId: string;
	quantity: number;
	unitAmount: number;
	retailUnitAmount: number;
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
		value.price.unit_amount !== 2_000 ||
		value.price.tax_behavior !== 'exclusive' ||
		value.price.type !== 'one_time' ||
		value.price.recurring !== null
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
	const amountAfterDiscount = safeDifference(
		value.amount_subtotal,
		value.amount_discount,
		'STRIPE_PAID_CHECKOUT_LINES_INVALID'
	);
	if (
		value.amount_discount !== 0 ||
		value.amount_total !==
			safeSum([amountAfterDiscount, value.amount_tax], 'STRIPE_PAID_CHECKOUT_LINES_INVALID')
	) {
		fail('STRIPE_PAID_CHECKOUT_LINES_INVALID');
	}
	if (value.amount_total % value.quantity !== 0) {
		fail('STRIPE_PAID_CHECKOUT_LINES_INVALID');
	}

	return {
		id: value.id,
		priceId: value.price.id,
		quantity: value.quantity,
		unitAmount: value.price.unit_amount,
		retailUnitAmount: value.amount_total / value.quantity,
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
	expected: { customerId: string; metadata: CheckoutMetadata; total: number }
): { paymentIntentId: string; charge: UnknownRecord } {
	if (
		!isRecord(value) ||
		value.object !== 'payment_intent' ||
		!isProviderId(value.id, PAYMENT_INTENT_ID_PATTERN)
	) {
		fail('STRIPE_PAID_CHECKOUT_PAYMENT_INTENT_INVALID');
	}
	if (value.status !== 'succeeded') fail('STRIPE_PAID_CHECKOUT_PAYMENT_NOT_SETTLED');
	requireCurrency(value.currency);
	if (
		!isSafeNonNegativeInteger(value.amount) ||
		!isSafeNonNegativeInteger(value.amount_received) ||
		value.amount !== expected.total ||
		value.amount_received !== expected.total
	) {
		fail('STRIPE_PAID_CHECKOUT_TOTALS_INVALID');
	}
	if (referenceId(value.customer, CUSTOMER_ID_PATTERN) !== expected.customerId) {
		fail('STRIPE_PAID_CHECKOUT_PAYMENT_INTENT_INVALID');
	}
	validateMetadata(value.metadata, expected.metadata);

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
		typeof charge.refunded !== 'boolean' ||
		charge.refunded !== (charge.amount_refunded === charge.amount) ||
		referenceId(charge.payment_intent, PAYMENT_INTENT_ID_PATTERN) !== value.id ||
		referenceId(charge.customer, CUSTOMER_ID_PATTERN) !== expected.customerId
	) {
		fail('STRIPE_PAID_CHECKOUT_PAYMENT_INTENT_INVALID');
	}
	if (charge.status !== 'succeeded' || charge.captured !== true || charge.paid !== true) {
		fail('STRIPE_PAID_CHECKOUT_PAYMENT_NOT_SETTLED');
	}
	requireCurrency(charge.currency);
	return { paymentIntentId: value.id, charge };
}

function validateExclusiveShipping(value: UnknownRecord, expectedSubtotal: 0 | 800): void {
	const rate = value.shipping_rate;
	if (
		!isRecord(rate) ||
		rate.object !== 'shipping_rate' ||
		!isProviderId(rate.id, SHIPPING_RATE_ID_PATTERN) ||
		rate.type !== 'fixed_amount' ||
		rate.tax_behavior !== 'exclusive' ||
		!isRecord(rate.fixed_amount) ||
		rate.fixed_amount.amount !== expectedSubtotal ||
		rate.fixed_amount.currency !== 'eur'
	) {
		fail('STRIPE_PAID_CHECKOUT_TAX_INVALID');
	}
	const taxes = value.taxes === undefined && value.amount_tax === 0 ? [] : value.taxes;
	if (!Array.isArray(taxes)) fail('STRIPE_PAID_CHECKOUT_TAX_INVALID');
	const shippingTax = safeSum(
		taxes.map((tax) => {
			if (
				!isRecord(tax) ||
				!isSafeNonNegativeInteger(tax.amount) ||
				!isRecord(tax.rate) ||
				tax.rate.object !== 'tax_rate' ||
				!isProviderId(tax.rate.id, TAX_RATE_ID_PATTERN) ||
				tax.rate.inclusive !== false
			) {
				fail('STRIPE_PAID_CHECKOUT_TAX_INVALID');
			}
			return tax.amount;
		}),
		'STRIPE_PAID_CHECKOUT_TAX_INVALID'
	);
	if (
		shippingTax !== value.amount_tax ||
		value.amount_subtotal !== expectedSubtotal ||
		value.amount_total !==
			safeSum(
				[value.amount_subtotal as number, value.amount_tax as number],
				'STRIPE_PAID_CHECKOUT_TAX_INVALID'
			)
	) {
		fail('STRIPE_PAID_CHECKOUT_TAX_INVALID');
	}
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
	if (session.status !== 'complete') fail('STRIPE_PAID_CHECKOUT_PAYMENT_NOT_SETTLED');
	if (session.payment_status !== 'paid') fail('STRIPE_PAID_CHECKOUT_SESSION_UNPAID');
	requireCurrency(session.currency);

	const metadata = validateMetadata(session.metadata);
	if (session.client_reference_id !== metadata.draftId) fail('STRIPE_PAID_CHECKOUT_DRAFT_INVALID');
	const { customerId, destinationCountry, taxExempt } = validateCustomer(session);
	if (destinationCountry !== metadata.destinationCountry) {
		fail('STRIPE_PAID_CHECKOUT_DESTINATION_INVALID');
	}

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
		!isSafeNonNegativeInteger(session.shipping_cost.amount_total)
	) {
		fail('STRIPE_PAID_CHECKOUT_TOTALS_INVALID');
	}
	if (
		!isSafeNonNegativeInteger(session.total_details.amount_tax) ||
		!isSafeNonNegativeInteger(session.shipping_cost.amount_tax)
	) {
		fail('STRIPE_PAID_CHECKOUT_TAX_INVALID');
	}
	const unitCount = safeSum(
		lines.map((line) => line.quantity),
		'STRIPE_PAID_CHECKOUT_LINES_INVALID'
	);
	validateExclusiveShipping(session.shipping_cost, unitCount === 1 ? 800 : 0);

	// Stripe 2026-06-24.dahlia all-exclusive reconciliation.
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
	if (taxExempt !== 'none' && providerTax !== 0) {
		fail('STRIPE_PAID_CHECKOUT_TAX_INVALID');
	}
	const merchandiseTotal = safeSum(
		lines.map((line) => line.total),
		'STRIPE_PAID_CHECKOUT_TOTALS_INVALID'
	);
	const providerTotal = safeSum(
		[merchandiseTotal, session.shipping_cost.amount_total],
		'STRIPE_PAID_CHECKOUT_TOTALS_INVALID'
	);
	const sessionTotal = safeSum(
		[
			safeDifference(
				session.amount_subtotal,
				session.total_details.amount_discount,
				'STRIPE_PAID_CHECKOUT_TOTALS_INVALID'
			),
			providerTax,
			session.total_details.amount_shipping
		],
		'STRIPE_PAID_CHECKOUT_TOTALS_INVALID'
	);
	if (providerTax !== session.total_details.amount_tax) {
		fail('STRIPE_PAID_CHECKOUT_TAX_INVALID');
	}
	if (
		lineSubtotal !== session.amount_subtotal ||
		lineDiscount !== session.total_details.amount_discount ||
		session.shipping_cost.amount_subtotal !== session.total_details.amount_shipping ||
		providerTotal !== session.amount_total ||
		sessionTotal !== session.amount_total
	) {
		fail('STRIPE_PAID_CHECKOUT_TOTALS_INVALID');
	}

	const { paymentIntentId } = validatePaymentIntent(session.payment_intent, {
		customerId,
		metadata,
		total: session.amount_total
	});
	return {
		contractVersion: 2,
		checkoutSessionId: session.id,
		paymentIntentId,
		customerId,
		draftId: metadata.draftId,
		currency: 'eur',
		paymentStatus: 'paid',
		destinationCountry,
		amounts: {
			subtotal: session.amount_subtotal,
			discount: session.total_details.amount_discount,
			shipping: session.shipping_cost.amount_total,
			shippingTax: session.shipping_cost.amount_tax,
			tax: session.total_details.amount_tax,
			total: session.amount_total
		},
		lines: lines.map(({ priceId, quantity, unitAmount, retailUnitAmount }) => ({
			priceId,
			quantity,
			unitAmount,
			retailUnitAmount
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
		.map((line) => ({
			priceId: line.priceId,
			quantity: line.quantity,
			unitAmount: line.unitAmount
		}))
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

function hasValidPaidAmountBounds(amounts: PaidCheckoutSnapshot['amounts']): boolean {
	if (!Object.values(amounts).every(isSafeNonNegativeInteger)) return false;
	const merchandiseTax = BigInt(amounts.tax) - BigInt(amounts.shippingTax);
	const expectedTotal =
		BigInt(amounts.subtotal) - BigInt(amounts.discount) + merchandiseTax + BigInt(amounts.shipping);
	return (
		amounts.discount <= amounts.subtotal &&
		merchandiseTax >= 0n &&
		amounts.shippingTax <= amounts.shipping &&
		expectedTotal === BigInt(amounts.total)
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
		draft.contractVersion !== CHECKOUT_CONTRACT_VERSION ||
		paid.contractVersion !== CHECKOUT_CONTRACT_VERSION
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
		!paid.lines.every(
			(line) => isComparableLine(line) && isSafeNonNegativeInteger(line.retailUnitAmount)
		) ||
		JSON.stringify(canonicalLines(draftLines)) !== JSON.stringify(canonicalLines(paid.lines))
	) {
		comparisonFail('PAID_CHECKOUT_LINES_MISMATCH');
	}

	const paidUnitCount = paid.lines.reduce((total, line) => total + line.quantity, 0);
	if (!Number.isSafeInteger(paidUnitCount) || paidUnitCount !== draft.totalUnitCount) {
		comparisonFail('PAID_CHECKOUT_UNIT_COUNT_MISMATCH');
	}
	const netShipping = paid.amounts.shipping - paid.amounts.shippingTax;
	if (
		!Number.isSafeInteger(netShipping) ||
		netShipping < 0 ||
		netShipping !== (draft.shippingMode === 'paid' ? PAID_SHIPPING_AMOUNT : 0)
	) {
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
	const retailTotal = paid.lines.reduce(
		(total, line) => total + BigInt(line.retailUnitAmount) * BigInt(line.quantity),
		0n
	);
	const merchandiseTax = BigInt(paid.amounts.tax) - BigInt(paid.amounts.shippingTax);
	if (
		paid.lines.some((line) => line.retailUnitAmount < line.unitAmount) ||
		merchandiseTax < 0n ||
		retailTotal !== BigInt(paid.amounts.subtotal) + merchandiseTax
	) {
		comparisonFail('PAID_CHECKOUT_LINES_MISMATCH');
	}
	if (
		paid.paymentStatus !== 'paid' ||
		paid.destinationCountry !== draft.destinationCountry ||
		!isSupportedDestination(paid.destinationCountry) ||
		!isProviderId(paid.paymentIntentId, PAYMENT_INTENT_ID_PATTERN) ||
		!isProviderId(paid.customerId, CUSTOMER_ID_PATTERN) ||
		!hasValidPaidAmountBounds(paid.amounts)
	) {
		comparisonFail('PAID_CHECKOUT_TOTALS_MISMATCH');
	}
}
