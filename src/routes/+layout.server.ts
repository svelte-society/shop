import { env } from '$env/dynamic/private';
import { parsePublicConfig } from '$lib/config/public';
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
	return ({ route }) => {
		const config = parsePublicConfig(runtimeEnv);

		return {
			storefrontEnabled: config.storefrontEnabled,
			checkoutEnabled: config.checkoutEnabled,
			showOpeningSoon: !config.storefrontEnabled && isCommerceRoute(route.id),
			umami: umamiConfig(runtimeEnv)
		};
	};
}

export const load: LayoutServerLoad = _createLayoutServerLoad(env);
