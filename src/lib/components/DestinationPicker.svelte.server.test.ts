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
	it('server-renders only a complete native fallback before hydration', () => {
		const { body } = render(DestinationPicker, {
			props: { destination, destinations, returnTo: '/products/society-tee?size=m' }
		});
		const fallback =
			body.match(/<form class="no-script-destination[^>]*>([\s\S]*?)<\/form>/)?.[0] ?? '';
		const formTag = fallback.match(/^<form\b[^>]*>/)?.[0] ?? '';
		const successfulControlNames = [
			...fallback.matchAll(/<(?:input|select)\b[^>]*\bname="([^"]+)"[^>]*>/g)
		].map((match) => match[1]);

		expect(formTag).toContain('method="POST"');
		expect(formTag).toContain('action="/preferences/destination"');
		expect(fallback).toMatch(
			/<option\b(?=[^>]*\bvalue="SE")(?=[^>]*\bselected)[^>]*>Sweden<\/option>/
		);
		expect(successfulControlNames).toEqual(['country', 'returnTo']);
		expect(body).not.toContain('destination-trigger');
		expect(body).not.toContain('<dialog');
	});
});
