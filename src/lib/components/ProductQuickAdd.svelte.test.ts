import '../../app.css';
import { describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PublicCatalogProduct } from '$lib/domain/catalog';
import { pricePublicProduct, pricingDestination } from '$lib/domain/pricing';
import { createCart } from '$lib/stores/cart.svelte';
import ProductQuickAdd from './ProductQuickAdd.svelte';

const isolatedStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
	getItem: () => null,
	setItem: () => undefined,
	removeItem: () => undefined
};

const apparel: PublicCatalogProduct = {
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
	variants: [
		{
			priceId: 'price_tee_s',
			label: 'S',
			sortOrder: 10,
			currency: 'eur',
			unitAmountCents: 2_000
		},
		{
			priceId: 'price_tee_m',
			label: 'M',
			sortOrder: 20,
			currency: 'eur',
			unitAmountCents: 2_000
		}
	]
};

const product = pricePublicProduct(apparel, pricingDestination('SE'));
const accessory = pricePublicProduct(
	{
		...apparel,
		slug: 'society-mug',
		name: 'Society Mug',
		category: 'accessory',
		fit: null,
		variants: [
			{
				priceId: 'price_mug',
				label: 'One size',
				sortOrder: 10,
				currency: 'eur',
				unitAmountCents: 2_000
			}
		]
	},
	pricingDestination('SE')
);

describe('ProductQuickAdd', () => {
	it('reveals apparel sizes, focuses the first size, and adds the selected Stripe price', async () => {
		const cartController = createCart(isolatedStorage);
		render(ProductQuickAdd, { product, cartController });
		const addButton = page.getByRole('button', { name: 'Add to cart' });

		await expect.element(addButton).toHaveAttribute('aria-expanded', 'false');
		await addButton.click();

		await expect.element(addButton).toHaveAttribute('aria-expanded', 'true');
		await expect
			.element(page.getByRole('group', { name: 'Choose a size for Community Tee' }))
			.toBeVisible();
		expect(document.activeElement).toBe(
			page.getByRole('button', { name: 'S', exact: true }).element()
		);

		await page.getByRole('button', { name: 'M', exact: true }).click();

		expect(cartController.lines).toEqual([{ priceId: 'price_tee_m', quantity: 1 }]);
		await expect
			.element(page.getByRole('status', { name: 'Cart status' }))
			.toHaveTextContent('Community Tee, M added to cart.');
		await expect.element(addButton).toHaveAttribute('aria-expanded', 'false');
		expect(page.getByRole('group', { name: 'Choose a size for Community Tee' }).query()).toBeNull();
	});

	it('closes the size choices without changing the cart', async () => {
		const cartController = createCart(isolatedStorage);
		render(ProductQuickAdd, { product, cartController });
		const addButton = page.getByRole('button', { name: 'Add to cart' });

		await addButton.click();
		await page.getByRole('button', { name: 'Close size choices' }).click();

		expect(cartController.lines).toEqual([]);
		await expect.element(addButton).toHaveAttribute('aria-expanded', 'false');
		expect(document.activeElement).toBe(addButton.element());
	});

	it('closes the size choices with Escape without changing the cart', async () => {
		const cartController = createCart(isolatedStorage);
		render(ProductQuickAdd, { product, cartController });
		const addButton = page.getByRole('button', { name: 'Add to cart' });

		await addButton.click();
		await userEvent.keyboard('{Escape}');

		expect(cartController.lines).toEqual([]);
		await expect.element(addButton).toHaveAttribute('aria-expanded', 'false');
		expect(document.activeElement).toBe(addButton.element());
	});

	it('adds a single-variant product immediately without an option chooser', async () => {
		const cartController = createCart(isolatedStorage);
		render(ProductQuickAdd, { product: accessory, cartController });

		await page.getByRole('button', { name: 'Add to cart' }).click();

		expect(cartController.lines).toEqual([{ priceId: 'price_mug', quantity: 1 }]);
		expect(page.getByRole('group').query()).toBeNull();
		await expect
			.element(page.getByRole('status', { name: 'Cart status' }))
			.toHaveTextContent('Society Mug, One size added to cart.');
	});

	it.each([
		{
			name: 'the 20-unit limit',
			fill(controller: ReturnType<typeof createCart>) {
				controller.add('price_existing', 20);
			},
			message: 'Your cart holds up to 20 items. Remove one before adding another.'
		},
		{
			name: 'the 10-option limit',
			fill(controller: ReturnType<typeof createCart>) {
				for (let index = 0; index < 10; index += 1) controller.add(`price_existing_${index}`);
			},
			message: 'Your cart has 10 different options. Remove one before adding another.'
		}
	])('keeps $name local and actionable', async ({ fill, message }) => {
		const cartController = createCart(isolatedStorage);
		fill(cartController);
		const originalLines = cartController.lines;
		render(ProductQuickAdd, { product: accessory, cartController });

		await page.getByRole('button', { name: 'Add to cart' }).click();

		expect(cartController.lines).toEqual(originalLines);
		await expect.element(page.getByRole('alert')).toHaveTextContent(message);
		expect(page.getByRole('status', { name: 'Cart status' }).element().textContent?.trim()).toBe(
			''
		);
	});

	it('keeps cart and option targets at least 44px high', async () => {
		const cartController = createCart(isolatedStorage);
		render(ProductQuickAdd, { product, cartController });
		const addButton = page.getByRole('button', { name: 'Add to cart' });

		expect(Number.parseFloat(getComputedStyle(addButton.element()).minHeight)).toBeGreaterThanOrEqual(
			44
		);
		await addButton.click();

		for (const option of page.getByRole('group').getByRole('button').all()) {
			expect(Number.parseFloat(getComputedStyle(option.element()).minHeight)).toBeGreaterThanOrEqual(
				44
			);
		}
	});
});
