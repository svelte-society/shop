import { describe, expect, it } from 'vitest';
import { _createLayoutServerLoad } from './+layout.server';

const disabledStorefrontEnv = {
	STOREFRONT_ENABLED: 'false',
	CHECKOUT_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev'
};

async function loadRoute(routeId: string, storefrontEnabled = false) {
	const load = _createLayoutServerLoad({
		...disabledStorefrontEnv,
		STOREFRONT_ENABLED: storefrontEnabled ? 'true' : 'false'
	});

	return load({ route: { id: routeId } } as Parameters<typeof load>[0]);
}

describe('public layout feature gate', () => {
	it.each(['/', '/products/[slug]', '/cart', '/checkout/cancel'])(
		'shows the opening-soon state for disabled commerce route %s',
		async (routeId) => {
			await expect(loadRoute(routeId)).resolves.toEqual({
				storefrontEnabled: false,
				checkoutEnabled: false,
				showOpeningSoon: true
			});
		}
	);

	it.each(['/shipping', '/returns', '/privacy', '/terms', '/health/live'])(
		'leaves non-commerce route %s available while the storefront is disabled',
		async (routeId) => {
			await expect(loadRoute(routeId)).resolves.toMatchObject({ showOpeningSoon: false });
		}
	);

	it('returns public flags without gating commerce when the storefront is enabled', async () => {
		await expect(loadRoute('/products/[slug]', true)).resolves.toEqual({
			storefrontEnabled: true,
			checkoutEnabled: false,
			showOpeningSoon: false
		});
	});
});
