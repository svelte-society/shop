import { describe, expect, it, vi } from 'vitest';
import type { CheckoutDraftWithLines } from '$lib/domain/orders';
import type { PaidCheckoutSnapshot } from './gateway';
import {
	comparePaidCheckout,
	createStripeOrderGateway,
	type StripeOrderClient
} from './paid-checkout';
import {
	paidCheckoutProviderFixture,
	stripeLinePage,
	type PaidCheckoutProviderFixture,
	type StripeFixtureCheckoutSession,
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
		contractVersion: 1,
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

describe('Stripe paid Checkout normalization', () => {
	it('normalizes a complete paid EU Checkout without retaining customer data', async () => {
		const { snapshot, client } = await normalizedSnapshot();

		expect(snapshot).toEqual({
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
				tax: 700,
				total: 3_500
			},
			lines: [{ priceId: 'price_tee_medium', quantity: 1, unitAmount: 2_000 }]
		});
		expect(JSON.stringify(snapshot)).not.toMatch(
			/Fixture Customer|fixture\.customer@example\.test|Provider Fixture Street|\+4670/
		);
		expect(client.sessionRetrieveCalls).toEqual([
			{
				id: 'cs_test_paid',
				params: {
					expand: ['customer', 'customer.tax_ids', 'payment_intent', 'payment_intent.latest_charge']
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

	it('normalizes a valid US Checkout with zero automatic tax', async () => {
		const fixture = paidCheckoutProviderFixture({ country: 'US' });

		await expect(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			)
		).resolves.toMatchObject({
			destinationCountry: 'US',
			amounts: { subtotal: 2_000, shipping: 1_000, tax: 0, total: 3_000 }
		});
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
		).resolves.toMatchObject({ amounts: { tax: 0, total: 3_000 } });
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
			shippingAmount: 0,
			shippingTaxAmount: 0,
			lines: [
				{
					id: 'li_accessory',
					priceId: 'price_accessory',
					quantity: 1,
					unitAmount: 1_000,
					taxAmount: 250
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
			{ priceId: 'price_accessory', quantity: 1, unitAmount: 1_000 },
			{ priceId: 'price_tee_medium', quantity: 2, unitAmount: 2_000 }
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
			'unpaid Session',
			(session: StripeFixtureCheckoutSession) => (session.payment_status = 'unpaid')
		],
		['open Session', (session: StripeFixtureCheckoutSession) => (session.status = 'open')],
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
		]
	])('rejects an %s', async (_label, mutate) => {
		const fixture = paidCheckoutProviderFixture();
		mutate(fixture.session);

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_UNPAID'
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

	it('rejects an unsupported shipping destination', async () => {
		const fixture = paidCheckoutProviderFixture({ country: 'SI' });

		await expectStableCode(
			createStripeOrderGateway(new ContractStripeClient(fixture)).retrievePaidCheckout(
				fixture.session.id
			),
			'STRIPE_PAID_CHECKOUT_DESTINATION_INVALID'
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
			'inconsistent tax cents',
			(session: StripeFixtureCheckoutSession) => {
				if (session.total_details) session.total_details.amount_tax += 1;
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
	it('accepts reordered exact lines and a destination-specific final tax', async () => {
		const fixture = paidCheckoutProviderFixture({
			shippingAmount: 0,
			shippingTaxAmount: 0,
			lines: [
				{
					id: 'li_accessory',
					priceId: 'price_accessory',
					quantity: 1,
					unitAmount: 1_000,
					taxAmount: 100
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
				{ priceId: 'price_accessory', quantity: 1, unitAmount: 1_000 }
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
			shippingAmount: 0,
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
			{ priceId: 'price_tee_medium', quantity: 1, unitAmount: 2_000 },
			{ priceId: 'price_tee_medium', quantity: 1, unitAmount: 2_000 }
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
		draft.contractVersion = 2;

		expectComparisonCode(
			() => comparePaidCheckout(draft, snapshot),
			'PAID_CHECKOUT_DRAFT_MISMATCH'
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
			shippingAmount: shippingMode === 'free' ? 0 : 1_000,
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
