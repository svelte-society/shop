import type { CatalogSnapshot } from '$lib/domain/catalog';

export interface CatalogGateway {
	loadMerchCatalog(): Promise<CatalogSnapshot>;
}
