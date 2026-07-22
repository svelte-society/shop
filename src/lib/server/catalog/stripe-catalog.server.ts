import Stripe from 'stripe';
import type { CatalogGateway } from './gateway';
import { parseStripeCatalog, parseStripeShippingRates } from './parse';

export type StripeCatalogClient = {
	products: {
		list(params: Stripe.ProductListParams): Promise<Stripe.ApiList<Stripe.Product>>;
	};
	prices: {
		list(params: Stripe.PriceListParams): Promise<Stripe.ApiList<Stripe.Price>>;
	};
	shippingRates: {
		retrieve(id: string): Promise<Stripe.ShippingRate>;
	};
};

export type StripeCatalogGatewayOptions = {
	paidShippingRateId: string;
	freeShippingRateId: string;
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
	options: StripeCatalogGatewayOptions
): CatalogGateway {
	const client = options.client ?? new Stripe(stripeSecretKey);
	const clock = options.clock ?? (() => new Date());

	async function loadMerchCatalog() {
		if (!options.paidShippingRateId.trim() || !options.freeShippingRateId.trim()) {
			throw new Error('CATALOG_SHIPPING_RATE_INVALID');
		}
		const [products, paidRate, freeRate] = await Promise.all([
			listProducts(client),
			client.shippingRates.retrieve(options.paidShippingRateId),
			client.shippingRates.retrieve(options.freeShippingRateId)
		]);
		const shippingRates = parseStripeShippingRates({
			paid: { configuredId: options.paidShippingRateId, rate: paidRate },
			free: { configuredId: options.freeShippingRateId, rate: freeRate }
		});
		return parseStripeCatalog(
			products,
			(productId) => listPrices(client, productId),
			clock(),
			shippingRates
		);
	}

	return { loadMerchCatalog };
}
