import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import DestinationPicker from './DestinationPicker.svelte';

const destination = {
	countryCode: 'SE' as const,
	displayName: 'Sweden',
	region: 'eu' as const,
	vatBasisPoints: 2500,
	requiresImportChargeCopy: false
};

const destinations = [
	{ countryCode: 'DE' as const, displayName: 'Germany', region: 'eu' as const },
	{ countryCode: 'SE' as const, displayName: 'Sweden', region: 'eu' as const },
	{ countryCode: 'JP' as const, displayName: 'Japan', region: 'asia' as const }
];

describe('DestinationPicker no-JS fallback', () => {
	it('server-renders a native country form with only approved endpoint fields', () => {
		const { body } = render(DestinationPicker, {
			props: { destination, destinations, returnTo: '/products/society-tee?size=m' }
		});
		const fallback =
			body.match(/<form class="no-script-destination[^>]*>([\s\S]*?)<\/form>/)?.[0] ?? '';

		expect(fallback).toContain('action="/preferences/destination"');
		expect(fallback).toContain('name="country"');
		expect(fallback).toContain('name="returnTo"');
		expect(fallback).not.toContain('name="query"');
	});
});
