export const ALLOWED_DESTINATIONS: readonly string[] = Object.freeze([
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
]);

const allowedDestinationSet = new Set(ALLOWED_DESTINATIONS);

export function isAllowedDestination(countryCode: string): boolean {
	return allowedDestinationSet.has(countryCode);
}
