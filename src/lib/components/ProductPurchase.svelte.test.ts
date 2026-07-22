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
	sizeChart: null,
	variants: [
		{
			priceId: 'price_small',
			label: 'S',
			sortOrder: 10,
			currency: 'eur',
			unitAmountCents: 2_000
		},
		{
			priceId: 'price_medium',
			label: 'M',
			sortOrder: 20,
			currency: 'eur',
			unitAmountCents: 2_000
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
			unitAmountCents: 2_000
		}
	]
};

const nextApparel: PublicCatalogProduct = {
	...apparel,
	slug: 'society-hoodie',
	name: 'Society Hoodie',
	variants: [
		{ ...apparel.variants[0], priceId: 'price_hoodie_xs', label: 'XS' },
		{ ...apparel.variants[1], priceId: 'price_hoodie_xl', label: 'XL' }
	]
};

describe('ProductPurchase', () => {
	it('explains that the selected price excludes destination VAT', async () => {
		render(ProductPurchase, { product: apparel });

		await expect.element(page.getByText('€20.00')).toBeVisible();
		await expect
			.element(page.getByText('Excl. VAT. Destination VAT follows at checkout.'))
			.toBeVisible();
	});

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

	it.each([
		{
			name: 'the 20-unit limit',
			fill(controller: ReturnType<typeof createCart>) {
				controller.add('price_existing', 20);
			},
			message: 'Your cart holds up to 20 items. Remove one before adding another.'
		},
		{
			name: 'the 10-variant limit',
			fill(controller: ReturnType<typeof createCart>) {
				for (let index = 0; index < 10; index += 1) controller.add(`price_existing_${index}`);
			},
			message: 'Your cart has 10 different options. Remove one before adding another.'
		}
	])(
		'surfaces a recoverable cart error at $name without false success',
		async ({ fill, message }) => {
			const cartController = createCart(isolatedStorage);
			fill(cartController);
			const initialLines = cartController.lines;
			render(ProductPurchase, { product: accessory, cartController });

			await page.getByRole('button', { name: 'Add to cart' }).click();

			expect(cartController.lines).toEqual(initialLines);
			await expect.element(page.getByRole('alert')).toHaveTextContent(message);
			expect(page.getByRole('status', { name: 'Cart status' }).element().textContent?.trim()).toBe(
				''
			);
		}
	);

	it('uses option wording for an unselected multi-variant accessory', async () => {
		const cartController = createCart(isolatedStorage);
		render(ProductPurchase, {
			product: {
				...accessory,
				variants: [
					{ ...accessory.variants[0], priceId: 'price_mug_white', label: 'White' },
					{ ...accessory.variants[0], priceId: 'price_mug_navy', label: 'Navy' }
				]
			},
			cartController
		});

		await page.getByRole('button', { name: 'Add to cart' }).click();

		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Choose an option before adding to cart.');
	});

	it('clears selection and feedback when reused for another product', async () => {
		const cartController = createCart(isolatedStorage);
		const view = render(ProductPurchase, { product: apparel, cartController });
		await page.getByText('M', { exact: true }).click();
		await page.getByRole('button', { name: 'Add to cart' }).click();
		await expect
			.element(page.getByRole('status', { name: 'Cart status' }))
			.toHaveTextContent('Society Tee, M added to cart.');

		await view.rerender({ product: nextApparel, cartController });

		await expect.element(page.getByRole('radio', { name: 'XS' })).not.toBeChecked();
		await expect.element(page.getByRole('radio', { name: 'XL' })).not.toBeChecked();
		expect(page.getByRole('status', { name: 'Cart status' }).element().textContent?.trim()).toBe(
			''
		);

		await page.getByRole('button', { name: 'Add to cart' }).click();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Choose a size before adding to cart.');
		expect(cartController.lines).toEqual([{ priceId: 'price_medium', quantity: 1 }]);

		await page.getByText('XS', { exact: true }).click();
		await page.getByRole('button', { name: 'Add to cart' }).click();
		expect(cartController.lines).toEqual([
			{ priceId: 'price_medium', quantity: 1 },
			{ priceId: 'price_hoodie_xs', quantity: 1 }
		]);
	});
});
