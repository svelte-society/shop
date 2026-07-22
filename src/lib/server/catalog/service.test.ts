import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { CatalogSnapshot } from '$lib/domain/catalog';
import {
	STRIPE_CATALOG_LOADED_AT,
	stripeAccessoryPrice,
	stripeAccessoryProduct,
	stripeList,
	stripePrice,
	stripeProduct,
	stripeShippingRate
} from '../../../../tests/fixtures/stripe-catalog';
import { createCatalogCache } from './cache.server';
import { parseStripeCatalog, parseStripeShippingRates } from './parse';
import { createCatalogService } from './service.server';
import { createStripeCatalogGateway, type StripeCatalogClient } from './stripe-catalog.server';

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

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
): { client: StripeCatalogClient; priceRequests: string[]; shippingRateRequests: string[] } {
	const priceRequests: string[] = [];
	const shippingRateRequests: string[] = [];
	const shippingRates = new Map([
		['shr_paid', stripeShippingRate()],
		[
			'shr_free',
			stripeShippingRate({
				id: 'shr_free',
				display_name: 'Free shipping',
				fixed_amount: { amount: 0, currency: 'eur' }
			})
		]
	]);

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
			},
			shippingRates: {
				async retrieve(id) {
					shippingRateRequests.push(id);
					const rate = shippingRates.get(id);
					if (!rate) throw new Error('TEST_SHIPPING_RATE_MISSING');
					return rate;
				}
			}
		},
		priceRequests,
		shippingRateRequests
	};
}

async function validSnapshot(loadedAt: Date, name = 'Society Mug'): Promise<CatalogSnapshot> {
	return parseStripeCatalog(
		[stripeAccessoryProduct({ name })],
		async () => [stripeAccessoryPrice()],
		loadedAt,
		parseStripeShippingRates({
			paid: { configuredId: 'shr_paid', rate: stripeShippingRate() },
			free: {
				configuredId: 'shr_free',
				rate: stripeShippingRate({
					id: 'shr_free',
					fixed_amount: { amount: 0, currency: 'eur' }
				})
			}
		})
	);
}

describe('createStripeCatalogGateway', () => {
	it('paginates active Products and every active Price while parsing only accepted merch', async () => {
		const apparel = stripeProduct();
		const invalid = stripeProduct({
			id: 'prod_invalid',
			images: [],
			metadata: { slug: 'invalid-product' }
		});
		const nonMerch = stripeProduct({
			id: 'prod_non_merch',
			metadata: { product_type: 'donation', slug: 'support' }
		});
		const small = stripePrice({
			id: 'price_apparel_small',
			metadata: { label: 'S', sort_order: '10', sku: 'SS-TEE-S', styria_pn: 'STYRIA-TEE-S' }
		});
		const { client, priceRequests, shippingRateRequests } = providerClient(
			[nonMerch, invalid, apparel],
			[stripePrice(), small]
		);
		const gateway = createStripeCatalogGateway('sk_test_catalog', {
			client,
			paidShippingRateId: 'shr_paid',
			freeShippingRateId: 'shr_free',
			clock: () => new Date(STRIPE_CATALOG_LOADED_AT)
		});

		const snapshot = await gateway.loadMerchCatalog();

		expect(snapshot.products).toHaveLength(1);
		expect(snapshot.products[0].variants.map((variant) => variant.priceId)).toEqual([
			'price_apparel_small',
			'price_apparel_medium'
		]);
		expect(snapshot.shippingRates).toEqual({
			paid: { id: 'shr_paid', netAmountCents: 937 },
			free: { id: 'shr_free', netAmountCents: 0 }
		});
		expect(shippingRateRequests).toEqual(['shr_paid', 'shr_free']);
		expect(snapshot.diagnostics).toEqual([
			{ providerId: 'prod_invalid', code: 'PRODUCT_IMAGE_INVALID' }
		]);
		expect(priceRequests).not.toContain('prod_invalid');
		expect(priceRequests).not.toContain('prod_non_merch');
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
		expect(stale.shippingRates.paid.netAmountCents).toBe(937);
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
		expect(Object.isFrozen(first.shippingRates)).toBe(true);
		expect(Object.isFrozen(first.shippingRates.paid)).toBe(true);
		expect(() => first.products[0].variants.push(first.products[0].variants[0])).toThrow(TypeError);
		expect(() => {
			first.shippingRates.paid.netAmountCents = 1;
		}).toThrow(TypeError);
		first.loadedAt.setTime(0);
		source.products[0].name = 'Mutated source';
		source.shippingRates.paid.netAmountCents = 1;

		const second = await cache.get();
		expect(second.loadedAt).toEqual(STRIPE_CATALOG_LOADED_AT);
		expect(second.products[0].name).toBe('Society Mug');
		expect(second.shippingRates.paid.netAmountCents).toBe(937);
	});

	it('shares one provider refresh across concurrent reads of an expired snapshot', async () => {
		let now = new Date(STRIPE_CATALOG_LOADED_AT);
		let loads = 0;
		const refresh = deferred<CatalogSnapshot>();
		const initial = await validSnapshot(now, 'Initial Mug');
		const cache = createCatalogCache(
			async () => {
				loads += 1;
				return loads === 1 ? initial : refresh.promise;
			},
			{ clock: () => new Date(now) }
		);

		await cache.get();
		now = new Date(STRIPE_CATALOG_LOADED_AT.getTime() + 60_000);
		const first = cache.get();
		const second = cache.get();
		refresh.resolve(await validSnapshot(now, 'Refreshed Mug'));
		const results = await Promise.all([first, second]);

		expect(results.map((snapshot) => snapshot.products[0].name)).toEqual([
			'Refreshed Mug',
			'Refreshed Mug'
		]);
		expect(results.map((snapshot) => snapshot.stale)).toEqual([false, false]);
		expect(loads).toBe(2);
	});

	it('admits only one authoritative refresh so a late completion cannot overwrite cache state', async () => {
		let now = new Date(STRIPE_CATALOG_LOADED_AT);
		let loads = 0;
		const olderRefresh = deferred<CatalogSnapshot>();
		const overlappingNewerRefresh = deferred<CatalogSnapshot>();
		const initial = await validSnapshot(now, 'Initial Mug');
		const cache = createCatalogCache(
			async () => {
				loads += 1;
				if (loads === 1) return initial;
				return loads === 2 ? olderRefresh.promise : overlappingNewerRefresh.promise;
			},
			{ clock: () => new Date(now) }
		);

		await cache.get();
		now = new Date(STRIPE_CATALOG_LOADED_AT.getTime() + 60_000);
		const first = cache.get();
		const second = cache.get();
		overlappingNewerRefresh.resolve(await validSnapshot(now, 'Newer completion'));
		await Promise.resolve();
		await Promise.resolve();
		olderRefresh.resolve(await validSnapshot(now, 'Authoritative completion'));
		const results = await Promise.all([first, second]);
		const retained = await cache.get();

		expect(results.map((snapshot) => snapshot.products[0].name)).toEqual([
			'Authoritative completion',
			'Authoritative completion'
		]);
		expect(retained.products[0].name).toBe('Authoritative completion');
		expect(loads).toBe(2);
	});

	it('re-evaluates stale age when an in-flight refresh fails after the 15-minute cutoff', async () => {
		let now = new Date(STRIPE_CATALOG_LOADED_AT);
		let loads = 0;
		const refresh = deferred<CatalogSnapshot>();
		const initial = await validSnapshot(now);
		const cache = createCatalogCache(
			async () => {
				loads += 1;
				return loads === 1 ? initial : refresh.promise;
			},
			{ clock: () => new Date(now) }
		);

		await cache.get();
		now = new Date(STRIPE_CATALOG_LOADED_AT.getTime() + 60_000);
		const pending = cache.get();
		const unavailable = expect(pending).rejects.toThrowError('CATALOG_UNAVAILABLE');
		now = new Date(STRIPE_CATALOG_LOADED_AT.getTime() + 15 * 60_000 + 1);
		refresh.reject(new Error('STRIPE_UNAVAILABLE'));

		await unavailable;
		expect(loads).toBe(2);
	});

	it('does not mislabel a successful concurrent refresh as stale when another read would fail', async () => {
		let now = new Date(STRIPE_CATALOG_LOADED_AT);
		let loads = 0;
		const success = deferred<CatalogSnapshot>();
		const overlappingFailure = deferred<CatalogSnapshot>();
		const initial = await validSnapshot(now, 'Initial Mug');
		const cache = createCatalogCache(
			async () => {
				loads += 1;
				if (loads === 1) return initial;
				return loads === 2 ? success.promise : overlappingFailure.promise;
			},
			{ clock: () => new Date(now) }
		);

		await cache.get();
		now = new Date(STRIPE_CATALOG_LOADED_AT.getTime() + 60_000);
		const first = cache.get();
		const second = cache.get();
		const resultsPromise = Promise.all([first, second]);
		success.resolve(await validSnapshot(now, 'Successful refresh'));
		await Promise.resolve();
		await Promise.resolve();
		if (loads > 2) overlappingFailure.reject(new Error('STRIPE_UNAVAILABLE'));
		const results = await resultsPromise;

		expect(results.map((snapshot) => snapshot.products[0].name)).toEqual([
			'Successful refresh',
			'Successful refresh'
		]);
		expect(results.map((snapshot) => snapshot.stale)).toEqual([false, false]);
		expect(loads).toBe(2);
	});

	it('clears a settled failed refresh so a later read can retry', async () => {
		let loads = 0;
		let failing = true;
		const failure = deferred<CatalogSnapshot>();
		const cache = createCatalogCache(
			async () => {
				loads += 1;
				return failing ? failure.promise : validSnapshot(STRIPE_CATALOG_LOADED_AT, 'Recovered Mug');
			},
			{ clock: () => new Date(STRIPE_CATALOG_LOADED_AT) }
		);

		const first = cache.get();
		const second = cache.get();
		failure.reject(new Error('STRIPE_UNAVAILABLE'));
		const failed = await Promise.allSettled([first, second]);
		failing = false;
		const recovered = await cache.get();

		expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);
		expect(
			failed.map((result) =>
				result.status === 'rejected' && result.reason instanceof Error
					? result.reason.message
					: null
			)
		).toEqual(['CATALOG_UNAVAILABLE', 'CATALOG_UNAVAILABLE']);
		expect(recovered.products[0].name).toBe('Recovered Mug');
		expect(recovered.stale).toBe(false);
		expect(loads).toBe(2);
	});
});

describe('createCatalogService', () => {
	it('returns a public projection without fulfillment or design secrets', async () => {
		const invalid = stripeProduct({
			id: 'prod_invalid',
			images: [],
			metadata: { slug: 'invalid-product' }
		});
		const { client } = providerClient([invalid, stripeProduct()], [stripePrice()]);
		const gateway = createStripeCatalogGateway('sk_test_catalog', {
			client,
			paidShippingRateId: 'shr_paid',
			freeShippingRateId: 'shr_free',
			clock: () => new Date(STRIPE_CATALOG_LOADED_AT)
		});
		const service = createCatalogService(gateway, {
			clock: () => new Date(STRIPE_CATALOG_LOADED_AT)
		});

		const listed = await service.listPublic();
		const product = listed.products[0];

		expect(listed.stale).toBe(false);
		expect(listed.paidShippingNetCents).toBe(937);
		expect(product).toMatchObject({
			slug: 'community-tee',
			materials: '100% organic cotton',
			care: 'Wash at 30°C',
			fit: 'Regular fit'
		});
		expect(product).not.toHaveProperty('providerId');
		expect(product).not.toHaveProperty('taxCode');
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
			paidShippingRateId: 'shr_paid',
			freeShippingRateId: 'shr_free',
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

		expect(resolved.lines.map(({ line }) => line)).toEqual(lines);
		expect(resolved.lines.map(({ product }) => product.slug)).toEqual([
			'community-tee',
			'society-mug'
		]);
		expect(resolved.lines.map(({ variant }) => variant.sku)).toEqual(['SS-TEE-M', 'SS-MUG']);
		expect(resolved.shippingRates).toEqual({
			paid: { id: 'shr_paid', netAmountCents: 937 },
			free: { id: 'shr_free', netAmountCents: 0 }
		});
		await expect(
			service.resolveCart([{ priceId: 'price_missing', quantity: 1 }])
		).rejects.toThrowError('CATALOG_VARIANT_UNAVAILABLE');
	});

	it('bypasses the storefront cache when resolving a cart for checkout', async () => {
		const loadedAt = new Date(STRIPE_CATALOG_LOADED_AT);
		const available = await validSnapshot(loadedAt);
		const retired = { ...available, products: [], loadedAt: new Date(loadedAt.getTime() + 1) };
		const gateway = {
			loadMerchCatalog: vi.fn().mockResolvedValueOnce(available).mockResolvedValueOnce(retired)
		};
		const service = createCatalogService(gateway, { clock: () => loadedAt });

		await expect(service.listPublic()).resolves.toMatchObject({ stale: false });
		await expect(
			service.resolveCartForCheckout([{ priceId: 'price_accessory_one', quantity: 1 }])
		).rejects.toThrowError('CATALOG_VARIANT_UNAVAILABLE');
		expect(gateway.loadMerchCatalog).toHaveBeenCalledTimes(2);
	});

	it('alerts a provider outage without changing unavailable or recovered catalog behavior', async () => {
		const alerts = { enqueueAlert: vi.fn() };
		const gateway = {
			loadMerchCatalog: vi
				.fn()
				.mockRejectedValueOnce(new Error('private Stripe response and stack'))
				.mockResolvedValue({
					products: [],
					shippingRates: {
						paid: { id: 'shr_paid', netAmountCents: 937 },
						free: { id: 'shr_free', netAmountCents: 0 }
					},
					diagnostics: [],
					loadedAt: new Date(STRIPE_CATALOG_LOADED_AT),
					stale: false
				})
		};
		const observedAt = new Date(STRIPE_CATALOG_LOADED_AT);
		const service = createCatalogService(gateway, { clock: () => observedAt }, alerts);

		await expect(service.listPublic()).rejects.toThrow('CATALOG_UNAVAILABLE');
		expect(alerts.enqueueAlert).toHaveBeenCalledWith(
			'CATALOG_UNAVAILABLE',
			'stripe-catalog',
			observedAt
		);
		alerts.enqueueAlert.mockClear();
		await expect(service.listPublic()).resolves.toEqual({
			products: [],
			paidShippingNetCents: 937,
			stale: false
		});
		expect(alerts.enqueueAlert).not.toHaveBeenCalled();
	});
});
