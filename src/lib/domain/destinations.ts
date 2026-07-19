const EU_DESTINATIONS = [
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
	'SE'
] as const;

const ASIA_DESTINATIONS = [
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

export type MarketDestination =
	(typeof EU_DESTINATIONS)[number] | (typeof ASIA_DESTINATIONS)[number] | 'US';

export const MARKET_CEILING_DESTINATIONS: readonly MarketDestination[] = Object.freeze([
	...EU_DESTINATIONS,
	...ASIA_DESTINATIONS,
	'US'
]);

export const INITIAL_STYRIA_SUPPORTED_DESTINATIONS: readonly MarketDestination[] = Object.freeze([
	...EU_DESTINATIONS,
	...ASIA_DESTINATIONS
]);

// Compatibility alias for code paths that are migrated to injected runtime policy incrementally.
export const ALLOWED_DESTINATIONS = INITIAL_STYRIA_SUPPORTED_DESTINATIONS;

const marketDestinationSet: ReadonlySet<string> = new Set(MARKET_CEILING_DESTINATIONS);
const initialDestinationSet: ReadonlySet<string> = new Set(INITIAL_STYRIA_SUPPORTED_DESTINATIONS);

export function isMarketDestination(countryCode: string): countryCode is MarketDestination {
	return marketDestinationSet.has(countryCode);
}

export function isAllowedDestination(countryCode: string): countryCode is MarketDestination {
	return initialDestinationSet.has(countryCode);
}

export function parseStyriaSupportedCountries(
	value: string | undefined
): readonly MarketDestination[] {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error('STYRIA_SUPPORTED_COUNTRIES_INVALID');
	}

	const countries = value.split(',').map((country) => country.trim());
	const unique = new Set<string>();
	for (const country of countries) {
		if (!/^[A-Z]{2}$/u.test(country) || !isMarketDestination(country) || unique.has(country)) {
			throw new Error('STYRIA_SUPPORTED_COUNTRIES_INVALID');
		}
		unique.add(country);
	}

	if (unique.size === 0) throw new Error('STYRIA_SUPPORTED_COUNTRIES_INVALID');
	return Object.freeze([...unique] as MarketDestination[]);
}
