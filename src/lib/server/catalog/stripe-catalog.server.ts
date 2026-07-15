import Stripe from 'stripe';
import type { CatalogGateway } from './gateway';
import type { CatalogVariant } from '$lib/domain/catalog';
import { parseStripeCatalog } from './parse';

export type StripeCatalogClient = {
	products: {
		list(params: Stripe.ProductListParams): Promise<Stripe.ApiList<Stripe.Product>>;
	};
	prices: {
		list(params: Stripe.PriceListParams): Promise<Stripe.ApiList<Stripe.Price>>;
	};
};

export type StripeCatalogGatewayOptions = {
	client?: StripeCatalogClient;
	clock?: () => Date;
};

async function listProducts(client: StripeCatalogClient): Promise<Stripe.Product[]> {
	const products: Stripe.Product[] = [];
	let startingAfter: string | undefined;
	let hasMore = true;

	while (hasMore) {
		const page = await client.products.list({
			active: true,
			limit: 100,
			expand: ['data.default_price'],
			...(startingAfter ? { starting_after: startingAfter } : {})
		});
		products.push(...page.data);
		hasMore = page.has_more;

		if (!hasMore) break;
		const last = page.data.at(-1);
		if (!last) throw new Error('CATALOG_PROVIDER_INVALID');
		startingAfter = last.id;
	}

	return products;
}

async function listPrices(client: StripeCatalogClient, productId: string): Promise<Stripe.Price[]> {
	const prices: Stripe.Price[] = [];
	let startingAfter: string | undefined;
	let hasMore = true;

	while (hasMore) {
		const page = await client.prices.list({
			active: true,
			product: productId,
			limit: 100,
			...(startingAfter ? { starting_after: startingAfter } : {})
		});
		prices.push(...page.data);
		hasMore = page.has_more;

		if (!hasMore) break;
		const last = page.data.at(-1);
		if (!last) throw new Error('CATALOG_PROVIDER_INVALID');
		startingAfter = last.id;
	}

	return prices;
}

export function createStripeCatalogGateway(
	stripeSecretKey: string,
	options: StripeCatalogGatewayOptions = {}
): CatalogGateway {
	const client = options.client ?? new Stripe(stripeSecretKey);
	const clock = options.clock ?? (() => new Date());

	async function loadMerchCatalog() {
		const products = await listProducts(client);
		return parseStripeCatalog(products, (productId) => listPrices(client, productId), clock());
	}

	return {
		loadMerchCatalog,
		async resolveVariants(priceIds) {
			const snapshot = await loadMerchCatalog();
			const variantsById = new Map<string, CatalogVariant>();

			for (const product of snapshot.products) {
				for (const variant of product.variants) variantsById.set(variant.priceId, variant);
			}

			return priceIds
				.map((priceId) => variantsById.get(priceId))
				.filter((variant): variant is CatalogVariant => variant !== undefined);
		}
	};
}
