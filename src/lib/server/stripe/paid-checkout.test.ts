import { describe, expect, it, vi } from 'vitest';
import type { MarketDestination } from '$lib/domain/destinations';
import type { CheckoutDraftWithLines } from '$lib/domain/orders';
import type { PaidCheckoutSnapshot } from './gateway';
import {
	comparePaidCheckout,
	createStripeOrderGateway,
	type StripeOrderClient
} from './paid-checkout';
import {
	paidCheckoutProviderFixture,
	reconcilePaidCheckoutProviderTotals,
	stripeLinePage,
	type PaidCheckoutProviderFixture,
	type StripeFixtureCheckoutSession,
	type StripeFixtureCustomer,
	type StripeFixturePaymentIntent
} from '../../../../tests/fixtures/stripe-paid-checkout';

type SessionRetrieveCall = { id: string; params: { expand?: string[] } | undefined };
type LineItemsCall = {
	id: string;
	params: { limit?: number; expand?: string[]; starting_after?: string } | undefined;
};
type PaymentIntentRetrieveCall = { id: string; params: { expand?: string[] } | undefined };

class ContractStripeClient implements StripeOrderClient {
	readonly sessionRetrieveCalls: SessionRetrieveCall[] = [];
	readonly lineItemsCalls: LineItemsCall[] = [];
	readonly paymentIntentRetrieveCalls: PaymentIntentRetrieveCall[] = [];
	sessionFailure: unknown;
	lineItemsFailure: unknown;
	paymentIntentFailure: unknown;

	readonly checkout: StripeOrderClient['checkout'];
	readonly paymentIntents: StripeOrderClient['paymentIntents'];

	constructor(readonly fixture: PaidCheckoutProviderFixture) {
		this.checkout = {
			sessions: {
				retrieve: async (id, params) => {
					this.sessionRetrieveCalls.push({ id, params: structuredClone(params) });
					if (this.sessionFailure) throw this.sessionFailure;
					return structuredClone(this.fixture.session);
				},
				listLineItems: async (id, params) => {
					this.lineItemsCalls.push({ id, params: structuredClone(params) });
					if (this.lineItemsFailure) throw this.lineItemsFailure;
					const page = this.fixture.linePages[this.lineItemsCalls.length - 1];
					return structuredClone(page);
				}
			}
		};
		this.paymentIntents = {
			retrieve: async (id, params) => {
				this.paymentIntentRetrieveCalls.push({ id, params: structuredClone(params) });
				if (this.paymentIntentFailure) throw this.paymentIntentFailure;
				return structuredClone(this.fixture.refundPaymentIntent);
			}
		};
	}
}

function checkoutDraft(
	options: {
		id?: string;
		checkoutSessionId?: string | null;
		shippingMode?: 'paid' | 'free';
		totalUnitCount?: number;
		lines?: Array<{ priceId: string; quantity: number; unitAmount: number }>;
	} = {}
): CheckoutDraftWithLines {
	const lines = options.lines ?? [{ priceId: 'price_tee_medium', quantity: 1, unitAmount: 2_000 }];
	const totalUnitCount =
		options.totalUnitCount ?? lines.reduce((total, line) => total + line.quantity, 0);
	return {
		id: options.id ?? 'draft-paid-123',
		checkoutSessionId:
			options.checkoutSessionId === undefined ? 'cs_test_paid' : options.checkoutSessionId,
		contractVersion: 2,
		destinationCountry: 'SE',
		currency: 'eur',
		totalUnitCount,
		shippingMode: options.shippingMode ?? (totalUnitCount === 1 ? 'paid' : 'free'),
		createdAt: new Date('2026-07-16T10:00:00.000Z'),
		expiresAt: new Date('2026-07-17T10:00:00.000Z'),
		completedAt: null,
		lines: lines.map((line, lineIndex) => ({
			lineIndex,
			stripeProductId: `prod_fixture_${lineIndex}`,
			stripePriceId: line.priceId,
			productName: `Fixture product ${lineIndex}`,
			variantLabel: `Variant ${lineIndex}`,
			sku: `SKU-${lineIndex}`,
			styriaProductNumber: `STYRIA-${lineIndex}`,
			designReference: `design-${lineIndex}`,
			designPlacements: { front: `https://cdn.example.test/design-${lineIndex}.svg` },
			quantity: line.quantity,
			unitAmount: line.unitAmount,
			currency: 'eur'
		}))
	};
}

async function expectStableCode(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toMatchObject({ name: 'PaidCheckoutError', message: code, code });
}

function expectComparisonCode(run: () => void, code: string): void {
	expect(run).toThrowError(
		expect.objectContaining({
			name: 'PaidCheckoutComparisonError',
			message: code,
			code
		})
	);
}

async function normalizedSnapshot(
	fixture = paidCheckoutProviderFixture()
): Promise<{ snapshot: PaidCheckoutSnapshot; client: ContractStripeClient }> {
	const client = new ContractStripeClient(fixture);
	const snapshot = await createStripeOrderGateway(client).retrievePaidCheckout(fixture.session.id);
	return { snapshot, client };
}

function expandedCustomer(fixture: PaidCheckoutProviderFixture): StripeFixtureCustomer {
	const customer = fixture.session.customer;
	if (typeof customer !== 'object' || !customer)
		throw new Error('Expected expanded fixture Customer');
	return customer;
}

describe('Stripe paid Checkout normalization', () => {
	it('normalizes a complete paid EU Checkout without retaining customer data', async () => {
		const { snapshot, client } = await normalizedSnapshot();

		expect(snapshot).toEqual({
			contractVersion: 2,
			checkoutSessionId: 'cs_test_paid',
			paymentIntentId: 'pi_test_paid',
			customerId: 'cus_test_paid',
			draftId: 'draft-paid-123',
			currency: 'eur',
			paymentStatus: 'paid',
			destinationCountry: 'SE',
			amounts: {
				subtotal: 2_000,
				discount: 0,
				shipping: 1_000,
				shippingTax: 200,
				tax: 700,
				total: 3_500
			},
			lines: [
				{
					priceId: 'price_tee_medium',
					quantity: 1,
					unitAmount: 2_000,
					retailUnitAmount: 2_500
				}
			]
		});
		expect(JSON.stringify(snapshot)).not.toMatch(
			/Fixture Customer|fixture\.customer@example\.test|Provider Fixture Street|\+4670/
		);
		expect(client.sessionRetrieveCalls).toEqual([
			{
				id: 'cs_test_paid',
				params: {
					expand: [
						'customer',
						'customer.tax_ids',
						'payment_intent',
						'payment_intent.latest_charge',
						'shipping_cost.shipping_rate',
						'shipping_cost.taxes'
					]
				}
			}
		]);
		expect(client.lineItemsCalls).toEqual([
			{
				id: 'cs_test_paid',
				params: { limit: 100, expand: ['data.price'] }
			}
		]);
	});

	it('accepts an absent Customer shipping phone when Checkout customer phone copies agree', async () => {
		const fixture = paidCheckoutProviderFixture();
		const customer = expandedCustomer(fixture);
		if (!customer.shipping) throw new Error();
		customer.shipping.phone = null;

		await expect(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			)
		).resolves.toMatchObject({ customerId: customer.id, destinationCountry: 'SE' });
	});

	it('rejects a US Checkout because it is outside the source-controlled policy', async () => {
		const fixture = paidCheckoutProviderFixture({ country: 'US' });

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_DESTINATION_INVALID'
		);
	});

	it('accepts reverse-charge tax details without comparing tax to a Swedish display price', async () => {
		const fixture = paidCheckoutProviderFixture({
			taxExempt: 'reverse',
			taxIds: [{ type: 'eu_vat', value: 'SE123456789001' }],
			lines: [
				{
					id: 'li_reverse_charge',
					priceId: 'price_tee_medium',
					quantity: 1,
					unitAmount: 2_000,
					taxAmount: 0
				}
			],
			shippingTaxAmount: 0
		});

		await expect(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			)
		).resolves.toMatchObject({ amounts: { tax: 0, total: 2_800 } });
	});

	it('accepts an exempt customer only when merchandise and shipping tax are both zero', async () => {
		const fixture = paidCheckoutProviderFixture({
			taxExempt: 'exempt',
			lines: [
				{
					id: 'li_exempt',
					priceId: 'price_tee_medium',
					quantity: 1,
					unitAmount: 2_000,
					taxAmount: 0
				}
			],
			shippingTaxAmount: 0
		});

		await expect(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			)
		).resolves.toMatchObject({ amounts: { tax: 0, total: 2_800 } });
	});

	it.each([
		['exempt', []],
		['reverse', [{ type: 'eu_vat' as const, value: 'SE123456789001' }]]
	] as const)('rejects positive provider tax for a %s customer', async (taxExempt, taxIds) => {
		const fixture = paidCheckoutProviderFixture({ taxExempt, taxIds: [...taxIds] });

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_TAX_INVALID'
		);
	});

	it.each([
		[
			'an invented tax-ID type',
			{
				taxExempt: 'none' as const,
				taxIds: [{ type: 'invented_tax_id', value: 'NOT-A-REAL-TYPE' }]
			}
		],
		[
			'an empty tax-ID value',
			{ taxExempt: 'none' as const, taxIds: [{ type: 'eu_vat', value: '' }] }
		],
		[
			'a duplicate tax-ID entry',
			{
				taxExempt: 'none' as const,
				taxIds: [
					{ type: 'eu_vat', value: 'SE123456789001' },
					{ type: 'eu_vat', value: 'SE123456789001' }
				]
			}
		],
		['reverse charge without a tax ID', { taxExempt: 'reverse' as const, taxIds: [] }],
		[
			'reverse charge without an EU VAT ID',
			{
				taxExempt: 'reverse' as const,
				taxIds: [{ type: 'us_ein', value: '12-3456789' }]
			}
		]
	])('rejects %s', async (_label, options) => {
		// This table deliberately includes one provider value outside Stripe's installed type union.
		const fixture = paidCheckoutProviderFixture(
			options as Parameters<typeof paidCheckoutProviderFixture>[0]
		);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID'
		);
	});

	it('rejects mismatched normal and reverse tax-exemption semantics', async () => {
		const fixture = paidCheckoutProviderFixture();
		expandedCustomer(fixture).tax_exempt = 'reverse';

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID'
		);
	});

	it('rejects conflicting Session and expanded Customer tax-ID lists', async () => {
		const fixture = paidCheckoutProviderFixture({
			taxIds: [{ type: 'eu_vat', value: 'SE123456789001' }]
		});
		expandedCustomer(fixture).tax_ids.data = [];

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID'
		);
	});

	it('normalizes the legacy shipping_details field only at the provider boundary', async () => {
		const fixture = paidCheckoutProviderFixture();
		const shippingDetails = fixture.session.collected_information?.shipping_details;
		fixture.session.collected_information = null;
		fixture.session.shipping_details = shippingDetails;

		await expect(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			)
		).resolves.toMatchObject({ destinationCountry: 'SE' });
	});

	it('retrieves every line-item page in provider order', async () => {
		const fixture = paidCheckoutProviderFixture({
			shippingSubtotal: 0,
			shippingTaxAmount: 0,
			lines: [
				{
					id: 'li_accessory',
					priceId: 'price_accessory',
					quantity: 1,
					unitAmount: 2_000,
					taxAmount: 500
				},
				{
					id: 'li_tee',
					priceId: 'price_tee_medium',
					quantity: 2,
					unitAmount: 2_000,
					taxAmount: 1_000
				}
			]
		});
		const lines = fixture.linePages[0].data;
		fixture.linePages = [stripeLinePage([lines[0]], true), stripeLinePage([lines[1]])];

		const { snapshot, client } = await normalizedSnapshot(fixture);

		expect(snapshot.lines).toEqual([
			{
				priceId: 'price_accessory',
				quantity: 1,
				unitAmount: 2_000,
				retailUnitAmount: 2_500
			},
			{
				priceId: 'price_tee_medium',
				quantity: 2,
				unitAmount: 2_000,
				retailUnitAmount: 2_500
			}
		]);
		expect(client.lineItemsCalls).toEqual([
			{
				id: 'cs_test_paid',
				params: { limit: 100, expand: ['data.price'] }
			},
			{
				id: 'cs_test_paid',
				params: {
					limit: 100,
					expand: ['data.price'],
					starting_after: 'li_accessory'
				}
			}
		]);
	});

	it.each([
		[
			'complete unpaid Session',
			(session: StripeFixtureCheckoutSession) => (session.payment_status = 'unpaid'),
			'STRIPE_PAID_CHECKOUT_SESSION_UNPAID'
		],
		[
			'open paid Session',
			(session: StripeFixtureCheckoutSession) => (session.status = 'open'),
			'STRIPE_PAID_CHECKOUT_PAYMENT_NOT_SETTLED'
		],
		[
			'open unpaid Session',
			(session: StripeFixtureCheckoutSession) => {
				session.status = 'open';
				session.payment_status = 'unpaid';
			},
			'STRIPE_PAID_CHECKOUT_PAYMENT_NOT_SETTLED'
		]
	])('classifies a %s with status precedence', async (_label, mutate, code) => {
		const fixture = paidCheckoutProviderFixture();
		mutate(fixture.session);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			code
		);
	});

	it.each([
		[
			'processing PaymentIntent',
			(session: StripeFixtureCheckoutSession) => {
				(session.payment_intent as StripeFixturePaymentIntent).status = 'processing';
			}
		],
		[
			'pending Charge',
			(session: StripeFixtureCheckoutSession) => {
				const paymentIntent = session.payment_intent as StripeFixturePaymentIntent;
				if (typeof paymentIntent.latest_charge !== 'object' || !paymentIntent.latest_charge)
					throw new Error();
				paymentIntent.latest_charge.status = 'pending';
			}
		],
		[
			'uncaptured Charge',
			(session: StripeFixtureCheckoutSession) => {
				const paymentIntent = session.payment_intent as StripeFixturePaymentIntent;
				if (typeof paymentIntent.latest_charge !== 'object' || !paymentIntent.latest_charge)
					throw new Error();
				paymentIntent.latest_charge.captured = false;
			}
		],
		[
			'unpaid Charge',
			(session: StripeFixtureCheckoutSession) => {
				const paymentIntent = session.payment_intent as StripeFixturePaymentIntent;
				if (typeof paymentIntent.latest_charge !== 'object' || !paymentIntent.latest_charge)
					throw new Error();
				paymentIntent.latest_charge.paid = false;
			}
		]
	])('classifies an %s as unsettled and retryable', async (_label, mutate) => {
		const fixture = paidCheckoutProviderFixture();
		mutate(fixture.session);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_PAYMENT_NOT_SETTLED'
		);
	});

	it.each([
		[
			'Session',
			(session: StripeFixtureCheckoutSession) => {
				session.currency = 'usd';
			}
		],
		[
			'line item',
			(_session: StripeFixtureCheckoutSession, fixture: PaidCheckoutProviderFixture) => {
				fixture.linePages[0].data[0].currency = 'usd';
			}
		],
		[
			'Price',
			(_session: StripeFixtureCheckoutSession, fixture: PaidCheckoutProviderFixture) => {
				const price = fixture.linePages[0].data[0].price;
				if (price) price.currency = 'usd';
			}
		],
		[
			'PaymentIntent',
			(session: StripeFixtureCheckoutSession) => {
				(session.payment_intent as StripeFixturePaymentIntent).currency = 'usd';
			}
		]
	])('rejects non-EUR currency on the %s', async (_label, mutate) => {
		const fixture = paidCheckoutProviderFixture();
		mutate(fixture.session, fixture);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_CURRENCY_INVALID'
		);
	});

	it.each([
		[
			'missing Customer',
			(session: StripeFixtureCheckoutSession) => {
				session.customer = null;
			}
		],
		[
			'unexpanded Customer',
			(session: StripeFixtureCheckoutSession) => {
				session.customer = 'cus_test_paid';
			}
		],
		[
			'missing shipping address',
			(session: StripeFixtureCheckoutSession) => {
				if (session.collected_information) session.collected_information.shipping_details = null;
				session.shipping_details = null;
			}
		],
		[
			'missing phone',
			(session: StripeFixtureCheckoutSession) => {
				if (session.customer_details) session.customer_details.phone = null;
			}
		],
		[
			'unexpanded customer tax details',
			(session: StripeFixtureCheckoutSession) => {
				if (typeof session.customer === 'object' && session.customer) {
					session.customer.tax_ids = undefined as never;
				}
			}
		]
	])('rejects %s', async (_label, mutate) => {
		const fixture = paidCheckoutProviderFixture();
		mutate(fixture.session);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID'
		);
	});

	it.each([
		[
			'missing recipient name',
			(fixture: PaidCheckoutProviderFixture) => {
				const customer = expandedCustomer(fixture);
				if (!customer.shipping || !fixture.session.customer_details) throw new Error();
				const shipping = fixture.session.collected_information?.shipping_details;
				if (!shipping) throw new Error();
				shipping.name = '';
				customer.shipping.name = '';
				customer.name = '';
				fixture.session.customer_details.name = '';
			}
		],
		[
			'missing recipient address line 1',
			(fixture: PaidCheckoutProviderFixture) => {
				const shipping = fixture.session.collected_information?.shipping_details;
				if (!shipping) throw new Error();
				shipping.address.line1 = null;
			}
		],
		[
			'missing recipient city',
			(fixture: PaidCheckoutProviderFixture) => {
				const shipping = fixture.session.collected_information?.shipping_details;
				if (!shipping) throw new Error();
				shipping.address.city = null;
			}
		],
		[
			'missing recipient postal code',
			(fixture: PaidCheckoutProviderFixture) => {
				const shipping = fixture.session.collected_information?.shipping_details;
				if (!shipping) throw new Error();
				shipping.address.postal_code = null;
			}
		],
		[
			'missing US recipient state',
			(fixture: PaidCheckoutProviderFixture) => {
				const shipping = fixture.session.collected_information?.shipping_details;
				if (!shipping) throw new Error();
				shipping.address.state = null;
			}
		]
	])('rejects %s even when provider identity copies agree', async (label, mutate) => {
		const fixture = paidCheckoutProviderFixture({ country: label.includes('US') ? 'US' : 'SE' });
		mutate(fixture);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID'
		);
	});

	it.each([
		[
			'missing expanded Customer shipping details',
			(fixture: PaidCheckoutProviderFixture) => {
				expandedCustomer(fixture).shipping = null;
			}
		],
		[
			'Customer shipping address mismatch',
			(fixture: PaidCheckoutProviderFixture) => {
				const customer = expandedCustomer(fixture);
				if (!customer.shipping) throw new Error();
				customer.shipping = {
					...customer.shipping,
					address: { ...customer.shipping.address, line1: '456 Different Street' }
				};
			}
		],
		[
			'Customer shipping name mismatch',
			(fixture: PaidCheckoutProviderFixture) => {
				const customer = expandedCustomer(fixture);
				if (!customer.shipping) throw new Error();
				customer.shipping.name = 'Different Recipient';
			}
		],
		[
			'Customer email mismatch',
			(fixture: PaidCheckoutProviderFixture) => {
				expandedCustomer(fixture).email = 'different@example.test';
			}
		],
		[
			'Customer name mismatch',
			(fixture: PaidCheckoutProviderFixture) => {
				expandedCustomer(fixture).name = 'Different Customer';
			}
		],
		[
			'Customer phone mismatch',
			(fixture: PaidCheckoutProviderFixture) => {
				expandedCustomer(fixture).phone = '+46709999999';
			}
		],
		[
			'Customer shipping phone mismatch',
			(fixture: PaidCheckoutProviderFixture) => {
				const customer = expandedCustomer(fixture);
				if (!customer.shipping) throw new Error();
				customer.shipping.phone = '+46708888888';
			}
		]
	])('rejects a %s', async (_label, mutate) => {
		const fixture = paidCheckoutProviderFixture();
		mutate(fixture);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_CUSTOMER_INVALID'
		);
	});

	it.each(['SI', 'US'])('rejects unsupported shipping destination %s', async (country) => {
		const fixture = paidCheckoutProviderFixture({ country });

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_DESTINATION_INVALID'
		);
	});

	it('normalizes exclusive shipping tax into the charged gross shipping snapshot', async () => {
		const fixture = paidCheckoutProviderFixture();

		await expect(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			)
		).resolves.toMatchObject({
			amounts: { shipping: 1_000, tax: 700, total: 3_500 }
		});
	});

	it.each([
		['SE', 500, 200, 2_500, 1_000, 3_500],
		['DE', 380, 152, 2_380, 952, 3_332],
		['FI', 510, 204, 2_510, 1_004, 3_514],
		['HU', 540, 216, 2_540, 1_016, 3_556],
		['JP', 0, 0, 2_000, 800, 2_800]
	] as const)(
		'normalizes the v2 exclusive %s pricing matrix',
		async (country, merchandiseTax, shippingTax, retailUnitAmount, shipping, total) => {
			const fixture = paidCheckoutProviderFixture({ country });
			const snapshot = await createStripeOrderGateway(
				new ContractStripeClient(fixture)
			).retrievePaidCheckout(fixture.session.id);

			expect(snapshot).toMatchObject({
				contractVersion: 2,
				destinationCountry: country,
				amounts: {
					subtotal: 2_000,
					discount: 0,
					shipping,
					shippingTax,
					tax: merchandiseTax + shippingTax,
					total
				},
				lines: [{ retailUnitAmount }]
			});
		}
	);

	it('rejects version 1 metadata without a compatibility path', async () => {
		const fixture = paidCheckoutProviderFixture();
		if (!fixture.session.metadata) throw new Error();
		fixture.session.metadata.checkout_contract_version = '1';

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_DRAFT_INVALID'
		);
	});

	it.each([
		[
			'missing expanded ShippingRate',
			(fixture: PaidCheckoutProviderFixture) => {
				if (!fixture.session.shipping_cost) throw new Error();
				fixture.session.shipping_cost.shipping_rate = null;
			}
		],
		[
			'unexpanded ShippingRate',
			(fixture: PaidCheckoutProviderFixture) => {
				if (!fixture.session.shipping_cost) throw new Error();
				fixture.session.shipping_cost.shipping_rate = 'shr_paid_10_eur';
			}
		],
		[
			'inclusive ShippingRate',
			(fixture: PaidCheckoutProviderFixture) => {
				const rate = fixture.session.shipping_cost?.shipping_rate;
				if (!rate || typeof rate === 'string') throw new Error();
				rate.tax_behavior = 'inclusive';
			}
		],
		[
			'missing shipping tax breakdown',
			(fixture: PaidCheckoutProviderFixture) => {
				if (!fixture.session.shipping_cost) throw new Error();
				delete fixture.session.shipping_cost.taxes;
			}
		],
		[
			'inclusive shipping tax rate',
			(fixture: PaidCheckoutProviderFixture) => {
				const tax = fixture.session.shipping_cost?.taxes?.[0];
				if (!tax) throw new Error();
				tax.rate.inclusive = true;
			}
		],
		[
			'mixed exclusive and inclusive shipping tax rates',
			(fixture: PaidCheckoutProviderFixture) => {
				const taxes = fixture.session.shipping_cost?.taxes;
				if (!taxes?.[0]) throw new Error();
				taxes[0].amount = 100;
				taxes.push({
					...structuredClone(taxes[0]),
					amount: 100,
					rate: { ...taxes[0].rate, id: 'txr_shipping_mutated_inclusive', inclusive: true }
				});
			}
		],
		[
			'shipping tax breakdown sum mismatch',
			(fixture: PaidCheckoutProviderFixture) => {
				const tax = fixture.session.shipping_cost?.taxes?.[0];
				if (!tax) throw new Error();
				tax.amount -= 1;
			}
		]
	])('rejects %s for v2 exclusive shipping', async (_label, mutate) => {
		const fixture = paidCheckoutProviderFixture();
		mutate(fixture);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_TAX_INVALID'
		);
	});

	it.each([
		[
			'missing client reference',
			(session: StripeFixtureCheckoutSession) => {
				session.client_reference_id = null;
			}
		],
		[
			'missing Session metadata draft',
			(session: StripeFixtureCheckoutSession) => {
				if (session.metadata) delete session.metadata.checkout_draft_id;
			}
		],
		[
			'mismatched PaymentIntent metadata draft',
			(session: StripeFixtureCheckoutSession) => {
				(session.payment_intent as StripeFixturePaymentIntent).metadata.checkout_draft_id =
					'another-draft';
			}
		]
	])('rejects %s', async (_label, mutate) => {
		const fixture = paidCheckoutProviderFixture();
		mutate(fixture.session);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_DRAFT_INVALID'
		);
	});

	it.each([
		[
			'fractional quantity',
			(fixture: PaidCheckoutProviderFixture) => (fixture.linePages[0].data[0].quantity = 1.5)
		],
		[
			'unsafe quantity',
			(fixture: PaidCheckoutProviderFixture) =>
				(fixture.linePages[0].data[0].quantity = Number.MAX_SAFE_INTEGER + 1)
		],
		[
			'fractional unit amount',
			(fixture: PaidCheckoutProviderFixture) => {
				const price = fixture.linePages[0].data[0].price;
				if (price) price.unit_amount = 2_000.5;
			}
		],
		[
			'unsafe line subtotal',
			(fixture: PaidCheckoutProviderFixture) =>
				(fixture.linePages[0].data[0].amount_subtotal = Number.MAX_SAFE_INTEGER + 1)
		]
	])('rejects provider lines with %s', async (_label, mutate) => {
		const fixture = paidCheckoutProviderFixture();
		mutate(fixture);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_LINES_INVALID'
		);
	});

	it('rejects a line total that disagrees with its reconciled subtotal, discount, and tax', async () => {
		const fixture = paidCheckoutProviderFixture();
		fixture.linePages[0].data[0].amount_total += 1;
		reconcilePaidCheckoutProviderTotals(fixture);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_LINES_INVALID'
		);
	});

	it('rejects a line discount greater than its reconciled subtotal', async () => {
		const fixture = paidCheckoutProviderFixture();
		const line = fixture.linePages[0].data[0];
		line.amount_discount = line.amount_subtotal + 1;
		line.amount_total = line.amount_tax;
		reconcilePaidCheckoutProviderTotals(fixture);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_LINES_INVALID'
		);
	});

	it('rejects a paginated response that cannot advance its cursor', async () => {
		const fixture = paidCheckoutProviderFixture();
		fixture.linePages = [stripeLinePage([], true)];

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_LINES_INVALID'
		);
	});

	it.each([
		[
			'disabled automatic tax',
			(session: StripeFixtureCheckoutSession) => (session.automatic_tax.enabled = false)
		],
		[
			'incomplete automatic tax',
			(session: StripeFixtureCheckoutSession) =>
				(session.automatic_tax.status = 'requires_location_inputs')
		],
		[
			'negative tax cents',
			(session: StripeFixtureCheckoutSession) => {
				if (session.total_details) session.total_details.amount_tax = -1;
			}
		],
		[
			'hidden shipping tax cents',
			(session: StripeFixtureCheckoutSession) => {
				if (session.total_details && session.shipping_cost) {
					session.total_details.amount_tax -= session.shipping_cost.amount_tax;
				}
			}
		]
	])('rejects %s', async (_label, mutate) => {
		const fixture = paidCheckoutProviderFixture();
		mutate(fixture.session);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_TAX_INVALID'
		);
	});

	it.each([
		[
			'Session subtotal not equal to line subtotals',
			(session: StripeFixtureCheckoutSession) => {
				if (session.amount_subtotal !== null) session.amount_subtotal += 1;
			}
		],
		[
			'Session total not equal to line and shipping totals',
			(session: StripeFixtureCheckoutSession) => {
				if (session.amount_total !== null) session.amount_total += 1;
			}
		],
		[
			'PaymentIntent total not equal to Session total',
			(session: StripeFixtureCheckoutSession) => {
				(session.payment_intent as StripeFixturePaymentIntent).amount += 1;
			}
		],
		[
			'unsafe total cents',
			(session: StripeFixtureCheckoutSession) => {
				session.amount_total = Number.MAX_SAFE_INTEGER + 1;
			}
		]
	])('rejects %s', async (_label, mutate) => {
		const fixture = paidCheckoutProviderFixture();
		mutate(fixture.session);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_TOTALS_INVALID'
		);
	});

	it('replaces provider failures with one stable error and logs no raw payload or PII', async () => {
		const fixture = paidCheckoutProviderFixture();
		const client = new ContractStripeClient(fixture);
		client.sessionFailure = new Error(
			'fixture.customer@example.test at 123 Provider Fixture Street using sk_test_secret'
		);
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		try {
			await expectStableCode(
				createStripeOrderGateway(client).retrievePaidCheckout(fixture.session.id),
				'STRIPE_PAID_CHECKOUT_RETRIEVAL_FAILED'
			);
			expect(log).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});
});

describe('paid Checkout comparison', () => {
	it('accepts an end-to-end normalized EU checkout with exclusive paid shipping', async () => {
		const { snapshot } = await normalizedSnapshot();

		expect(() => comparePaidCheckout(checkoutDraft(), snapshot)).not.toThrow();
	});

	it('accepts reordered exact lines and a destination-specific final tax', async () => {
		const fixture = paidCheckoutProviderFixture({
			shippingSubtotal: 0,
			shippingTaxAmount: 0,
			lines: [
				{
					id: 'li_accessory',
					priceId: 'price_accessory',
					quantity: 1,
					unitAmount: 2_000,
					taxAmount: 200
				},
				{
					id: 'li_tee',
					priceId: 'price_tee_medium',
					quantity: 1,
					unitAmount: 2_000,
					taxAmount: 700
				}
			]
		});
		const { snapshot } = await normalizedSnapshot(fixture);
		const draft = checkoutDraft({
			shippingMode: 'free',
			lines: [
				{ priceId: 'price_tee_medium', quantity: 1, unitAmount: 2_000 },
				{ priceId: 'price_accessory', quantity: 1, unitAmount: 2_000 }
			]
		});

		expect(() => comparePaidCheckout(draft, snapshot)).not.toThrow();
	});

	it.each([
		['Price ID', (paid: PaidCheckoutSnapshot) => (paid.lines[0].priceId = 'price_other')],
		['quantity', (paid: PaidCheckoutSnapshot) => (paid.lines[0].quantity = 2)],
		['unit amount', (paid: PaidCheckoutSnapshot) => (paid.lines[0].unitAmount = 2_001)]
	])('rejects a %s mismatch', async (_label, mutate) => {
		const { snapshot } = await normalizedSnapshot();
		mutate(snapshot);

		expectComparisonCode(
			() => comparePaidCheckout(checkoutDraft(), snapshot),
			'PAID_CHECKOUT_LINES_MISMATCH'
		);
	});

	it('retains duplicate provider lines instead of overwriting them during comparison', async () => {
		const fixture = paidCheckoutProviderFixture({
			shippingSubtotal: 0,
			shippingTaxAmount: 0,
			lines: [
				{
					id: 'li_two_tees',
					priceId: 'price_tee_medium',
					quantity: 2,
					unitAmount: 2_000,
					taxAmount: 1_000
				}
			]
		});
		const { snapshot } = await normalizedSnapshot(fixture);
		snapshot.lines = [
			{
				priceId: 'price_tee_medium',
				quantity: 1,
				unitAmount: 2_000,
				retailUnitAmount: 2_500
			},
			{
				priceId: 'price_tee_medium',
				quantity: 1,
				unitAmount: 2_000,
				retailUnitAmount: 2_500
			}
		];

		expectComparisonCode(
			() =>
				comparePaidCheckout(
					checkoutDraft({
						shippingMode: 'free',
						lines: [{ priceId: 'price_tee_medium', quantity: 2, unitAmount: 2_000 }]
					}),
					snapshot
				),
			'PAID_CHECKOUT_LINES_MISMATCH'
		);
	});

	it('rejects a draft ID mismatch', async () => {
		const { snapshot } = await normalizedSnapshot();

		expectComparisonCode(
			() => comparePaidCheckout(checkoutDraft({ id: 'draft-other' }), snapshot),
			'PAID_CHECKOUT_DRAFT_MISMATCH'
		);
	});

	it('rejects a draft from a different checkout contract version', async () => {
		const { snapshot } = await normalizedSnapshot();
		const draft = checkoutDraft();
		draft.contractVersion = 1;

		expectComparisonCode(
			() => comparePaidCheckout(draft, snapshot),
			'PAID_CHECKOUT_DRAFT_MISMATCH'
		);
	});

	it('rejects the United States even when both snapshots claim the same destination', async () => {
		const { snapshot } = await normalizedSnapshot();
		const draft = checkoutDraft();
		draft.destinationCountry = 'US' as unknown as MarketDestination;
		snapshot.destinationCountry = 'US';

		expectComparisonCode(
			() => comparePaidCheckout(draft, snapshot),
			'PAID_CHECKOUT_TOTALS_MISMATCH'
		);
	});

	it.each([null, 'cs_test_other'])('rejects an uncorrelated Session ID %s', async (sessionId) => {
		const { snapshot } = await normalizedSnapshot();

		expectComparisonCode(
			() => comparePaidCheckout(checkoutDraft({ checkoutSessionId: sessionId }), snapshot),
			'PAID_CHECKOUT_SESSION_MISMATCH'
		);
	});

	it('rejects a non-EUR normalized value defensively', async () => {
		const { snapshot } = await normalizedSnapshot();
		(snapshot as unknown as { currency: string }).currency = 'usd';

		expectComparisonCode(
			() => comparePaidCheckout(checkoutDraft(), snapshot),
			'PAID_CHECKOUT_CURRENCY_MISMATCH'
		);
	});

	it('rejects a total-unit-count mismatch even when the draft row is malformed', async () => {
		const { snapshot } = await normalizedSnapshot();

		expectComparisonCode(
			() => comparePaidCheckout(checkoutDraft({ totalUnitCount: 2 }), snapshot),
			'PAID_CHECKOUT_UNIT_COUNT_MISMATCH'
		);
	});

	it.each([
		['paid draft with free provider shipping', 'paid' as const, 0],
		['paid draft with a non-contract provider charge', 'paid' as const, 999],
		['free draft with paid provider shipping', 'free' as const, 1_000]
	])('rejects %s', async (_label, shippingMode, shipping) => {
		const fixture = paidCheckoutProviderFixture({
			shippingSubtotal: shippingMode === 'free' ? 0 : 800,
			shippingTaxAmount: shippingMode === 'free' ? 0 : 200,
			lines:
				shippingMode === 'free'
					? [
							{
								id: 'li_two_tees',
								priceId: 'price_tee_medium',
								quantity: 2,
								unitAmount: 2_000,
								taxAmount: 1_000
							}
						]
					: undefined
		});
		const { snapshot } = await normalizedSnapshot(fixture);
		snapshot.amounts.shipping = shipping;
		const draft = checkoutDraft({
			shippingMode,
			lines:
				shippingMode === 'free'
					? [{ priceId: 'price_tee_medium', quantity: 2, unitAmount: 2_000 }]
					: undefined
		});

		expectComparisonCode(
			() => comparePaidCheckout(draft, snapshot),
			'PAID_CHECKOUT_SHIPPING_MISMATCH'
		);
	});

	it('rejects a server-draft subtotal mismatch', async () => {
		const { snapshot } = await normalizedSnapshot();
		snapshot.amounts.subtotal += 1;

		expectComparisonCode(
			() => comparePaidCheckout(checkoutDraft(), snapshot),
			'PAID_CHECKOUT_SUBTOTAL_MISMATCH'
		);
	});

	it('rejects a discount because the checkout contract does not enable discounts', async () => {
		const { snapshot } = await normalizedSnapshot();
		snapshot.amounts.discount = 1;

		expectComparisonCode(
			() => comparePaidCheckout(checkoutDraft(), snapshot),
			'PAID_CHECKOUT_DISCOUNT_MISMATCH'
		);
	});

	it('rejects a retail unit amount that does not reconcile to merchandise tax', async () => {
		const { snapshot } = await normalizedSnapshot();
		snapshot.lines[0].retailUnitAmount -= 1;

		expectComparisonCode(
			() => comparePaidCheckout(checkoutDraft(), snapshot),
			'PAID_CHECKOUT_LINES_MISMATCH'
		);
	});

	it('rejects a one-cent total mutation against the explicit tax invariant', async () => {
		const { snapshot } = await normalizedSnapshot();
		snapshot.amounts.total += 1;

		expectComparisonCode(
			() => comparePaidCheckout(checkoutDraft(), snapshot),
			'PAID_CHECKOUT_TOTALS_MISMATCH'
		);
	});

	it.each([
		[
			'a total below merchandise subtotal plus gross shipping',
			(snapshot: PaidCheckoutSnapshot) => {
				snapshot.amounts.total = snapshot.amounts.subtotal + snapshot.amounts.shipping - 1;
			}
		],
		[
			'a merchandise-tax remainder greater than total tax',
			(snapshot: PaidCheckoutSnapshot) => {
				snapshot.amounts.total =
					snapshot.amounts.subtotal + snapshot.amounts.shipping + snapshot.amounts.tax + 1;
			}
		]
	])('rejects %s', async (_label, mutate) => {
		const { snapshot } = await normalizedSnapshot();
		mutate(snapshot);

		expectComparisonCode(
			() => comparePaidCheckout(checkoutDraft(), snapshot),
			'PAID_CHECKOUT_TOTALS_MISMATCH'
		);
	});
});

describe('refund status normalization', () => {
	it.each([
		['paid', 0, 'paid'],
		['partially refunded', 1_000, 'partially_refunded'],
		['fully refunded', 3_500, 'refunded']
	])('normalizes %s from the expanded latest Charge', async (_label, amountRefunded, expected) => {
		const fixture = paidCheckoutProviderFixture();
		const charge = fixture.refundPaymentIntent.latest_charge;
		if (typeof charge !== 'object' || !charge) throw new Error();
		charge.amount_refunded = amountRefunded;
		charge.refunded = amountRefunded === charge.amount;
		const client = new ContractStripeClient(fixture);

		await expect(
			createStripeOrderGateway(client).retrieveRefundStatus('pi_test_paid')
		).resolves.toBe(expected);
		expect(client.paymentIntentRetrieveCalls).toEqual([
			{ id: 'pi_test_paid', params: { expand: ['latest_charge'] } }
		]);
	});

	it.each([
		['negative refund', -1],
		['fractional refund', 1.5],
		['over-refund', 3_501],
		['unsafe refund', Number.MAX_SAFE_INTEGER + 1]
	])('rejects an invalid %s amount', async (_label, amountRefunded) => {
		const fixture = paidCheckoutProviderFixture();
		const charge = fixture.refundPaymentIntent.latest_charge;
		if (typeof charge !== 'object' || !charge) throw new Error();
		charge.amount_refunded = amountRefunded;

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrieveRefundStatus(
				'pi_test_paid'
			),
			'STRIPE_REFUND_STATUS_INVALID'
		);
	});

	it('requires an expanded latest Charge correlated to the requested PaymentIntent', async () => {
		const fixture = paidCheckoutProviderFixture();
		fixture.refundPaymentIntent.latest_charge = 'ch_test_paid';

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrieveRefundStatus(
				'pi_test_paid'
			),
			'STRIPE_REFUND_STATUS_INVALID'
		);
	});

	it('redacts a refund-provider failure', async () => {
		const client = new ContractStripeClient(paidCheckoutProviderFixture());
		client.paymentIntentFailure = new Error(
			'fixture.customer@example.test using payment method pm_secret_fixture'
		);

		await expectStableCode(
			createStripeOrderGateway(client).retrieveRefundStatus('pi_test_paid'),
			'STRIPE_REFUND_STATUS_RETRIEVAL_FAILED'
		);
	});
});
