import type { CartLine } from '$lib/domain/cart';
import {
	assertCatalogSnapshot,
	immutableCatalogSnapshot,
	toPublicCatalogProduct,
	type CatalogDiagnostic,
	type CatalogProduct,
	type CatalogSnapshot,
	type CatalogShippingRates,
	type CatalogVariant,
	type PublicCatalogProduct
} from '$lib/domain/catalog';
import { createCatalogCache, type CatalogCacheOptions } from './cache.server';
import type { CatalogGateway } from './gateway';
import { enqueueAlert, type AlertService } from '$lib/server/monitoring/alerts.server';

export interface CatalogService {
	listPublic(): Promise<{
		products: PublicCatalogProduct[];
		paidShippingNetCents: number;
		stale: boolean;
	}>;
	findPublicBySlug(slug: string): Promise<PublicCatalogProduct | null>;
	resolveCart(lines: CartLine[]): Promise<{
		lines: Array<{ line: CartLine; product: CatalogProduct; variant: CatalogVariant }>;
		shippingRates: CatalogShippingRates;
	}>;
	resolveCartForCheckout(lines: CartLine[]): Promise<{
		lines: Array<{ line: CartLine; product: CatalogProduct; variant: CatalogVariant }>;
		shippingRates: CatalogShippingRates;
	}>;
	diagnostics(): Promise<CatalogDiagnostic[]>;
}

export function createCatalogService(
	gateway: CatalogGateway,
	cacheOptions: CatalogCacheOptions = {},
	alerts: AlertService = { enqueueAlert }
): CatalogService {
	const cache = createCatalogCache(() => gateway.loadMerchCatalog(), cacheOptions);
	const clock = cacheOptions.clock ?? (() => new Date());

	function notifyUnavailable(): void {
		try {
			alerts.enqueueAlert('CATALOG_UNAVAILABLE', 'stripe-catalog', clock());
		} catch {
			// Catalog fallback and fail-closed behavior must not depend on alert persistence.
		}
	}

	async function monitoredSnapshot() {
		try {
			const snapshot = await cache.get();
			if (snapshot.stale) notifyUnavailable();
			return snapshot;
		} catch (error) {
			notifyUnavailable();
			throw error;
		}
	}

	function resolveSnapshot(snapshot: CatalogSnapshot, lines: CartLine[]) {
		const byPriceId = new Map<string, { product: CatalogProduct; variant: CatalogVariant }>();

		for (const product of snapshot.products) {
			for (const variant of product.variants) {
				byPriceId.set(variant.priceId, { product, variant });
			}
		}

		return {
			lines: lines.map((line) => {
				const resolved = byPriceId.get(line.priceId);
				if (!resolved) throw new Error('CATALOG_VARIANT_UNAVAILABLE');
				return { line: { ...line }, ...resolved };
			}),
			shippingRates: snapshot.shippingRates
		};
	}

	return {
		async listPublic() {
			const snapshot = await monitoredSnapshot();
			return {
				products: snapshot.products.map(toPublicCatalogProduct),
				paidShippingNetCents: snapshot.shippingRates.paid.netAmountCents,
				stale: snapshot.stale
			};
		},
		async findPublicBySlug(slug) {
			const snapshot = await monitoredSnapshot();
			const product = snapshot.products.find((candidate) => candidate.slug === slug);
			return product ? toPublicCatalogProduct(product) : null;
		},
		async resolveCart(lines) {
			return resolveSnapshot(await monitoredSnapshot(), lines);
		},
		async resolveCartForCheckout(lines) {
			const loaded = await gateway.loadMerchCatalog();
			assertCatalogSnapshot(loaded);
			if (loaded.stale) throw new Error('CATALOG_UNAVAILABLE');
			return resolveSnapshot(immutableCatalogSnapshot(loaded, false), lines);
		},
		async diagnostics() {
			const snapshot = await monitoredSnapshot();
			return snapshot.diagnostics.map((entry) => ({ ...entry }));
		}
	};
}
