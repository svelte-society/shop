import { describe, expect, it, vi } from 'vitest';
import type { CheckoutDraftWithLines } from '$lib/domain/orders';
import type { PaidCheckoutSnapshot, StripeOrderGateway } from '$lib/server/stripe/gateway';
import { _createSuccessPageServerLoad } from './+page.server';

const PRIVATE_ENV = {
	STOREFRONT_ENABLED: 'true',
	CHECKOUT_ENABLED: 'true',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	STRIPE_SECRET_KEY: 'sk_test_success',
	STRIPE_WEBHOOK_SECRET: 'whsec_test_success',
	STRIPE_PAID_SHIPPING_RATE_ID: 'shr_test_paid',
	STRIPE_FREE_SHIPPING_RATE_ID: 'shr_test_free'
} as const;

const PAID_CHECKOUT: PaidCheckoutSnapshot = {
	contractVersion: 3,
	checkoutSessionId: 'cs_test_verified',
	paymentIntentId: 'pi_test_verified',
	customerId: 'cus_test_verified',
	draftId: 'draft-test-verified',
	currency: 'eur',
	paymentStatus: 'paid',
	destinationCountry: 'SE',
	shippingRate: { id: 'shr_paid_8_eur', netAmount: 800 },
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
			priceId: 'price_accessory_one',
			quantity: 1,
			unitAmount: 2_000,
			retailUnitAmount: 2_500
		}
	]
};

function draftFixture(overrides: Partial<CheckoutDraftWithLines> = {}): CheckoutDraftWithLines {
	return {
		id: 'draft-test-verified',
		checkoutSessionId: 'cs_test_verified',
		contractVersion: 3,
		destinationCountry: 'SE',
		currency: 'eur',
		totalUnitCount: 1,
		shippingMode: 'paid',
		shippingRateId: 'shr_paid_8_eur',
		shippingNetAmount: 800,
		createdAt: new Date('2026-07-22T09:00:00.000Z'),
		expiresAt: new Date('2026-07-23T09:00:00.000Z'),
		completedAt: null,
		lines: [
			{
				lineIndex: 0,
				stripeProductId: 'prod_accessory',
				stripePriceId: 'price_accessory_one',
				productName: 'Svelte Society Accessory',
				variantLabel: 'One size',
				sku: 'ACCESSORY-ONE',
				styriaProductNumber: 'STYRIA-ACCESSORY-ONE',
				designReference: 'accessory-v1',
				designPlacements: { front: 'https://cdn.example.test/accessory.svg' },
				quantity: 1,
				unitAmount: 2_000,
				currency: 'eur'
			}
		],
		...overrides
	};
}

function loadWith(
	gateway: StripeOrderGateway,
	draft: CheckoutDraftWithLines | null = draftFixture()
) {
	const findById = vi.fn(() => draft);
	return {
		load: _createSuccessPageServerLoad(
			PRIVATE_ENV,
			() => gateway,
			() => ({ findById })
		),
		findById
	};
}

function loadEvent(
	load: ReturnType<typeof _createSuccessPageServerLoad>,
	href: string,
	setHeaders = vi.fn()
) {
	return { url: new URL(href), setHeaders } as unknown as Parameters<typeof load>[0];
}

describe('checkout success loader', () => {
	it('returns only a verified marker after server-side paid merch verification', async () => {
		const retrievePaidCheckout = vi.fn(async () => PAID_CHECKOUT);
		const { load, findById } = loadWith({
			retrievePaidCheckout,
			async retrieveRefundStatus() {
				return 'paid';
			}
		});
		const setHeaders = vi.fn();

		await expect(
			load(
				loadEvent(
					load,
					'https://shop.sveltesociety.dev/checkout/success?session_id=cs_test_verified',
					setHeaders
				)
			)
		).resolves.toEqual({ verified: true });
		expect(retrievePaidCheckout).toHaveBeenCalledExactlyOnceWith('cs_test_verified');
		expect(findById).toHaveBeenCalledExactlyOnceWith('draft-test-verified');
		expect(setHeaders).toHaveBeenCalledExactlyOnceWith({ 'cache-control': 'no-store' });
	});

	it.each([
		['a missing session ID', 'https://shop.sveltesociety.dev/checkout/success'],
		[
			'a duplicate session ID',
			'https://shop.sveltesociety.dev/checkout/success?session_id=cs_test_verified&session_id=cs_test_other'
		],
		[
			'an invalid session ID',
			'https://shop.sveltesociety.dev/checkout/success?session_id=not-a-session'
		],
		[
			'an additional query parameter',
			'https://shop.sveltesociety.dev/checkout/success?session_id=cs_test_verified&email=private%40example.test'
		]
	])('rejects %s before creating a Stripe gateway', async (_label, href) => {
		const createGateway = vi.fn(() => {
			throw new Error('PROVIDER_MUST_NOT_BE_REACHED');
		});
		const createDrafts = vi.fn(() => ({ findById: vi.fn() }));
		const load = _createSuccessPageServerLoad(PRIVATE_ENV, createGateway, createDrafts);

		await expect(load(loadEvent(load, href))).rejects.toMatchObject({ status: 404 });
		expect(createGateway).not.toHaveBeenCalled();
		expect(createDrafts).not.toHaveBeenCalled();
	});

	it('maps failed paid-merch verification to a non-disclosing not-found response', async () => {
		const { load } = loadWith({
			async retrievePaidCheckout() {
				throw new Error('STRIPE_PAID_CHECKOUT_SESSION_UNPAID');
			},
			async retrieveRefundStatus() {
				return 'paid';
			}
		});

		await expect(
			load(
				loadEvent(load, 'https://shop.sveltesociety.dev/checkout/success?session_id=cs_test_unpaid')
			)
		).rejects.toMatchObject({ status: 404, body: { message: 'Not found' } });
	});

	it.each([
		['destination', draftFixture({ destinationCountry: 'JP' })],
		[
			'line',
			draftFixture({
				lines: [{ ...draftFixture().lines[0], stripePriceId: 'price_other' }]
			})
		],
		['Session', draftFixture({ checkoutSessionId: 'cs_test_other' })]
	] as const)('fails closed for a frozen-draft %s mismatch', async (_label, draft) => {
		const { load } = loadWith(
			{
				async retrievePaidCheckout() {
					return structuredClone(PAID_CHECKOUT);
				},
				async retrieveRefundStatus() {
					return 'paid';
				}
			},
			draft
		);

		await expect(
			load(
				loadEvent(
					load,
					'https://shop.sveltesociety.dev/checkout/success?session_id=cs_test_verified'
				)
			)
		).rejects.toMatchObject({ status: 404, body: { message: 'Not found' } });
	});

	it('fails closed when the frozen draft is missing', async () => {
		const { load } = loadWith(
			{
				async retrievePaidCheckout() {
					return PAID_CHECKOUT;
				},
				async retrieveRefundStatus() {
					return 'paid';
				}
			},
			null
		);

		await expect(
			load(
				loadEvent(
					load,
					'https://shop.sveltesociety.dev/checkout/success?session_id=cs_test_verified'
				)
			)
		).rejects.toMatchObject({ status: 404, body: { message: 'Not found' } });
	});
});
