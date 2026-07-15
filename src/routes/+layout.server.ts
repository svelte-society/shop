import { env } from '$env/dynamic/private';
import { parsePublicConfig } from '$lib/config/public';
import type { LayoutServerLoad } from './$types';

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

export function _createLayoutServerLoad(
	runtimeEnv: Record<string, string | undefined>
): LayoutServerLoad {
	return ({ route }) => {
		const config = parsePublicConfig(runtimeEnv);

		return {
			storefrontEnabled: config.storefrontEnabled,
			checkoutEnabled: config.checkoutEnabled,
			showOpeningSoon: !config.storefrontEnabled && isCommerceRoute(route.id)
		};
	};
}

export const load: LayoutServerLoad = _createLayoutServerLoad(env);
