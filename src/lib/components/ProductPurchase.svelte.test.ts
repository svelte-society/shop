import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PublicCatalogProduct } from '$lib/domain/catalog';
import { createCart } from '$lib/stores/cart.svelte';
import ProductPurchase from './ProductPurchase.svelte';

const isolatedStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
	getItem: () => null,
	setItem: () => undefined,
	removeItem: () => undefined
};

const apparel: PublicCatalogProduct = {
	slug: 'society-tee',
	name: 'Society Tee',
	description: 'A tee for Svelte meetups and everyday code.',
	images: ['https://cdn.example.com/society-tee.jpg'],
	sortOrder: 10,
	category: 'apparel',
	materials: 'Organic cotton',
	care: 'Wash at 30°C',
	fit: 'Regular fit',
	sizeGuideUrl: 'https://cdn.example.com/size-guide.pdf',
	variants: [
		{
			priceId: 'price_small',
			label: 'S',
			sortOrder: 10,
			currency: 'eur',
			unitAmountCents: 2_000,
			referenceGrossCents: 2_500
		},
		{
			priceId: 'price_medium',
			label: 'M',
			sortOrder: 20,
			currency: 'eur',
			unitAmountCents: 2_000,
			referenceGrossCents: 2_500
		}
	]
};

const accessory: PublicCatalogProduct = {
	...apparel,
	slug: 'society-mug',
	name: 'Society Mug',
	category: 'accessory',
	fit: null,
	sizeGuideUrl: null,
	variants: [
		{
			priceId: 'price_mug',
			label: 'One size',
			sortOrder: 10,
			currency: 'eur',
			unitAmountCents: 1_600,
			referenceGrossCents: 2_000
		}
	]
};

describe('ProductPurchase', () => {
	it('keeps apparel out of the cart until a size is selected', async () => {
		const cartController = createCart(isolatedStorage);
		render(ProductPurchase, { product: apparel, cartController });

		await page.getByRole('button', { name: 'Add to cart' }).click();

		expect(cartController.lines).toEqual([]);
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Choose a size before adding to cart.');

		await page.getByText('M', { exact: true }).click();
		await page.getByRole('button', { name: 'Add to cart' }).click();

		expect(cartController.lines).toEqual([{ priceId: 'price_medium', quantity: 1 }]);
		await expect
			.element(page.getByRole('status', { name: 'Cart status' }))
			.toHaveTextContent('Society Tee, M added to cart.');
	});

	it('adds the automatically selected accessory variant', async () => {
		const cartController = createCart(isolatedStorage);
		render(ProductPurchase, { product: accessory, cartController });

		await page.getByRole('button', { name: 'Add to cart' }).click();

		expect(cartController.lines).toEqual([{ priceId: 'price_mug', quantity: 1 }]);
		await expect
			.element(page.getByRole('status', { name: 'Cart status' }))
			.toHaveTextContent('Society Mug, One size added to cart.');
	});
});
