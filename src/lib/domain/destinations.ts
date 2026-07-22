export const EU_DESTINATIONS = Object.freeze([
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
] as const);

export const ASIA_DESTINATIONS = Object.freeze([
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
] as const);

export type MarketDestination =
	(typeof EU_DESTINATIONS)[number] | (typeof ASIA_DESTINATIONS)[number];

export const SUPPORTED_DESTINATIONS: readonly MarketDestination[] = Object.freeze([
	...EU_DESTINATIONS,
	...ASIA_DESTINATIONS
]);

const supportedDestinationSet: ReadonlySet<string> = new Set(SUPPORTED_DESTINATIONS);

export function isSupportedDestination(countryCode: string): countryCode is MarketDestination {
	return supportedDestinationSet.has(countryCode);
}
