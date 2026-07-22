import { env } from '$env/dynamic/private';
import { createPolicyDocuments, type PolicyDocuments } from '$lib/content/policies';
import { parseSellerPolicyConfig } from '$lib/config/private.server';
import { parsePublicConfig } from '$lib/config/public';
import {
	destinationOptions,
	resolvePricingDestination,
	DESTINATION_COOKIE
} from '$lib/server/storefront/destination.server';
import type { LayoutServerLoad } from './$types';

type UmamiConfig = {
	scriptUrl: string;
	connectOrigin: string | null;
	websiteId: string;
};

function isCommerceRoute(routeId: string | null): boolean {
	if (routeId === null) return false;

	return (
		routeId === '/' ||
		routeId === '/cart' ||
		routeId.startsWith('/cart/') ||
		routeId === '/products' ||
		routeId.startsWith('/products/') ||
		routeId === '/checkout' ||
		routeId.startsWith('/checkout/')
	);
}

function policyRoute(routeId: string | null): keyof PolicyDocuments | null {
	if (routeId === '/shipping') return 'shipping';
	if (routeId === '/returns') return 'returns';
	if (routeId === '/privacy') return 'privacy';
	if (routeId === '/terms') return 'terms';
	if (routeId === '/about') return 'about';
	return null;
}

function httpsScriptUrl(value: string | undefined): string | null {
	if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null;

	try {
		const parsed = new URL(value);
		if (
			parsed.protocol !== 'https:' ||
			parsed.username ||
			parsed.password ||
			parsed.hostname.includes('*') ||
			parsed.hash
		) {
			return null;
		}

		return value;
	} catch {
		return null;
	}
}

function exactHttpsOrigin(value: string | undefined): string | null {
	if (typeof value !== 'string' || value.length === 0) return null;

	try {
		const parsed = new URL(value.trim());
		if (
			parsed.protocol !== 'https:' ||
			parsed.username ||
			parsed.password ||
			parsed.hostname.includes('*') ||
			parsed.pathname !== '/' ||
			parsed.search ||
			parsed.hash
		) {
			return null;
		}

		return parsed.origin;
	} catch {
		return null;
	}
}

function umamiConfig(runtimeEnv: Record<string, string | undefined>): UmamiConfig | null {
	const scriptUrl = httpsScriptUrl(runtimeEnv.UMAMI_SCRIPT_URL);
	const websiteId = runtimeEnv.UMAMI_WEBSITE_ID?.trim() ?? '';
	if (!scriptUrl || !websiteId) return null;

	return {
		scriptUrl,
		connectOrigin: exactHttpsOrigin(runtimeEnv.UMAMI_CONNECT_ORIGIN),
		websiteId
	};
}

export function _createLayoutServerLoad(
	runtimeEnv: Record<string, string | undefined>
): LayoutServerLoad {
	return ({ route, cookies, request, depends }) => {
		const config = parsePublicConfig(runtimeEnv);
		const resolvedPricingDestination = resolvePricingDestination({
			cookieValue: cookies.get(DESTINATION_COOKIE),
			cloudflareCountry: request.headers.get('cf-ipcountry')
		});
		depends('app:pricing-destination');
		const requestedPolicy = policyRoute(route.id);
		const policyDocument = requestedPolicy
			? createPolicyDocuments({
					...parseSellerPolicyConfig(runtimeEnv),
					supportEmail: config.supportEmail
				})[requestedPolicy]
			: null;

		return {
			storefrontEnabled: config.storefrontEnabled,
			checkoutEnabled: config.checkoutEnabled,
			showOpeningSoon: !config.storefrontEnabled && isCommerceRoute(route.id),
			policyDocument,
			umami: umamiConfig(runtimeEnv),
			pricingDestination: {
				countryCode: resolvedPricingDestination.countryCode,
				displayName: resolvedPricingDestination.displayName,
				region: resolvedPricingDestination.region,
				vatBasisPoints: resolvedPricingDestination.vatBasisPoints,
				requiresImportChargeCopy: resolvedPricingDestination.requiresImportChargeCopy
			},
			destinationOptions: destinationOptions()
		};
	};
}

export const load: LayoutServerLoad = _createLayoutServerLoad(env);
