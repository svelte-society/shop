import { describe, expect, it } from 'vitest';
import { _createLayoutServerLoad } from './+layout.server';

const disabledStorefrontEnv = {
	STOREFRONT_ENABLED: 'false',
	CHECKOUT_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	SELLER_LEGAL_NAME: 'Svelte School AB',
	SELLER_REGISTRATION_NUMBER: 'reviewed-registration',
	SELLER_VAT_NUMBER: 'reviewed-vat-number',
	SELLER_ADDRESS_LINE1: 'Reviewed street 1',
	SELLER_POSTAL_CODE: '123 45',
	SELLER_CITY: 'Reviewed city',
	SELLER_COUNTRY: 'Sweden',
	SELLER_EMAIL: 'merchant@example.com',
	DELIVERY_ESTIMATE_EU: 'Reviewed EU estimate',
	DELIVERY_ESTIMATE_ASIA: 'Reviewed Asia estimate',
	POLICY_EFFECTIVE_DATE: '2026-07-17',
	STYRIA_SUPPORTED_COUNTRIES: 'SE,DE,JP'
};

async function loadRoute(routeId: string, storefrontEnabled = false) {
	const load = _createLayoutServerLoad({
		...disabledStorefrontEnv,
		STOREFRONT_ENABLED: storefrontEnabled ? 'true' : 'false'
	});

	return load({
		route: { id: routeId },
		cookies: { get: () => undefined },
		request: { headers: new Headers() },
		depends: () => undefined
	} as unknown as Parameters<typeof load>[0]);
}

describe('public layout feature gate', () => {
	it.each(['/', '/products/[slug]', '/cart', '/checkout/cancel'])(
		'shows the opening-soon state for disabled commerce route %s',
		async (routeId) => {
			await expect(loadRoute(routeId)).resolves.toEqual({
				storefrontEnabled: false,
				checkoutEnabled: false,
				showOpeningSoon: true,
				policyDocument: null,
				umami: null,
				pricingDestination: {
					countryCode: 'SE',
					displayName: 'Sweden',
					region: 'eu',
					vatBasisPoints: 2500,
					requiresImportChargeCopy: false
				},
				destinationOptions: [
					{ countryCode: 'DE', displayName: 'Germany', region: 'eu' },
					{ countryCode: 'SE', displayName: 'Sweden', region: 'eu' },
					{ countryCode: 'JP', displayName: 'Japan', region: 'asia' }
				]
			});
		}
	);

	it.each(['/shipping', '/returns', '/privacy', '/terms', '/about', '/health/live'])(
		'leaves non-commerce route %s available while the storefront is disabled',
		async (routeId) => {
			await expect(loadRoute(routeId)).resolves.toMatchObject({ showOpeningSoon: false });
		}
	);

	it('returns public flags without gating commerce when the storefront is enabled', async () => {
		await expect(loadRoute('/products/[slug]', true)).resolves.toEqual({
			storefrontEnabled: true,
			checkoutEnabled: false,
			showOpeningSoon: false,
			policyDocument: null,
			umami: null,
			pricingDestination: {
				countryCode: 'SE',
				displayName: 'Sweden',
				region: 'eu',
				vatBasisPoints: 2500,
				requiresImportChargeCopy: false
			},
			destinationOptions: [
				{ countryCode: 'DE', displayName: 'Germany', region: 'eu' },
				{ countryCode: 'SE', displayName: 'Sweden', region: 'eu' },
				{ countryCode: 'JP', displayName: 'Japan', region: 'asia' }
			]
		});
	});

	it('exposes the exact HTTPS Umami tracker configuration to the root layout', async () => {
		const load = _createLayoutServerLoad({
			...disabledStorefrontEnv,
			UMAMI_SCRIPT_URL: 'https://analytics.sveltesociety.dev/script.js',
			UMAMI_CONNECT_ORIGIN: 'https://analytics-api.sveltesociety.dev',
			UMAMI_WEBSITE_ID: 'society-storefront'
		});

		const result = await load({
			route: { id: '/' },
			cookies: { get: () => undefined },
			request: { headers: new Headers() },
			depends: () => undefined
		} as unknown as Parameters<typeof load>[0]);

		expect(result).toMatchObject({
			umami: {
				scriptUrl: 'https://analytics.sveltesociety.dev/script.js',
				connectOrigin: 'https://analytics-api.sveltesociety.dev',
				websiteId: 'society-storefront'
			}
		});
	});

	it.each([
		['a missing website ID', { UMAMI_WEBSITE_ID: undefined }],
		['a blank website ID', { UMAMI_WEBSITE_ID: '   ' }],
		['an HTTP script', { UMAMI_SCRIPT_URL: 'http://analytics.sveltesociety.dev/script.js' }],
		['a wildcard script', { UMAMI_SCRIPT_URL: 'https://*.sveltesociety.dev/script.js' }],
		[
			'a credentialed script',
			{ UMAMI_SCRIPT_URL: 'https://user:password@analytics.sveltesociety.dev/script.js' }
		]
	])('disables analytics for %s', async (_label, override) => {
		const load = _createLayoutServerLoad({
			...disabledStorefrontEnv,
			UMAMI_SCRIPT_URL: 'https://analytics.sveltesociety.dev/script.js',
			UMAMI_WEBSITE_ID: 'society-storefront',
			...override
		});

		const result = await load({
			route: { id: '/' },
			cookies: { get: () => undefined },
			request: { headers: new Headers() },
			depends: () => undefined
		} as unknown as Parameters<typeof load>[0]);

		expect(result).toMatchObject({ umami: null });
	});

	it('omits an invalid separate connect origin and falls back to the script origin', async () => {
		const load = _createLayoutServerLoad({
			...disabledStorefrontEnv,
			UMAMI_SCRIPT_URL: 'https://analytics.sveltesociety.dev/script.js',
			UMAMI_CONNECT_ORIGIN: 'http://analytics-api.sveltesociety.dev',
			UMAMI_WEBSITE_ID: 'society-storefront'
		});

		const result = await load({
			route: { id: '/' },
			cookies: { get: () => undefined },
			request: { headers: new Headers() },
			depends: () => undefined
		} as unknown as Parameters<typeof load>[0]);

		expect(result).toMatchObject({
			umami: {
				scriptUrl: 'https://analytics.sveltesociety.dev/script.js',
				connectOrigin: null,
				websiteId: 'society-storefront'
			}
		});
	});
});
