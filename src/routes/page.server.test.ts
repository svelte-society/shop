import { describe, expect, it } from 'vitest';
import type { CatalogGateway } from '$lib/server/catalog/gateway';
import { _createHomePageServerLoad } from './+page.server';

const disabledEnv = {
	STOREFRONT_ENABLED: 'false',
	CHECKOUT_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev'
};

describe('homepage catalog loader', () => {
	it('returns inert opening-soon data before private config or provider work when disabled', async () => {
		let providerFactories = 0;
		const load = _createHomePageServerLoad(disabledEnv, () => {
			providerFactories += 1;
			throw new Error('PROVIDER_MUST_NOT_BE_REACHED');
		});

		await expect(load({} as Parameters<typeof load>[0])).resolves.toEqual({
			products: [],
			stale: false,
			catalogUnavailable: false
		});
		expect(providerFactories).toBe(0);
	});

	it('maps catalog failure to the temporary-unavailable state', async () => {
		const load = _createHomePageServerLoad(
			{
				...disabledEnv,
				STOREFRONT_ENABLED: 'true',
				STRIPE_SECRET_KEY: 'sk_test_catalog',
				STRIPE_WEBHOOK_SECRET: 'whsec_test_catalog',
				STRIPE_PAID_SHIPPING_RATE_ID: 'shr_paid',
				STRIPE_FREE_SHIPPING_RATE_ID: 'shr_free',
				STYRIA_SUPPORTED_COUNTRIES: 'SE,JP,TW'
			},
			() =>
				({
					async loadMerchCatalog() {
						throw new Error('STRIPE_UNAVAILABLE');
					},
					async resolveVariants() {
						return [];
					}
				}) satisfies CatalogGateway
		);

		await expect(load({} as Parameters<typeof load>[0])).resolves.toEqual({
			products: [],
			stale: false,
			catalogUnavailable: true
		});
	});
});
