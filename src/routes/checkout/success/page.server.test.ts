import { describe, expect, it, vi } from 'vitest';
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
	STRIPE_FREE_SHIPPING_RATE_ID: 'shr_test_free',
	STYRIA_SUPPORTED_COUNTRIES: 'SE,JP,TW'
} as const;

const PAID_CHECKOUT: PaidCheckoutSnapshot = {
	contractVersion: 2,
	checkoutSessionId: 'cs_test_verified',
	paymentIntentId: 'pi_test_verified',
	customerId: 'cus_test_verified',
	draftId: 'draft-test-verified',
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
			priceId: 'price_accessory_one',
			quantity: 1,
			unitAmount: 2_000,
			retailUnitAmount: 2_500
		}
	]
};

function loadWith(gateway: StripeOrderGateway) {
	return _createSuccessPageServerLoad(PRIVATE_ENV, () => gateway);
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
		const load = loadWith({
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
		const load = _createSuccessPageServerLoad(PRIVATE_ENV, createGateway);

		await expect(load(loadEvent(load, href))).rejects.toMatchObject({ status: 404 });
		expect(createGateway).not.toHaveBeenCalled();
	});

	it('maps failed paid-merch verification to a non-disclosing not-found response', async () => {
		const load = loadWith({
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
});
