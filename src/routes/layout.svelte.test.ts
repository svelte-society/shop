import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import Layout from './+layout.svelte';

const children = createRawSnippet(() => ({ render: () => '<main>Storefront</main>' }));

const pricingData = {
	pricingDestination: {
		countryCode: 'SE' as const,
		displayName: 'Sweden',
		region: 'eu' as const,
		vatBasisPoints: 2500,
		requiresImportChargeCopy: false
	},
	destinationOptions: [
		{ countryCode: 'DE' as const, displayName: 'Germany', region: 'eu' as const },
		{ countryCode: 'SE' as const, displayName: 'Sweden', region: 'eu' as const },
		{ countryCode: 'JP' as const, displayName: 'Japan', region: 'asia' as const }
	]
};

afterEach(() => {
	document.head.querySelectorAll('script[data-website-id]').forEach((script) => script.remove());
});

describe('root layout analytics', () => {
	it('renders the configured invisible Umami tracker through the app shell', () => {
		render(Layout, {
			children,
			params: {},
			data: {
				storefrontEnabled: true,
				checkoutEnabled: true,
				showOpeningSoon: false,
				umami: {
					scriptUrl: 'https://analytics.sveltesociety.dev/script.js',
					connectOrigin: 'https://analytics-api.sveltesociety.dev',
					websiteId: 'society-storefront'
				},
				...pricingData
			}
		});

		const script = document.head.querySelector<HTMLScriptElement>(
			'script[data-website-id="society-storefront"]'
		);
		expect(script?.getAttribute('src')).toBe('https://analytics.sveltesociety.dev/script.js');
	});

	it('renders no analytics script when configuration is unavailable', () => {
		render(Layout, {
			children,
			params: {},
			data: {
				storefrontEnabled: true,
				checkoutEnabled: true,
				showOpeningSoon: false,
				umami: null,
				...pricingData
			}
		});

		expect(document.head.querySelector('script[data-website-id]')).toBeNull();
	});
});
