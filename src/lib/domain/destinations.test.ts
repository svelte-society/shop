import { describe, expect, it } from 'vitest';
import {
	ASIA_DESTINATIONS,
	EU_DESTINATIONS,
	SUPPORTED_DESTINATIONS,
	isSupportedDestination
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
		expect(Object.isFrozen(EU_DESTINATIONS)).toBe(true);
		expect(Object.isFrozen(ASIA_DESTINATIONS)).toBe(true);
	});

	it('freezes the exact source-controlled policy without Slovenia or the United States', () => {
		expect(SUPPORTED_DESTINATIONS).toEqual(expectedDestinations);
		expect(Object.isFrozen(SUPPORTED_DESTINATIONS)).toBe(true);
		expect(SUPPORTED_DESTINATIONS).not.toContain('SI');
		expect(SUPPORTED_DESTINATIONS).not.toContain('US');
	});

	it('recognizes only members of the source-controlled policy', () => {
		expect(isSupportedDestination('SE')).toBe(true);
		expect(isSupportedDestination('JP')).toBe(true);
		expect(isSupportedDestination('US')).toBe(false);
		expect(isSupportedDestination('SI')).toBe(false);
		expect(isSupportedDestination('GB')).toBe(false);
	});
});
