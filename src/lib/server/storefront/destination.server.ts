import {
	pricingDestination,
	type DestinationOption,
	type PricingDestination
} from '$lib/domain/pricing';
import type { MarketDestination } from '$lib/domain/destinations';

export const DESTINATION_COOKIE = 'shop_destination_v1';

export type DestinationSource = 'cookie' | 'cloudflare_hint' | 'fallback';
export type ResolvedPricingDestination = PricingDestination & { source: DestinationSource };

function containsCountry(
	allowedCountries: readonly MarketDestination[],
	countryCode: string | null | undefined
): countryCode is MarketDestination {
	return (
		typeof countryCode === 'string' &&
		/^[A-Z]{2}$/u.test(countryCode) &&
		allowedCountries.includes(countryCode as MarketDestination)
	);
}

function requireSweden(allowedCountries: readonly MarketDestination[]): void {
	if (!allowedCountries.includes('SE')) throw new Error('PRICING_DESTINATION_FALLBACK_UNAVAILABLE');
}

export function resolvePricingDestination(input: {
	cookieValue: string | undefined;
	cloudflareCountry: string | null;
	allowedCountries: readonly MarketDestination[];
}): ResolvedPricingDestination {
	requireSweden(input.allowedCountries);
	if (containsCountry(input.allowedCountries, input.cookieValue)) {
		return { ...pricingDestination(input.cookieValue), source: 'cookie' };
	}
	if (containsCountry(input.allowedCountries, input.cloudflareCountry)) {
		return { ...pricingDestination(input.cloudflareCountry), source: 'cloudflare_hint' };
	}
	return { ...pricingDestination('SE'), source: 'fallback' };
}

export function destinationOptions(
	allowedCountries: readonly MarketDestination[]
): readonly DestinationOption[] {
	requireSweden(allowedCountries);
	return allowedCountries
		.map((countryCode) => {
			const { displayName, region } = pricingDestination(countryCode);
			return { countryCode, displayName, region };
		})
		.sort((left, right) => {
			if (left.region !== right.region) return left.region === 'eu' ? -1 : 1;
			return left.displayName.localeCompare(right.displayName, 'en');
		});
}
