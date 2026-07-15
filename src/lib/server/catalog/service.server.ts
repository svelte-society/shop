import type { CartLine } from '$lib/domain/cart';
import {
	toPublicCatalogProduct,
	type CatalogDiagnostic,
	type CatalogProduct,
	type CatalogVariant,
	type PublicCatalogProduct
} from '$lib/domain/catalog';
import { createCatalogCache, type CatalogCacheOptions } from './cache.server';
import type { CatalogGateway } from './gateway';

export interface CatalogService {
	listPublic(): Promise<{ products: PublicCatalogProduct[]; stale: boolean }>;
	findPublicBySlug(slug: string): Promise<PublicCatalogProduct | null>;
	resolveCart(
		lines: CartLine[]
	): Promise<Array<{ line: CartLine; product: CatalogProduct; variant: CatalogVariant }>>;
	diagnostics(): Promise<CatalogDiagnostic[]>;
}

export function createCatalogService(
	gateway: CatalogGateway,
	cacheOptions: CatalogCacheOptions = {}
): CatalogService {
	const cache = createCatalogCache(() => gateway.loadMerchCatalog(), cacheOptions);

	return {
		async listPublic() {
			const snapshot = await cache.get();
			return {
				products: snapshot.products.map(toPublicCatalogProduct),
				stale: snapshot.stale
			};
		},
		async findPublicBySlug(slug) {
			const snapshot = await cache.get();
			const product = snapshot.products.find((candidate) => candidate.slug === slug);
			return product ? toPublicCatalogProduct(product) : null;
		},
		async resolveCart(lines) {
			const snapshot = await cache.get();
			const byPriceId = new Map<string, { product: CatalogProduct; variant: CatalogVariant }>();

			for (const product of snapshot.products) {
				for (const variant of product.variants) {
					byPriceId.set(variant.priceId, { product, variant });
				}
			}

			return lines.map((line) => {
				const resolved = byPriceId.get(line.priceId);
				if (!resolved) throw new Error('CATALOG_VARIANT_UNAVAILABLE');
				return { line: { ...line }, ...resolved };
			});
		},
		async diagnostics() {
			const snapshot = await cache.get();
			return snapshot.diagnostics.map((entry) => ({ ...entry }));
		}
	};
}
