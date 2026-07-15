import type { CatalogVariant } from '$lib/domain/catalog';
import type { CatalogGateway } from '$lib/server/catalog/gateway';
import { parseStripeCatalog } from '$lib/server/catalog/parse';
import {
	STRIPE_CATALOG_LOADED_AT,
	stripeAccessoryPrice,
	stripeAccessoryProduct,
	stripePrice,
	stripeProduct
} from './stripe-catalog';

type CatalogScenario = 'available' | 'unavailable' | 'guard-proof';

function scenario(): CatalogScenario {
	const value = process.env.TEST_CATALOG_SCENARIO ?? 'available';
	if (value === 'available' || value === 'unavailable' || value === 'guard-proof') return value;
	throw new Error('TEST_CATALOG_SCENARIO_INVALID');
}

const PRODUCTS = [
	stripeProduct({
		metadata: {
			sort_order: '10'
		}
	}),
	stripeAccessoryProduct({
		metadata: {
			sort_order: '20'
		}
	})
];

const PRICES_BY_PRODUCT = new Map([
	[
		'prod_apparel',
		[
			stripePrice({
				id: 'price_apparel_small',
				metadata: {
					label: 'S',
					sort_order: '10',
					sku: 'SS-TEE-S',
					styria_pn: 'STYRIA-TEE-S'
				}
			}),
			stripePrice()
		]
	],
	['prod_accessory', [stripeAccessoryPrice()]]
]);

async function parsedFixtureCatalog() {
	return parseStripeCatalog(
		PRODUCTS,
		async (productId) => PRICES_BY_PRODUCT.get(productId) ?? [],
		STRIPE_CATALOG_LOADED_AT
	);
}

export function createCatalogGateway(stripeSecretKey: string): CatalogGateway {
	void stripeSecretKey;
	const activeScenario = scenario();
	if (activeScenario === 'guard-proof') throw new Error('STOREFRONT_GUARD_BYPASSED');

	async function loadMerchCatalog() {
		if (activeScenario === 'unavailable') throw new Error('CATALOG_UNAVAILABLE');
		return parsedFixtureCatalog();
	}

	return {
		loadMerchCatalog,
		async resolveVariants(priceIds) {
			const snapshot = await loadMerchCatalog();
			const variants = new Map<string, CatalogVariant>();

			for (const product of snapshot.products) {
				for (const variant of product.variants) variants.set(variant.priceId, variant);
			}

			return priceIds
				.map((priceId) => variants.get(priceId))
				.filter((variant): variant is CatalogVariant => variant !== undefined);
		}
	};
}
