import type { CatalogSnapshot, CatalogVariant } from '$lib/domain/catalog';

export interface CatalogGateway {
	loadMerchCatalog(): Promise<CatalogSnapshot>;
	resolveVariants(priceIds: readonly string[]): Promise<CatalogVariant[]>;
}
