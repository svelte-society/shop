export type StripeFixtureAddress = {
	city: string | null;
	country: string | null;
	line1: string | null;
	line2: string | null;
	postal_code: string | null;
	state: string | null;
};

export type StripeFixtureTaxId = {
	type: string;
	value: string;
};

export type StripeFixtureCustomer = {
	id: string;
	object: 'customer';
	deleted?: true;
	phone: string | null;
	shipping: {
		address: StripeFixtureAddress;
		name: string;
		phone: string | null;
	} | null;
	tax_exempt: 'none' | 'exempt' | 'reverse' | null;
	tax_ids: {
		object: 'list';
		data: Array<{ id: string; object: 'tax_id'; type: string; value: string }>;
		has_more: boolean;
		url: string;
	};
};

export type StripeFixtureCharge = {
	id: string;
	object: 'charge';
	amount: number;
	amount_captured: number;
	amount_refunded: number;
	captured: boolean;
	currency: string;
	customer: string | null;
	paid: boolean;
	payment_intent: string | null;
	refunded: boolean;
	status: 'failed' | 'pending' | 'succeeded';
};

export type StripeFixturePaymentIntent = {
	id: string;
	object: 'payment_intent';
	amount: number;
	amount_received: number;
	currency: string;
	customer: string | null;
	latest_charge: StripeFixtureCharge | string | null;
	metadata: Record<string, string>;
	status:
		| 'canceled'
		| 'processing'
		| 'requires_action'
		| 'requires_capture'
		| 'requires_confirmation'
		| 'requires_payment_method'
		| 'succeeded';
};

export type StripeFixtureLineItem = {
	id: string;
	object: 'item';
	amount_discount: number;
	amount_subtotal: number;
	amount_tax: number;
	amount_total: number;
	currency: string;
	price: {
		id: string;
		object: 'price';
		currency: string;
		unit_amount: number | null;
	} | null;
	quantity: number | null;
};

export type StripeFixtureListPage<T> = {
	object: 'list';
	data: T[];
	has_more: boolean;
	url: string;
};

export type StripeFixtureCheckoutSession = {
	id: string;
	object: 'checkout.session';
	amount_subtotal: number | null;
	amount_total: number | null;
	automatic_tax: {
		enabled: boolean;
		status: 'complete' | 'failed' | 'requires_location_inputs' | null;
	};
	client_reference_id: string | null;
	collected_information: {
		business_name: string | null;
		individual_name: string | null;
		shipping_details: {
			address: StripeFixtureAddress;
			name: string;
		} | null;
	} | null;
	currency: string | null;
	customer: StripeFixtureCustomer | string | null;
	customer_details: {
		address: StripeFixtureAddress | null;
		business_name: string | null;
		email: string | null;
		individual_name: string | null;
		name: string | null;
		phone: string | null;
		tax_exempt: 'none' | 'exempt' | 'reverse' | null;
		tax_ids: StripeFixtureTaxId[] | null;
	} | null;
	metadata: Record<string, string> | null;
	mode: 'payment' | 'setup' | 'subscription';
	payment_intent: StripeFixturePaymentIntent | string | null;
	payment_status: 'no_payment_required' | 'paid' | 'unpaid';
	shipping_cost: {
		amount_subtotal: number;
		amount_tax: number;
		amount_total: number;
		shipping_rate: string | null;
	} | null;
	status: 'complete' | 'expired' | 'open' | null;
	total_details: {
		amount_discount: number;
		amount_shipping: number | null;
		amount_tax: number;
	} | null;
	shipping_details?: {
		address: StripeFixtureAddress;
		name: string;
	} | null;
};

export type PaidCheckoutFixtureLine = {
	id: string;
	priceId: string;
	quantity: number;
	unitAmount: number;
	taxAmount: number;
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
	return {
		id: line.id,
		object: 'item',
		amount_discount: 0,
		amount_subtotal: amountSubtotal,
		amount_tax: line.taxAmount,
		amount_total: amountSubtotal + line.taxAmount,
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
				amount_subtotal: shippingAmount,
				amount_tax: shippingTaxAmount,
				amount_total: shippingAmount,
				shipping_rate: shippingAmount === 0 ? 'shr_free' : 'shr_paid_10_eur'
			},
			status: 'complete',
			total_details: {
				amount_discount: amountDiscount,
				amount_shipping: shippingAmount,
				amount_tax: amountTax
			}
		},
		linePages: [stripeLinePage(providerLines)],
		refundPaymentIntent: structuredClone(paymentIntent)
	};
}
