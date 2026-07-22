import {
	pricingDestination,
	type DestinationOption,
	type PricingDestination
} from '$lib/domain/pricing';
import {
	isSupportedDestination,
	SUPPORTED_DESTINATIONS,
	type MarketDestination
} from '$lib/domain/destinations';

export const DESTINATION_COOKIE = 'shop_destination_v1';

export type DestinationSource = 'cookie' | 'cloudflare_hint' | 'fallback';
export type ResolvedPricingDestination = PricingDestination & { source: DestinationSource };

function containsCountry(countryCode: string | null | undefined): countryCode is MarketDestination {
	return (
		typeof countryCode === 'string' &&
		/^[A-Z]{2}$/u.test(countryCode) &&
		isSupportedDestination(countryCode)
	);
}

export function resolvePricingDestination(input: {
	cookieValue: string | undefined;
	cloudflareCountry: string | null;
}): ResolvedPricingDestination {
	if (containsCountry(input.cookieValue)) {
		return { ...pricingDestination(input.cookieValue), source: 'cookie' };
	}
	if (containsCountry(input.cloudflareCountry)) {
		return { ...pricingDestination(input.cloudflareCountry), source: 'cloudflare_hint' };
	}
	return { ...pricingDestination('SE'), source: 'fallback' };
}

export function destinationOptions(): readonly DestinationOption[] {
	return SUPPORTED_DESTINATIONS.map((countryCode) => {
		const { displayName, region } = pricingDestination(countryCode);
		return { countryCode, displayName, region };
	}).sort((left, right) => {
		if (left.region !== right.region) return left.region === 'eu' ? -1 : 1;
		return left.displayName.localeCompare(right.displayName, 'en');
	});
}
