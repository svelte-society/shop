import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PublicCatalogProduct } from '$lib/domain/catalog';
import type { PricedPublicCatalogVariant } from '$lib/domain/pricing';
import CartLineItem from './CartLineItem.svelte';

const product: PublicCatalogProduct = {
	slug: 'community-tee',
	name: 'Community Tee',
	description: 'A community tee for people who make with Svelte.',
	images: ['https://cdn.example.com/products/tee.png'],
	sortOrder: 10,
	category: 'apparel',
	materials: '100% organic cotton',
	care: 'Wash at 30°C',
	fit: 'Regular fit',
	sizeGuideUrl: null,
	sizeChart: null,
	variants: []
};

const variant: PricedPublicCatalogVariant = {
	priceId: 'price_tee_medium',
	label: 'M',
	sortOrder: 10,
	currency: 'eur',
	unitAmountCents: 2_000,
	displayPrice: { netCents: 2_000, vatCents: 500, grossCents: 2_500 }
};

describe('CartLineItem', () => {
	it('renders supplied gross unit and line amounts', async () => {
		render(CartLineItem, {
		product,
		variant,
		unitDisplayPrice: variant.displayPrice,
		lineDisplayPrice: { netCents: 4_000, vatCents: 1_000, grossCents: 5_000 },
		quantity: 2,
		maxQuantity: 20,
		onQuantityChange: vi.fn(),
		onRemove: vi.fn()
	});

		await expect.element(page.getByText('€25.00 each')).toBeVisible();
		await expect.element(page.getByText('€50.00')).toBeVisible();
	});
});
