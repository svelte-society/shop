import Stripe from 'stripe';

type ProductOverrides = Omit<Partial<Stripe.Product>, 'metadata'> & {
	metadata?: Record<string, string>;
};

type PriceOverrides = Omit<Partial<Stripe.Price>, 'metadata'> & {
	metadata?: Record<string, string>;
};

export const STRIPE_CATALOG_LOADED_AT = new Date('2026-07-15T18:00:00.000Z');

export function stripeProduct(overrides: ProductOverrides = {}): Stripe.Product {
	const { metadata, ...productOverrides } = overrides;

	return {
		id: 'prod_apparel',
		object: 'product',
		active: true,
		created: 1_752_600_000,
		default_price: 'price_apparel_medium',
		description: 'A community tee for people who make with Svelte.',
		images: ['https://cdn.example.com/products/community-tee-front.png'],
		livemode: false,
		marketing_features: [],
		metadata: {
			product_type: 'merch',
			slug: 'community-tee',
			sort_order: '20',
			category: 'apparel',
			materials: '100% organic cotton',
			care: 'Wash at 30°C',
			fit: 'Regular fit',
			design_reference: 'society-community-v1',
			design_url_front: 'https://cdn.example.com/designs/community-front.svg',
			size_guide_url: 'https://cdn.example.com/guides/tee-sizes.pdf',
			...metadata
		},
		name: 'Community Tee',
		package_dimensions: null,
		shippable: true,
		statement_descriptor: null,
		tax_code: 'txcd_99999999',
		type: 'good',
		unit_label: null,
		updated: 1_752_600_100,
		url: null,
		...productOverrides
	};
}

export function stripeAccessoryProduct(overrides: ProductOverrides = {}): Stripe.Product {
	const { metadata, ...productOverrides } = overrides;

	return stripeProduct({
		id: 'prod_accessory',
		default_price: 'price_accessory_one',
		name: 'Society Mug',
		description: 'A desk-side reminder that the Svelte community is everywhere.',
		images: ['https://cdn.example.com/products/society-mug.png'],
		metadata: {
			slug: 'society-mug',
			sort_order: '30',
			category: 'accessory',
			materials: 'Ceramic',
			care: 'Dishwasher safe',
			design_reference: 'society-mug-v1',
			design_url_wrap: 'https://cdn.example.com/designs/mug-wrap.svg',
			size_guide_url: '',
			...metadata
		},
		...productOverrides
	});
}

export function stripePrice(overrides: PriceOverrides = {}): Stripe.Price {
	const { metadata, ...priceOverrides } = overrides;

	return {
		id: 'price_apparel_medium',
		object: 'price',
		active: true,
		billing_scheme: 'per_unit',
		created: 1_752_600_000,
		currency: 'eur',
		custom_unit_amount: null,
		livemode: false,
		lookup_key: null,
		metadata: {
			label: 'M',
			sort_order: '20',
			sku: 'SS-TEE-M',
			styria_pn: 'STYRIA-TEE-M',
			...metadata
		},
		nickname: null,
		product: 'prod_apparel',
		recurring: null,
		tax_behavior: 'exclusive',
		tiers_mode: null,
		transform_quantity: null,
		type: 'one_time',
		unit_amount: 2_000,
		unit_amount_decimal: Stripe.Decimal.from(2_000),
		...priceOverrides
	};
}

export function stripeAccessoryPrice(overrides: PriceOverrides = {}): Stripe.Price {
	const { metadata, ...priceOverrides } = overrides;

	return stripePrice({
		id: 'price_accessory_one',
		metadata: {
			label: 'One size',
			sort_order: '10',
			sku: 'SS-MUG',
			styria_pn: 'STYRIA-MUG',
			...metadata
		},
		product: 'prod_accessory',
		unit_amount: 1_600,
		unit_amount_decimal: Stripe.Decimal.from(1_600),
		...priceOverrides
	});
}

export function stripeList<T extends { id: string }>(data: readonly T[]): Stripe.ApiList<T> {
	return {
		object: 'list',
		data: [...data],
		has_more: false,
		url: '/v1/catalog-fixture'
	};
}
