import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PublicCatalogProduct, PublicCatalogVariant } from '$lib/domain/catalog';
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

const variant: PublicCatalogVariant = {
	priceId: 'price_tee_medium',
	label: 'M',
	sortOrder: 10,
	currency: 'eur',
	unitAmountCents: 2_000
};

describe('CartLineItem', () => {
	it('labels unit and line amounts as net of VAT', async () => {
		render(CartLineItem, {
		product,
		variant,
		quantity: 2,
		maxQuantity: 20,
		onQuantityChange: vi.fn(),
		onRemove: vi.fn()
	});

		await expect.element(page.getByText('€20.00 each, excl. VAT')).toBeVisible();
		await expect.element(page.getByText('€40.00 net, excl. VAT')).toBeVisible();
	});
});
