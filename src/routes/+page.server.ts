import { env } from '$env/dynamic/private';
import { parsePrivateConfig } from '$lib/config/private.server';
import type { CatalogGateway } from '$lib/server/catalog/gateway';
import type { CatalogService } from '$lib/server/catalog/service.server';
import { createCatalogService } from '$lib/server/catalog/service.server';
import { createStripeCatalogGateway } from '$lib/server/catalog/stripe-catalog.server';
import { requireStorefront } from '$lib/server/storefront/guard.server';
import type { PageServerLoad } from './$types';

type CatalogGatewayFactory = (stripeSecretKey: string) => CatalogGateway;

function isCatalogUnavailable(error: unknown): boolean {
	return error instanceof Error && error.message === 'CATALOG_UNAVAILABLE';
}

export function _createHomePageServerLoad(
	runtimeEnv: Record<string, string | undefined>,
	createGateway: CatalogGatewayFactory = createStripeCatalogGateway
): PageServerLoad {
	let catalogService: CatalogService | undefined;

	return async () => {
		const publicConfig = requireStorefront(runtimeEnv, { whenDisabled: 'opening-soon' });

		if (!publicConfig.storefrontEnabled) {
			return { products: [], stale: false, catalogUnavailable: false };
		}

		const config = parsePrivateConfig(runtimeEnv);
		catalogService ??= createCatalogService(createGateway(config.stripeSecretKey));

		try {
			const catalog = await catalogService.listPublic();
			return { ...catalog, catalogUnavailable: false };
		} catch (error) {
			if (!isCatalogUnavailable(error)) throw error;
			return { products: [], stale: false, catalogUnavailable: true };
		}
	};
}

export const load: PageServerLoad = _createHomePageServerLoad(env);
