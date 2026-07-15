import { env } from '$env/dynamic/private';
import { parsePrivateConfig } from '$lib/config/private.server';
import type { CatalogService } from '$lib/server/catalog/service.server';
import { createCatalogService } from '$lib/server/catalog/service.server';
import { createStripeCatalogGateway } from '$lib/server/catalog/stripe-catalog.server';
import type { PageServerLoad } from './$types';

let catalogService: CatalogService | undefined;

function isCatalogUnavailable(error: unknown): boolean {
	return error instanceof Error && error.message === 'CATALOG_UNAVAILABLE';
}

export const load: PageServerLoad = async () => {
	const config = parsePrivateConfig(env);
	catalogService ??= createCatalogService(createStripeCatalogGateway(config.stripeSecretKey));

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
