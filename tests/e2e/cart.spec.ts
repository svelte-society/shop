import { expect, test, type Page } from '@playwright/test';

const CART_STORAGE_KEY = 'svelte-society-shop:cart:v1';
const CATALOG_UNAVAILABLE_ORIGIN = 'http://127.0.0.1:4174';

async function addMug(page: Page): Promise<void> {
	await page.goto('/products/society-mug');
	await expect(page.getByRole('status', { name: 'Variant status' })).toHaveText(
		'One size selected.'
	);
	await page.getByRole('button', { name: 'Add to cart' }).click();
	await expect(page.getByRole('status', { name: 'Cart status' })).toContainText('added to cart');
}

test('empty cart points back to the collection', async ({ page }) => {
	await page.goto('/cart');

	await expect(page.getByRole('heading', { level: 1, name: 'Your cart is empty.' })).toBeVisible();
	await expect(page.getByText('Pick something made for Svelte people.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Browse the collection' })).toHaveAttribute(
		'href',
		'/#collection'
	);
});

test('cart persists the provider price and restores it after reload', async ({ page }) => {
	await addMug(page);
	await page.reload();
	await expect(page.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();

	await page.getByRole('link', { name: 'Cart, 1 item' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Society Mug' })).toBeVisible();
	await expect(page.getByLabel('Quantity')).toHaveValue('1');
	await expect(page.getByText('Add one more item for free shipping.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Checkout opens soon' })).toBeDisabled();

	const stored = await page.evaluate((key) => window.localStorage.getItem(key), CART_STORAGE_KEY);
	expect(JSON.parse(stored ?? 'null')).toEqual({
		version: 1,
		lines: [{ priceId: 'price_accessory_one', quantity: 1 }]
	});
});

test('quantity changes unlock free shipping and survive reload', async ({ page }) => {
	await addMug(page);
	await page.goto('/cart');

	const quantity = page.getByLabel('Quantity');
	await quantity.fill('2');
	await quantity.press('Tab');
	await expect(page.getByText('Free shipping unlocked.')).toBeVisible();
	await expect(page.getByText('2 items ready to review.')).toBeVisible();

	await page.reload();
	await expect(page.getByLabel('Quantity')).toHaveValue('2');
	await expect(page.getByText('Free shipping unlocked.')).toBeVisible();
});

test('removing the final line returns to the approved empty state', async ({ page }) => {
	await addMug(page);
	await page.goto('/cart');
	await page.getByRole('button', { name: 'Remove Society Mug, One size' }).click();

	await expect(page.getByRole('heading', { level: 1, name: 'Your cart is empty.' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Cart, 0 items' })).toBeVisible();
});

test('catalog outage preserves an existing cart', async ({ page }) => {
	await page.addInitScript(
		({ key }) => {
			window.localStorage.setItem(
				key,
				JSON.stringify({
					version: 1,
					lines: [{ priceId: 'price_accessory_one', quantity: 1 }]
				})
			);
		},
		{ key: CART_STORAGE_KEY }
	);
	await page.goto(`${CATALOG_UNAVAILABLE_ORIGIN}/cart`);

	await expect(
		page.getByRole('heading', { level: 1, name: 'Collection temporarily unavailable.' })
	).toBeVisible();
	await expect(page.getByText('Your cart is safe. Try again shortly.')).toBeVisible();
	expect(
		await page.evaluate((key) => window.localStorage.getItem(key), CART_STORAGE_KEY)
	).not.toBeNull();
});
