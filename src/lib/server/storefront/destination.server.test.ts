import { describe, expect, it } from 'vitest';
import { SUPPORTED_DESTINATIONS } from '$lib/domain/destinations';
import { destinationOptions, resolvePricingDestination } from './destination.server';

describe('pricing destination resolution', () => {
	it('prefers an explicit valid destination cookie over a Cloudflare hint', () => {
		expect(
			resolvePricingDestination({
				cookieValue: 'DE',
				cloudflareCountry: 'JP'
			})
		).toMatchObject({ countryCode: 'DE', source: 'cookie', vatBasisPoints: 1900 });
	});

	it('uses a supported exact-uppercase Cloudflare country hint', () => {
		expect(
			resolvePricingDestination({
				cookieValue: undefined,
				cloudflareCountry: 'JP'
			})
		).toMatchObject({ countryCode: 'JP', source: 'cloudflare_hint' });
	});

	it.each(['jp', 'US', 'JPN', ' JP', 'JP '])(
		'ignores an invalid Cloudflare hint %j',
		(cloudflareCountry) => {
			expect(
				resolvePricingDestination({
					cookieValue: undefined,
					cloudflareCountry
				})
			).toMatchObject({ countryCode: 'SE', source: 'fallback' });
		}
	);

	it('falls back to Sweden when no valid preference remains', () => {
		expect(
			resolvePricingDestination({
				cookieValue: 'US',
				cloudflareCountry: null
			})
		).toMatchObject({ countryCode: 'SE', source: 'fallback' });
	});

	it('returns every supported option ordered by region and English display name', () => {
		const options = destinationOptions();
		expect(options.map(({ countryCode }) => countryCode).sort()).toEqual(
			[...SUPPORTED_DESTINATIONS].sort()
		);
		expect(options).toContainEqual({ countryCode: 'DE', displayName: 'Germany', region: 'eu' });
		expect(options).toContainEqual({ countryCode: 'JP', displayName: 'Japan', region: 'asia' });
		expect(options.map(({ countryCode }) => countryCode)).not.toContain('US');
		const firstAsia = options.findIndex(({ region }) => region === 'asia');
		expect(firstAsia).toBeGreaterThan(0);
		expect(options.slice(0, firstAsia).every(({ region }) => region === 'eu')).toBe(true);
		expect(options.slice(firstAsia).every(({ region }) => region === 'asia')).toBe(true);
	});
});
