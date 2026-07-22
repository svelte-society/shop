import { describe, expect, it } from 'vitest';
import type { CatalogGateway } from '$lib/server/catalog/gateway';
import { _createProductPageServerLoad } from './+page.server';

const disabledEnv = {
	STOREFRONT_ENABLED: 'false',
	CHECKOUT_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev'
};

describe('product catalog loader', () => {
	it('redirects before private config or provider work when the storefront is disabled', async () => {
		let providerFactories = 0;
		const load = _createProductPageServerLoad(disabledEnv, () => {
			providerFactories += 1;
			throw new Error('PROVIDER_MUST_NOT_BE_REACHED');
		});

		await expect(
			load({ params: { slug: 'society-tee' } } as Parameters<typeof load>[0])
		).rejects.toMatchObject({ status: 307, location: '/' });
		expect(providerFactories).toBe(0);
	});

	it('returns 404 for an unknown product slug', async () => {
		const load = _createProductPageServerLoad(
			{
				...disabledEnv,
				STOREFRONT_ENABLED: 'true',
				STRIPE_SECRET_KEY: 'sk_test_catalog',
				STRIPE_WEBHOOK_SECRET: 'whsec_test_catalog',
				STRIPE_PAID_SHIPPING_RATE_ID: 'shr_paid',
				STRIPE_FREE_SHIPPING_RATE_ID: 'shr_free'
			},
			() =>
				({
					async loadMerchCatalog() {
						return {
							products: [],
							shippingRates: {
								paid: { id: 'shr_paid', netAmountCents: 937 },
								free: { id: 'shr_free', netAmountCents: 0 }
							},
							diagnostics: [],
							loadedAt: new Date(),
							stale: false
						};
					}
				}) satisfies CatalogGateway
		);

		await expect(
			load({ params: { slug: 'missing-product' } } as Parameters<typeof load>[0])
		).rejects.toMatchObject({ status: 404 });
	});
});
