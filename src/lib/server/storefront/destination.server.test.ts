import { describe, expect, it } from 'vitest';
import { destinationOptions, resolvePricingDestination } from './destination.server';

describe('pricing destination resolution', () => {
	it('prefers an explicit valid destination cookie over a Cloudflare hint', () => {
		expect(
			resolvePricingDestination({
				cookieValue: 'DE',
				cloudflareCountry: 'JP',
				allowedCountries: ['SE', 'DE', 'JP']
			})
		).toMatchObject({ countryCode: 'DE', source: 'cookie', vatBasisPoints: 1900 });
	});

	it('uses a supported exact-uppercase Cloudflare country hint', () => {
		expect(
			resolvePricingDestination({
				cookieValue: undefined,
				cloudflareCountry: 'JP',
				allowedCountries: ['SE', 'JP']
			})
		).toMatchObject({ countryCode: 'JP', source: 'cloudflare_hint' });
	});

	it.each(['jp', 'US', 'JPN', ' JP', 'JP '])(
		'ignores an invalid Cloudflare hint %j',
		(cloudflareCountry) => {
			expect(
				resolvePricingDestination({
					cookieValue: undefined,
					cloudflareCountry,
					allowedCountries: ['SE', 'JP']
				})
			).toMatchObject({ countryCode: 'SE', source: 'fallback' });
		}
	);

	it('falls back to Sweden when no valid preference remains', () => {
		expect(
			resolvePricingDestination({
				cookieValue: 'DE',
				cloudflareCountry: null,
				allowedCountries: ['SE', 'JP']
			})
		).toMatchObject({ countryCode: 'SE', source: 'fallback' });
	});

	it('requires Sweden to remain in the runtime allowlist', () => {
		expect(() =>
			resolvePricingDestination({
				cookieValue: undefined,
				cloudflareCountry: null,
				allowedCountries: ['DE', 'JP']
			})
		).toThrowError('PRICING_DESTINATION_FALLBACK_UNAVAILABLE');
	});

	it('returns runtime options ordered by region and English display name', () => {
		expect(destinationOptions(['SE', 'JP', 'DE', 'FI'])).toEqual([
			{ countryCode: 'FI', displayName: 'Finland', region: 'eu' },
			{ countryCode: 'DE', displayName: 'Germany', region: 'eu' },
			{ countryCode: 'SE', displayName: 'Sweden', region: 'eu' },
			{ countryCode: 'JP', displayName: 'Japan', region: 'asia' }
		]);
	});
});
