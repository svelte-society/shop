import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import type { CatalogSnapshot } from '$lib/domain/catalog';
import {
	STRIPE_CATALOG_LOADED_AT,
	stripeAccessoryPrice,
	stripeAccessoryProduct,
	stripeList,
	stripePrice,
	stripeProduct
} from '../../../../tests/fixtures/stripe-catalog';
import { createCatalogCache } from './cache.server';
import { parseStripeCatalog } from './parse';
import { createCatalogService } from './service.server';
import { createStripeCatalogGateway, type StripeCatalogClient } from './stripe-catalog.server';

function page<T extends { id: string }>(
	items: readonly T[],
	startingAfter: string | undefined,
	url: string
): Stripe.ApiList<T> {
	const previousIndex = startingAfter ? items.findIndex((item) => item.id === startingAfter) : -1;
	const data = items.slice(previousIndex + 1, previousIndex + 2);

	return {
		...stripeList(data),
		has_more: previousIndex + 1 + data.length < items.length,
		url
	};
}

function providerClient(
	products: readonly Stripe.Product[],
	prices: readonly Stripe.Price[]
): { client: StripeCatalogClient; priceRequests: string[] } {
	const priceRequests: string[] = [];

	return {
		client: {
			products: {
				async list(params) {
					expect(params).toMatchObject({
						active: true,
						limit: 100,
						expand: ['data.default_price']
					});
					return page(products, params.starting_after, '/v1/products');
				}
			},
			prices: {
				async list(params) {
					expect(params).toMatchObject({ active: true, limit: 100 });
					if (!params.product) throw new Error('TEST_PRICE_PRODUCT_REQUIRED');
					priceRequests.push(params.product);
					return page(
						prices.filter((price) => {
							const productId =
								typeof price.product === 'string' ? price.product : price.product.id;
							return productId === params.product;
						}),
						params.starting_after,
						'/v1/prices'
					);
				}
			}
		},
		priceRequests
	};
}

async function validSnapshot(loadedAt: Date, name = 'Society Mug'): Promise<CatalogSnapshot> {
	return parseStripeCatalog(
		[stripeAccessoryProduct({ name })],
		async () => [stripeAccessoryPrice()],
		loadedAt
	);
}

describe('createStripeCatalogGateway', () => {
	it('paginates active Products and every active Price while parsing only accepted merch', async () => {
		const apparel = stripeProduct();
		const invalid = stripeProduct({ id: 'prod_invalid', images: [] });
		const nonMerch = stripeProduct({
			id: 'prod_non_merch',
			metadata: { product_type: 'donation', slug: 'support' }
		});
		const small = stripePrice({
			id: 'price_apparel_small',
			metadata: { label: 'S', sort_order: '10', sku: 'SS-TEE-S', styria_pn: 'STYRIA-TEE-S' }
		});
		const { client, priceRequests } = providerClient(
			[nonMerch, invalid, apparel],
			[stripePrice(), small]
		);
		const gateway = createStripeCatalogGateway('sk_test_catalog', {
			client,
			clock: () => new Date(STRIPE_CATALOG_LOADED_AT)
		});

		const snapshot = await gateway.loadMerchCatalog();

		expect(snapshot.products).toHaveLength(1);
		expect(snapshot.products[0].variants.map((variant) => variant.priceId)).toEqual([
			'price_apparel_small',
			'price_apparel_medium'
		]);
		expect(snapshot.diagnostics).toEqual([
			{ providerId: 'prod_invalid', code: 'PRODUCT_IMAGE_INVALID' }
		]);
		expect(priceRequests).not.toContain('prod_invalid');
		expect(priceRequests).not.toContain('prod_non_merch');
	});

	it('resolves requested variants from the validated provider catalog', async () => {
		const small = stripePrice({
			id: 'price_apparel_small',
			metadata: { label: 'S', sort_order: '10', sku: 'SS-TEE-S', styria_pn: 'STYRIA-TEE-S' }
		});
		const { client } = providerClient([stripeProduct()], [stripePrice(), small]);
		const gateway = createStripeCatalogGateway('sk_test_catalog', { client });

		const variants = await gateway.resolveVariants([
			'price_apparel_medium',
			'price_missing',
			'price_apparel_small'
		]);

		expect(variants.map((variant) => variant.priceId)).toEqual([
			'price_apparel_medium',
			'price_apparel_small'
		]);
	});
});

describe('createCatalogCache', () => {
	it('returns the fresh validated value without reloading inside 60 seconds', async () => {
		let now = new Date(STRIPE_CATALOG_LOADED_AT);
		let loads = 0;
		const cache = createCatalogCache(
			async () => {
				loads += 1;
				return validSnapshot(now);
			},
			{ clock: () => new Date(now) }
		);

		const first = await cache.get();
		now = new Date(STRIPE_CATALOG_LOADED_AT.getTime() + 59_999);
		const second = await cache.get();

		expect(first.stale).toBe(false);
		expect(second.stale).toBe(false);
		expect(second.products[0].name).toBe('Society Mug');
		expect(loads).toBe(1);
	});

	it('refreshes an expired value at the 60-second boundary', async () => {
		let now = new Date(STRIPE_CATALOG_LOADED_AT);
		let loads = 0;
		const cache = createCatalogCache(
			async () => {
				loads += 1;
				return validSnapshot(now, loads === 1 ? 'First Mug' : 'Refreshed Mug');
			},
			{ clock: () => new Date(now) }
		);

		await cache.get();
		now = new Date(STRIPE_CATALOG_LOADED_AT.getTime() + 60_000);
		const refreshed = await cache.get();

		expect(refreshed.products[0].name).toBe('Refreshed Mug');
		expect(refreshed.loadedAt).toEqual(now);
		expect(loads).toBe(2);
	});

	it('serves a recent last-known-good snapshot as stale when refresh fails', async () => {
		let now = new Date(STRIPE_CATALOG_LOADED_AT);
		let fail = false;
		const cache = createCatalogCache(
			async () => {
				if (fail) throw new Error('STRIPE_UNAVAILABLE');
				return validSnapshot(now);
			},
			{ clock: () => new Date(now) }
		);

		await cache.get();
		fail = true;
		now = new Date(STRIPE_CATALOG_LOADED_AT.getTime() + 60_000);
		const stale = await cache.get();

		expect(stale.stale).toBe(true);
		expect(stale.loadedAt).toEqual(STRIPE_CATALOG_LOADED_AT);
		expect(stale.products[0].slug).toBe('society-mug');
	});

	it('throws CATALOG_UNAVAILABLE when no last-known-good snapshot exists', async () => {
		const cache = createCatalogCache(
			async () => {
				throw new Error('STRIPE_UNAVAILABLE');
			},
			{ clock: () => new Date(STRIPE_CATALOG_LOADED_AT) }
		);

		await expect(cache.get()).rejects.toThrowError('CATALOG_UNAVAILABLE');
	});

	it('does not serve a failed refresh beyond the 15-minute stale window', async () => {
		let now = new Date(STRIPE_CATALOG_LOADED_AT);
		let fail = false;
		const cache = createCatalogCache(
			async () => {
				if (fail) throw new Error('STRIPE_UNAVAILABLE');
				return validSnapshot(now);
			},
			{ clock: () => new Date(now) }
		);

		await cache.get();
		fail = true;
		now = new Date(STRIPE_CATALOG_LOADED_AT.getTime() + 15 * 60_000 + 1);

		await expect(cache.get()).rejects.toThrowError('CATALOG_UNAVAILABLE');
	});

	it('rejects malformed snapshots instead of storing them', async () => {
		let valid = false;
		const cache = createCatalogCache(
			async () =>
				valid
					? validSnapshot(STRIPE_CATALOG_LOADED_AT)
					: { products: [], diagnostics: [], loadedAt: 'not-a-date', stale: false },
			{ clock: () => new Date(STRIPE_CATALOG_LOADED_AT) }
		);

		await expect(cache.get()).rejects.toThrowError('CATALOG_UNAVAILABLE');
		valid = true;

		await expect(cache.get()).resolves.toMatchObject({ stale: false });
	});

	it('isolates its deeply frozen stored snapshot from source and caller mutation', async () => {
		const source = await validSnapshot(STRIPE_CATALOG_LOADED_AT);
		const cache = createCatalogCache(async () => source, {
			clock: () => new Date(STRIPE_CATALOG_LOADED_AT)
		});

		const first = await cache.get();
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.products)).toBe(true);
		expect(Object.isFrozen(first.products[0].variants)).toBe(true);
		expect(() => first.products[0].variants.push(first.products[0].variants[0])).toThrow(TypeError);
		first.loadedAt.setTime(0);
		source.products[0].name = 'Mutated source';

		const second = await cache.get();
		expect(second.loadedAt).toEqual(STRIPE_CATALOG_LOADED_AT);
		expect(second.products[0].name).toBe('Society Mug');
	});
});

describe('createCatalogService', () => {
	it('returns a public projection without fulfillment or design secrets', async () => {
		const invalid = stripeProduct({ id: 'prod_invalid', images: [] });
		const { client } = providerClient([invalid, stripeProduct()], [stripePrice()]);
		const gateway = createStripeCatalogGateway('sk_test_catalog', {
			client,
			clock: () => new Date(STRIPE_CATALOG_LOADED_AT)
		});
		const service = createCatalogService(gateway, {
			clock: () => new Date(STRIPE_CATALOG_LOADED_AT)
		});

		const listed = await service.listPublic();
		const product = listed.products[0];

		expect(listed.stale).toBe(false);
		expect(product).toMatchObject({
			slug: 'community-tee',
			materials: '100% organic cotton',
			care: 'Wash at 30°C',
			fit: 'Regular fit'
		});
		expect(product).not.toHaveProperty('providerId');
		expect(product).not.toHaveProperty('designReference');
		expect(product).not.toHaveProperty('designPlacements');
		expect(product.variants[0]).not.toHaveProperty('productId');
		expect(product.variants[0]).not.toHaveProperty('sku');
		expect(product.variants[0]).not.toHaveProperty('styriaProductNumber');
		expect(JSON.stringify(listed)).not.toContain('society-community-v1');
		expect(JSON.stringify(listed)).not.toContain('STYRIA-TEE-M');
		expect(JSON.stringify(listed)).not.toContain('community-front.svg');
		expect(await service.findPublicBySlug('community-tee')).toEqual(product);
		expect(await service.findPublicBySlug('missing-product')).toBeNull();
		expect(await service.diagnostics()).toEqual([
			{ providerId: 'prod_invalid', code: 'PRODUCT_IMAGE_INVALID' }
		]);
	});

	it('resolves cart lines to validated internal Products and variants in cart order', async () => {
		const { client } = providerClient(
			[stripeAccessoryProduct(), stripeProduct()],
			[stripeAccessoryPrice(), stripePrice()]
		);
		const gateway = createStripeCatalogGateway('sk_test_catalog', {
			client,
			clock: () => new Date(STRIPE_CATALOG_LOADED_AT)
		});
		const service = createCatalogService(gateway, {
			clock: () => new Date(STRIPE_CATALOG_LOADED_AT)
		});
		const lines = [
			{ priceId: 'price_apparel_medium', quantity: 2 },
			{ priceId: 'price_accessory_one', quantity: 1 }
		];

		const resolved = await service.resolveCart(lines);

		expect(resolved.map(({ line }) => line)).toEqual(lines);
		expect(resolved.map(({ product }) => product.slug)).toEqual(['community-tee', 'society-mug']);
		expect(resolved.map(({ variant }) => variant.sku)).toEqual(['SS-TEE-M', 'SS-MUG']);
		await expect(
			service.resolveCart([{ priceId: 'price_missing', quantity: 1 }])
		).rejects.toThrowError('CATALOG_VARIANT_UNAVAILABLE');
	});
});
