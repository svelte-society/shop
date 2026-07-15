import { describe, expect, it } from 'vitest';
import { ALLOWED_DESTINATIONS, isAllowedDestination } from './destinations';

const expectedDestinations = [
	'AT',
	'BE',
	'BG',
	'HR',
	'CY',
	'CZ',
	'DK',
	'EE',
	'FI',
	'FR',
	'DE',
	'GR',
	'HU',
	'IE',
	'IT',
	'LV',
	'LT',
	'LU',
	'MT',
	'NL',
	'PL',
	'PT',
	'RO',
	'SK',
	'ES',
	'SE',
	'US'
] as const;

describe('destinations', () => {
	it('freezes the exact approved allowlist', () => {
		expect(ALLOWED_DESTINATIONS).toEqual(expectedDestinations);
		expect(Object.isFrozen(ALLOWED_DESTINATIONS)).toBe(true);
	});

	it.each(expectedDestinations)('allows %s', (countryCode) => {
		expect(isAllowedDestination(countryCode)).toBe(true);
	});

	it('rejects Slovenia', () => {
		expect(isAllowedDestination('SI')).toBe(false);
	});
});
