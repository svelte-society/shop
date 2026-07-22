import { describe, expect, it } from 'vitest';
import {
	ASIA_DESTINATIONS,
	EU_DESTINATIONS,
	INITIAL_STYRIA_SUPPORTED_DESTINATIONS,
	isMarketDestination,
	parseStyriaSupportedCountries
} from './destinations';

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
	'AE',
	'AF',
	'AM',
	'AZ',
	'BD',
	'BH',
	'BN',
	'BT',
	'CN',
	'GE',
	'HK',
	'ID',
	'IL',
	'IN',
	'IQ',
	'JP',
	'JO',
	'KG',
	'KH',
	'KR',
	'KW',
	'KZ',
	'LA',
	'LB',
	'LK',
	'MM',
	'MN',
	'MO',
	'MV',
	'MY',
	'NP',
	'OM',
	'PH',
	'PK',
	'PS',
	'QA',
	'SA',
	'SG',
	'TH',
	'TJ',
	'TL',
	'TM',
	'TR',
	'TW',
	'UZ',
	'VN',
	'YE'
] as const;

describe('Styria-supported destinations', () => {
	it('exports the reviewed regional lists', () => {
		expect(EU_DESTINATIONS).toEqual(expectedDestinations.slice(0, 26));
		expect(ASIA_DESTINATIONS).toEqual(expectedDestinations.slice(26));
	});

	it('freezes the exact reviewed initial allowlist without Slovenia or the United States', () => {
		expect(INITIAL_STYRIA_SUPPORTED_DESTINATIONS).toEqual(expectedDestinations);
		expect(Object.isFrozen(INITIAL_STYRIA_SUPPORTED_DESTINATIONS)).toBe(true);
		expect(INITIAL_STYRIA_SUPPORTED_DESTINATIONS).not.toContain('SI');
		expect(INITIAL_STYRIA_SUPPORTED_DESTINATIONS).not.toContain('US');
	});

	it('parses a trimmed provider allowlist and returns an immutable copy', () => {
		const parsed = parseStyriaSupportedCountries(' SE, JP, TW ');

		expect(parsed).toEqual(['SE', 'JP', 'TW']);
		expect(Object.isFrozen(parsed)).toBe(true);
	});

	it.each([undefined, '', ' ', 'se,JP', 'SE,JP,SE', 'SI', 'US,SI', 'GB', 'SE,ZZ', 'SE,JP,'])(
		'rejects an invalid provider allowlist %j',
		(value) => {
			expect(() => parseStyriaSupportedCountries(value)).toThrowError(
				'STYRIA_SUPPORTED_COUNTRIES_INVALID'
			);
		}
	);

	it('keeps the United States inside the market ceiling for a future reviewed re-enable', () => {
		expect(isMarketDestination('US')).toBe(true);
		expect(isMarketDestination('SI')).toBe(false);
		expect(isMarketDestination('GB')).toBe(false);
	});
});
