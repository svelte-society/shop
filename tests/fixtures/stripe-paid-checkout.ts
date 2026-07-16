import type Stripe from 'stripe';

export type StripeFixtureAddress = Stripe.Address;

export type StripeFixtureTaxId = Omit<
	Pick<Stripe.Checkout.Session.CustomerDetails.TaxId, 'type' | 'value'>,
	'value'
> & { value: string };

type StripeFixtureExpandedTaxId = Pick<Stripe.TaxId, 'id' | 'object' | 'type' | 'value'>;
type StripeFixtureCustomerShipping = Required<
	Pick<Stripe.Customer.Shipping, 'address' | 'name' | 'phone'>
>;

export type StripeFixtureListPage<T> = Pick<
	Stripe.ApiList<T>,
	'object' | 'data' | 'has_more' | 'url'
>;

export type StripeFixtureCustomer = Omit<
	Required<
		Pick<Stripe.Customer, 'id' | 'object' | 'email' | 'name' | 'phone' | 'shipping' | 'tax_exempt'>
	>,
	'shipping'
> & {
	shipping: StripeFixtureCustomerShipping | null;
	tax_ids: StripeFixtureListPage<StripeFixtureExpandedTaxId>;
};

export type StripeFixtureCharge = Omit<
	Pick<
		Stripe.Charge,
		| 'id'
		| 'object'
		| 'amount'
		| 'amount_captured'
		| 'amount_refunded'
		| 'captured'
		| 'currency'
		| 'customer'
		| 'paid'
		| 'payment_intent'
		| 'refunded'
		| 'status'
	>,
	'customer' | 'payment_intent'
> & {
	customer: string | null;
	payment_intent: string | null;
};

export type StripeFixturePaymentIntent = Omit<
	Pick<
		Stripe.PaymentIntent,
		| 'id'
		| 'object'
		| 'amount'
		| 'amount_received'
		| 'currency'
		| 'customer'
		| 'latest_charge'
		| 'metadata'
		| 'status'
	>,
	'customer' | 'latest_charge'
> & {
	customer: string | null;
	latest_charge: StripeFixtureCharge | string | null;
};

type StripeFixturePrice = Pick<Stripe.Price, 'id' | 'object' | 'currency' | 'unit_amount'>;

export type StripeFixtureLineItem = Omit<
	Pick<
		Stripe.LineItem,
		| 'id'
		| 'object'
		| 'amount_discount'
		| 'amount_subtotal'
		| 'amount_tax'
		| 'amount_total'
		| 'currency'
		| 'price'
		| 'quantity'
	>,
	'price'
> & { price: StripeFixturePrice | null };

type StripeFixtureCustomerDetails = Omit<
	Pick<
		Stripe.Checkout.Session.CustomerDetails,
		| 'address'
		| 'business_name'
		| 'email'
		| 'individual_name'
		| 'name'
		| 'phone'
		| 'tax_exempt'
		| 'tax_ids'
	>,
	'tax_ids'
> & { tax_ids: StripeFixtureTaxId[] | null };

type StripeFixtureShippingDetails = Stripe.Checkout.Session.CollectedInformation.ShippingDetails;
type StripeFixtureSessionCore = Pick<
	Stripe.Checkout.Session,
	| 'id'
	| 'object'
	| 'amount_subtotal'
	| 'amount_total'
	| 'automatic_tax'
	| 'client_reference_id'
	| 'collected_information'
	| 'currency'
	| 'customer'
	| 'customer_details'
	| 'metadata'
	| 'mode'
	| 'payment_intent'
	| 'payment_status'
	| 'shipping_cost'
	| 'status'
	| 'total_details'
>;

export type StripeFixtureCheckoutSession = Omit<
	StripeFixtureSessionCore,
	| 'automatic_tax'
	| 'customer'
	| 'customer_details'
	| 'payment_intent'
	| 'shipping_cost'
	| 'total_details'
> & {
	automatic_tax: Pick<Stripe.Checkout.Session.AutomaticTax, 'enabled' | 'status'>;
	customer: StripeFixtureCustomer | string | null;
	customer_details: StripeFixtureCustomerDetails | null;
	payment_intent: StripeFixturePaymentIntent | string | null;
	shipping_cost: Pick<
		Stripe.Checkout.Session.ShippingCost,
		'amount_subtotal' | 'amount_tax' | 'amount_total' | 'shipping_rate'
	> | null;
	total_details: Pick<
		Stripe.Checkout.Session.TotalDetails,
		'amount_discount' | 'amount_shipping' | 'amount_tax'
	> | null;
	shipping_details?: StripeFixtureShippingDetails | null;
};

export type PaidCheckoutFixtureLine = {
	id: string;
	priceId: string;
	quantity: number;
	unitAmount: number;
	taxAmount: number;
	discountAmount?: number;
};

export type PaidCheckoutProviderFixture = {
	session: StripeFixtureCheckoutSession;
	linePages: Array<StripeFixtureListPage<StripeFixtureLineItem>>;
	refundPaymentIntent: StripeFixturePaymentIntent;
};

export type PaidCheckoutFixtureOptions = {
	sessionId?: string;
	paymentIntentId?: string;
	customerId?: string;
	draftId?: string;
	country?: string;
	shippingAmount?: number;
	shippingTaxAmount?: number;
	lines?: PaidCheckoutFixtureLine[];
	taxExempt?: 'none' | 'exempt' | 'reverse';
	taxIds?: StripeFixtureTaxId[];
};

const defaultAddress = (country: string): StripeFixtureAddress => ({
	city: country === 'US' ? 'New York' : 'Stockholm',
	country,
	line1: '123 Provider Fixture Street',
	line2: null,
	postal_code: country === 'US' ? '10001' : '111 22',
	state: country === 'US' ? 'NY' : null
});

export function stripeLineItem(
	line: PaidCheckoutFixtureLine,
	currency = 'eur'
): StripeFixtureLineItem {
	const amountSubtotal = line.unitAmount * line.quantity;
	const amountDiscount = line.discountAmount ?? 0;
	return {
		id: line.id,
		object: 'item',
		amount_discount: amountDiscount,
		amount_subtotal: amountSubtotal,
		amount_tax: line.taxAmount,
		amount_total: amountSubtotal - amountDiscount + line.taxAmount,
		currency,
		price: {
			id: line.priceId,
			object: 'price',
			currency,
			unit_amount: line.unitAmount
		},
		quantity: line.quantity
	};
}

export function reconcilePaidCheckoutProviderTotals(fixture: PaidCheckoutProviderFixture): void {
	const lines = fixture.linePages.flatMap((page) => page.data);
	const shipping = fixture.session.shipping_cost;
	const details = fixture.session.total_details;
	const paymentIntent = fixture.session.payment_intent;
	if (!shipping || !details || typeof paymentIntent !== 'object' || !paymentIntent) {
		throw new Error('Fixture cannot be reconciled without expanded totals');
	}

	fixture.session.amount_subtotal = lines.reduce((total, line) => total + line.amount_subtotal, 0);
	details.amount_discount = lines.reduce((total, line) => total + line.amount_discount, 0);
	details.amount_shipping = shipping.amount_subtotal;
	details.amount_tax =
		lines.reduce((total, line) => total + line.amount_tax, 0) + shipping.amount_tax;
	fixture.session.amount_total =
		lines.reduce((total, line) => total + line.amount_total, 0) + shipping.amount_total;
	paymentIntent.amount = fixture.session.amount_total;
	paymentIntent.amount_received = fixture.session.amount_total;
	const charge = paymentIntent.latest_charge;
	if (typeof charge !== 'object' || !charge) {
		throw new Error('Fixture cannot be reconciled without an expanded Charge');
	}
	charge.amount = fixture.session.amount_total;
	charge.amount_captured = fixture.session.amount_total;
}

export function stripeLinePage(
	data: StripeFixtureLineItem[],
	hasMore = false
): StripeFixtureListPage<StripeFixtureLineItem> {
	return {
		object: 'list',
		data,
		has_more: hasMore,
		url: '/v1/checkout/sessions/cs_test_paid/line_items'
	};
}

export function paidCheckoutProviderFixture(
	options: PaidCheckoutFixtureOptions = {}
): PaidCheckoutProviderFixture {
	const sessionId = options.sessionId ?? 'cs_test_paid';
	const paymentIntentId = options.paymentIntentId ?? 'pi_test_paid';
	const customerId = options.customerId ?? 'cus_test_paid';
	const draftId = options.draftId ?? 'draft-paid-123';
	const country = options.country ?? 'SE';
	const shippingAmount = options.shippingAmount ?? 1_000;
	const shippingTaxAmount =
		options.shippingTaxAmount ?? (country === 'US' || shippingAmount === 0 ? 0 : 200);
	const shippingSubtotal = shippingAmount - shippingTaxAmount;
	const lines = options.lines ?? [
		{
			id: 'li_tee_medium',
			priceId: 'price_tee_medium',
			quantity: 1,
			unitAmount: 2_000,
			taxAmount: country === 'US' ? 0 : 500
		}
	];
	const taxExempt = options.taxExempt ?? 'none';
	const taxIds = options.taxIds ?? [];
	const address = defaultAddress(country);
	const providerLines = lines.map((line) => stripeLineItem(line));
	const amountSubtotal = providerLines.reduce((total, line) => total + line.amount_subtotal, 0);
	const amountDiscount = providerLines.reduce((total, line) => total + line.amount_discount, 0);
	const amountTax =
		providerLines.reduce((total, line) => total + line.amount_tax, 0) + shippingTaxAmount;
	const amountTotal =
		providerLines.reduce((total, line) => total + line.amount_total, 0) + shippingAmount;
	const metadata = {
		product_type: 'merch',
		checkout_contract_version: '1',
		checkout_draft_id: draftId
	};
	const charge: StripeFixtureCharge = {
		id: 'ch_test_paid',
		object: 'charge',
		amount: amountTotal,
		amount_captured: amountTotal,
		amount_refunded: 0,
		captured: true,
		currency: 'eur',
		customer: customerId,
		paid: true,
		payment_intent: paymentIntentId,
		refunded: false,
		status: 'succeeded'
	};
	const paymentIntent: StripeFixturePaymentIntent = {
		id: paymentIntentId,
		object: 'payment_intent',
		amount: amountTotal,
		amount_received: amountTotal,
		currency: 'eur',
		customer: customerId,
		latest_charge: charge,
		metadata,
		status: 'succeeded'
	};
	const customerTaxIds = taxIds.map((taxId, index) => ({
		id: `txi_fixture_${index}`,
		object: 'tax_id' as const,
		type: taxId.type,
		value: taxId.value
	}));
	const customer: StripeFixtureCustomer = {
		id: customerId,
		object: 'customer',
		email: 'fixture.customer@example.test',
		name: 'Fixture Customer',
		phone: '+46701234567',
		shipping: { address, name: 'Fixture Customer', phone: '+46701234567' },
		tax_exempt: taxExempt,
		tax_ids: {
			object: 'list',
			data: customerTaxIds,
			has_more: false,
			url: `/v1/customers/${customerId}/tax_ids`
		}
	};

	return {
		session: {
			id: sessionId,
			object: 'checkout.session',
			amount_subtotal: amountSubtotal,
			amount_total: amountTotal,
			automatic_tax: { enabled: true, status: 'complete' },
			client_reference_id: draftId,
			collected_information: {
				business_name: null,
				individual_name: 'Fixture Customer',
				shipping_details: { address, name: 'Fixture Customer' }
			},
			currency: 'eur',
			customer,
			customer_details: {
				address,
				business_name: null,
				email: 'fixture.customer@example.test',
				individual_name: 'Fixture Customer',
				name: 'Fixture Customer',
				phone: '+46701234567',
				tax_exempt: taxExempt,
				tax_ids: taxIds
			},
			metadata,
			mode: 'payment',
			payment_intent: paymentIntent,
			payment_status: 'paid',
			shipping_cost: {
				amount_subtotal: shippingSubtotal,
				amount_tax: shippingTaxAmount,
				amount_total: shippingAmount,
				shipping_rate: shippingAmount === 0 ? 'shr_free' : 'shr_paid_10_eur'
			},
			status: 'complete',
			total_details: {
				amount_discount: amountDiscount,
				amount_shipping: shippingSubtotal,
				amount_tax: amountTax
			}
		},
		linePages: [stripeLinePage(providerLines)],
		refundPaymentIntent: structuredClone(paymentIntent)
	};
}
