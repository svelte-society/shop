import { env } from '$env/dynamic/private';
import { parsePrivateConfig } from '$lib/config/private.server';
import { createCatalogGateway } from '$lib/server/catalog/runtime-gateway.server';
import type { CatalogService } from '$lib/server/catalog/service.server';
import { createCatalogService } from '$lib/server/catalog/service.server';
import { requireStorefront } from '$lib/server/storefront/guard.server';
import type { PageServerLoad } from './$types';

let catalogService: CatalogService | undefined;

function isCatalogUnavailable(error: unknown): boolean {
	return error instanceof Error && error.message === 'CATALOG_UNAVAILABLE';
}

export const load: PageServerLoad = async () => {
	requireStorefront(env);
	const config = parsePrivateConfig(env);
	catalogService ??= createCatalogService(createCatalogGateway(config.stripeSecretKey));

	try {
		const catalog = await catalogService.listPublic();

		return {
			products: catalog.products,
			catalogUnavailable: false,
			checkoutEnabled: config.checkoutEnabled
		};
	} catch (error) {
		if (!isCatalogUnavailable(error)) throw error;

		return {
			products: [],
			catalogUnavailable: true,
			checkoutEnabled: false
		};
	}
};
