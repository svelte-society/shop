import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import {
	STRIPE_CATALOG_LOADED_AT,
	stripeAccessoryPrice,
	stripeAccessoryProduct,
	stripePrice,
	stripeProduct
} from '../../../../tests/fixtures/stripe-catalog';
import { parseStripeCatalog } from './parse';

function productIdFor(price: Stripe.Price): string {
	return typeof price.product === 'string' ? price.product : price.product.id;
}

async function parse(products: readonly Stripe.Product[], prices: readonly Stripe.Price[]) {
	return parseStripeCatalog(
		products,
		async (productId) => prices.filter((price) => productIdFor(price) === productId),
		STRIPE_CATALOG_LOADED_AT
	);
}

function withoutMetadata(product: Stripe.Product, key: string): Stripe.Product {
	const metadata = { ...product.metadata };
	delete metadata[key];
	return { ...product, metadata };
}

describe('parseStripeCatalog', () => {
	it('parses valid apparel using the approved net catalog price', async () => {
		const product = stripeProduct({
			metadata: {
				design_url_back: 'https://cdn.example.com/designs/community-back.svg',
				design_url_front: 'https://cdn.example.com/designs/community-front.svg'
			}
		});
		const small = stripePrice({
			id: 'price_apparel_small',
			metadata: { label: 'S', sort_order: '10', sku: 'SS-TEE-S', styria_pn: 'STYRIA-TEE-S' }
		});

		const snapshot = await parse([product], [stripePrice(), small]);

		expect(snapshot.loadedAt).toEqual(STRIPE_CATALOG_LOADED_AT);
		expect(snapshot.stale).toBe(false);
		expect(snapshot.diagnostics).toEqual([]);
		expect(snapshot.products).toHaveLength(1);
		expect(snapshot.products[0]).toMatchObject({
			providerId: 'prod_apparel',
			slug: 'community-tee',
			name: 'Community Tee',
			category: 'apparel',
			materials: '100% organic cotton',
			care: 'Wash at 30°C',
			fit: 'Regular fit',
			designReference: 'society-community-v1',
			designPlacements: {
				back: 'https://cdn.example.com/designs/community-back.svg',
				front: 'https://cdn.example.com/designs/community-front.svg'
			}
		});
		expect(snapshot.products[0].variants).toEqual([
			{
				priceId: 'price_apparel_small',
				productId: 'prod_apparel',
				label: 'S',
				sortOrder: 10,
				currency: 'eur',
				unitAmountCents: 2_000,
				sku: 'SS-TEE-S',
				styriaProductNumber: 'STYRIA-TEE-S'
			},
			{
				priceId: 'price_apparel_medium',
				productId: 'prod_apparel',
				label: 'M',
				sortOrder: 20,
				currency: 'eur',
				unitAmountCents: 2_000,
				sku: 'SS-TEE-M',
				styriaProductNumber: 'STYRIA-TEE-M'
			}
		]);
		expect(Object.keys(snapshot.products[0].designPlacements)).toEqual(['back', 'front']);
	});

	it('parses an inline size chart from Product metadata', async () => {
		const sizeChart = {
			unit: 'cm',
			sizes: ['S', 'M', 'L'],
			measurements: [
				{ label: 'Half chest', values: [49.5, 53.5, 56.5] },
				{ label: 'Body length', values: [69, 73, 75] }
			]
		};
		const product = stripeProduct({
			metadata: { size_chart_json: JSON.stringify(sizeChart) }
		});

		const snapshot = await parse([product], [stripePrice()]);

		expect(snapshot.diagnostics).toEqual([]);
		expect(snapshot.products[0].sizeChart).toEqual(sizeChart);
	});

	it('maps a Styria placement metadata slug to the exact provider position', async () => {
		const product = withoutMetadata(
			stripeProduct({
				metadata: {
					design_url_embroidery_centre_chest:
						'https://cdn.example.com/designs/community-embroidery.png'
				}
			}),
			'design_url_front'
		);

		const snapshot = await parse([product], [stripePrice()]);

		expect(snapshot.diagnostics).toEqual([]);
		expect(snapshot.products[0].designPlacements).toEqual({
			'Embroidery Centre Chest': 'https://cdn.example.com/designs/community-embroidery.png'
		});
	});

	it('parses placement-specific mockups and confirmed thread colours from Product metadata', async () => {
		const artworkUrl = 'https://cdn.example.com/designs/community-embroidery.png';
		const mockupUrl = 'https://cdn.example.com/mockups/community-left-chest.png';
		const product = withoutMetadata(
			stripeProduct({
				metadata: {
					design_url_embroidery_left_chest: artworkUrl,
					mockup_url_embroidery_left_chest: mockupUrl,
					thread_colors_embroidery_left_chest: JSON.stringify([
						'Orange (#FC4C02)',
						'White (#FFFFFF)'
					])
				}
			}),
			'design_url_front'
		);

		const snapshot = await parse([product], [stripePrice()]);

		expect(snapshot.diagnostics).toEqual([]);
		expect(snapshot.products[0]).toMatchObject({
			designPlacements: { 'Embroidery Left Chest': artworkUrl },
			productionDetails: {
				mockupPlacements: { 'Embroidery Left Chest': mockupUrl },
				threadColors: {
					'Embroidery Left Chest': ['Orange (#FC4C02)', 'White (#FFFFFF)']
				}
			}
		});
	});

	it('excludes a Product with malformed inline size-chart metadata', async () => {
		const product = stripeProduct({ metadata: { size_chart_json: '{"unit":"cm"}' } });

		const snapshot = await parse([product], [stripePrice()]);

		expect(snapshot.products).toEqual([]);
		expect(snapshot.diagnostics).toContainEqual({
			providerId: product.id,
			code: 'PRODUCT_SIZE_CHART_INVALID'
		});
	});

	it('accepts a shippable physical Product with Stripe legacy type service', async () => {
		const product = stripeProduct({ type: 'service', shippable: true });

		const snapshot = await parse([product], [stripePrice()]);

		expect(snapshot.diagnostics).toEqual([]);
		expect(snapshot.products).toHaveLength(1);
		expect(snapshot.products[0].providerId).toBe(product.id);
	});

	it('parses a valid single-variant accessory without apparel fit', async () => {
		const snapshot = await parse([stripeAccessoryProduct()], [stripeAccessoryPrice()]);

		expect(snapshot.diagnostics).toEqual([]);
		expect(snapshot.products).toHaveLength(1);
		expect(snapshot.products[0]).toMatchObject({
			providerId: 'prod_accessory',
			slug: 'society-mug',
			category: 'accessory',
			fit: null,
			sizeGuideUrl: null
		});
		expect(snapshot.products[0].variants).toHaveLength(1);
	});

	it('excludes a merch Product without an HTTPS image', async () => {
		const snapshot = await parse(
			[stripeProduct({ images: ['http://cdn.example.com/community-tee.png'] })],
			[stripePrice()]
		);

		expect(snapshot.products).toEqual([]);
		expect(snapshot.diagnostics).toContainEqual({
			providerId: 'prod_apparel',
			code: 'PRODUCT_IMAGE_INVALID'
		});
	});

	it('excludes a Product with a missing slug', async () => {
		const snapshot = await parse([withoutMetadata(stripeProduct(), 'slug')], [stripePrice()]);

		expect(snapshot.products).toEqual([]);
		expect(snapshot.diagnostics).toContainEqual({
			providerId: 'prod_apparel',
			code: 'PRODUCT_SLUG_INVALID'
		});
	});

	it('excludes every Product sharing a duplicate slug', async () => {
		const duplicate = stripeAccessoryProduct({
			metadata: { slug: 'community-tee' }
		});

		const snapshot = await parse(
			[stripeProduct(), duplicate],
			[stripePrice(), stripeAccessoryPrice()]
		);

		expect(snapshot.products).toEqual([]);
		expect(snapshot.diagnostics).toEqual(
			expect.arrayContaining([
				{ providerId: 'prod_apparel', code: 'PRODUCT_SLUG_DUPLICATE' },
				{ providerId: 'prod_accessory', code: 'PRODUCT_SLUG_DUPLICATE' }
			])
		);
	});

	it('counts a valid slug claimed by a malformed active merch Product as a duplicate', async () => {
		const malformedDuplicate = stripeAccessoryProduct({
			id: 'prod_malformed_duplicate',
			images: [],
			metadata: { slug: 'community-tee' }
		});

		const snapshot = await parse([stripeProduct(), malformedDuplicate], [stripePrice()]);

		expect(snapshot.products).toEqual([]);
		expect(snapshot.diagnostics).toEqual([
			{ providerId: 'prod_apparel', code: 'PRODUCT_SLUG_DUPLICATE' },
			{ providerId: 'prod_malformed_duplicate', code: 'PRODUCT_IMAGE_INVALID' },
			{ providerId: 'prod_malformed_duplicate', code: 'PRODUCT_SLUG_DUPLICATE' }
		]);
	});

	it.each([
		['non-EUR currency', stripePrice({ currency: 'usd' }), 'PRICE_CURRENCY_INVALID'],
		[
			'non-approved amount',
			stripePrice({ unit_amount: 2_001, unit_amount_decimal: Stripe.Decimal.from(2_001) }),
			'PRICE_AMOUNT_INVALID'
		],
		['inclusive tax behavior', stripePrice({ tax_behavior: 'inclusive' }), 'PRICE_TAX_INVALID']
	])('excludes a Price with %s', async (_name, price, code) => {
		const snapshot = await parse([stripeProduct()], [price]);

		expect(snapshot.products).toEqual([]);
		expect(snapshot.diagnostics).toContainEqual({ providerId: price.id, code });
	});

	it.each([
		['sku', 'PRICE_SKU_INVALID'],
		['styria_pn', 'PRICE_STYRIA_PN_INVALID']
	])('excludes a Price without %s', async (metadataKey, code) => {
		const price = stripePrice({ metadata: { [metadataKey]: '' } });
		const snapshot = await parse([stripeProduct()], [price]);

		expect(snapshot.products).toEqual([]);
		expect(snapshot.diagnostics).toContainEqual({ providerId: price.id, code });
	});

	it.each([
		['materials', 'PRODUCT_MATERIALS_INVALID'],
		['care', 'PRODUCT_CARE_INVALID'],
		['fit', 'PRODUCT_FIT_INVALID']
	])('excludes apparel without %s', async (metadataKey, code) => {
		const product = withoutMetadata(stripeProduct(), metadataKey);
		const snapshot = await parse([product], [stripePrice()]);

		expect(snapshot.products).toEqual([]);
		expect(snapshot.diagnostics).toContainEqual({ providerId: product.id, code });
	});

	it('does not require fit for an accessory', async () => {
		const product = withoutMetadata(stripeAccessoryProduct(), 'fit');
		const snapshot = await parse([product], [stripeAccessoryPrice()]);

		expect(snapshot.products).toHaveLength(1);
		expect(snapshot.diagnostics).toEqual([]);
	});

	it.each([
		['design reference', 'design_reference', 'PRODUCT_DESIGN_REFERENCE_INVALID'],
		['design placement', 'design_url_front', 'PRODUCT_DESIGN_PLACEMENT_MISSING']
	])('excludes a Product without %s', async (_name, metadataKey, code) => {
		const product = withoutMetadata(stripeProduct(), metadataKey);
		const snapshot = await parse([product], [stripePrice()]);

		expect(snapshot.products).toEqual([]);
		expect(snapshot.diagnostics).toContainEqual({ providerId: product.id, code });
	});

	it('excludes a Product with a non-HTTPS design placement URL', async () => {
		const product = stripeProduct({
			metadata: { design_url_front: 'http://cdn.example.com/designs/community-front.svg' }
		});
		const snapshot = await parse([product], [stripePrice()]);

		expect(snapshot.products).toEqual([]);
		expect(snapshot.diagnostics).toContainEqual({
			providerId: product.id,
			code: 'PRODUCT_DESIGN_PLACEMENT_INVALID'
		});
	});

	it('excludes inactive Products and Prices even if the provider returns them', async () => {
		const inactiveProduct = stripeProduct({ id: 'prod_inactive', active: false });
		const inactivePrice = stripePrice({ id: 'price_inactive', active: false });
		const snapshot = await parse([inactiveProduct, stripeProduct()], [inactivePrice]);

		expect(snapshot.products).toEqual([]);
		expect(snapshot.diagnostics).toEqual(
			expect.arrayContaining([
				{ providerId: 'prod_inactive', code: 'PRODUCT_INACTIVE' },
				{ providerId: 'price_inactive', code: 'PRICE_INACTIVE' }
			])
		);
	});

	it('sorts Products and Prices deterministically when configured orders tie', async () => {
		const beta = stripeProduct({
			id: 'prod_beta',
			name: 'Beta Tee',
			metadata: { slug: 'beta-tee', sort_order: '10' }
		});
		const alpha = stripeProduct({
			id: 'prod_alpha',
			name: 'Alpha Tee',
			metadata: { slug: 'alpha-tee', sort_order: '10' }
		});
		const accessory = stripeAccessoryProduct({ metadata: { sort_order: '5' } });
		const betaLarge = stripePrice({
			id: 'price_beta_large',
			product: 'prod_beta',
			metadata: { label: 'L', sort_order: '10', sku: 'B-L', styria_pn: 'BETA-L' }
		});
		const betaSmall = stripePrice({
			id: 'price_beta_small',
			product: 'prod_beta',
			metadata: { label: 'S', sort_order: '10', sku: 'B-S', styria_pn: 'BETA-S' }
		});
		const alphaPrice = stripePrice({ id: 'price_alpha', product: 'prod_alpha' });

		const snapshot = await parse(
			[beta, accessory, alpha],
			[betaSmall, stripeAccessoryPrice(), alphaPrice, betaLarge]
		);

		expect(snapshot.products.map((product) => product.slug)).toEqual([
			'society-mug',
			'alpha-tee',
			'beta-tee'
		]);
		expect(snapshot.products[2].variants.map((variant) => variant.label)).toEqual(['L', 'S']);
	});

	it('keeps Product descriptions out of operator diagnostics', async () => {
		const sensitiveDescription = 'Never include this Product description in diagnostics';
		const product = stripeProduct({ description: sensitiveDescription, images: [] });
		const snapshot = await parse([product], [stripePrice()]);

		expect(snapshot.diagnostics).toEqual([
			{ providerId: 'prod_apparel', code: 'PRODUCT_IMAGE_INVALID' }
		]);
		expect(JSON.stringify(snapshot.diagnostics)).not.toContain(sensitiveDescription);
		expect(Object.keys(snapshot.diagnostics[0]).sort()).toEqual(['code', 'providerId']);
	});
});
