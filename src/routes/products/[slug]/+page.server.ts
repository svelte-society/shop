import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';
import { parsePrivateConfig } from '$lib/config/private.server';
import type { CatalogGateway } from '$lib/server/catalog/gateway';
import { createCatalogGateway } from '$lib/server/catalog/runtime-gateway.server';
import type { CatalogService } from '$lib/server/catalog/service.server';
import { createCatalogService } from '$lib/server/catalog/service.server';
import { requireStorefront } from '$lib/server/storefront/guard.server';
import type { PageServerLoad } from './$types';

type CatalogGatewayFactory = (
	stripeSecretKey: string,
	options: { paidShippingRateId: string; freeShippingRateId: string }
) => CatalogGateway;

function isCatalogUnavailable(cause: unknown): boolean {
	return cause instanceof Error && cause.message === 'CATALOG_UNAVAILABLE';
}

export function _createProductPageServerLoad(
	runtimeEnv: Record<string, string | undefined>,
	createGateway: CatalogGatewayFactory = createCatalogGateway
): PageServerLoad {
	let catalogService: CatalogService | undefined;

	return async ({ params }) => {
		requireStorefront(runtimeEnv);
		const config = parsePrivateConfig(runtimeEnv);
		catalogService ??= createCatalogService(
			createGateway(config.stripeSecretKey, {
				paidShippingRateId: config.stripePaidShippingRateId,
				freeShippingRateId: config.stripeFreeShippingRateId
			})
		);

		try {
			const product = await catalogService.findPublicBySlug(params.slug);
			if (!product) error(404, 'PRODUCT_NOT_FOUND');

			return { product, catalogUnavailable: false };
		} catch (cause) {
			if (!isCatalogUnavailable(cause)) throw cause;
			return { product: null, catalogUnavailable: true };
		}
	};
}

export const load: PageServerLoad = _createProductPageServerLoad(env);
