import { expect, test } from '@playwright/test';

const CATALOG_UNAVAILABLE_ORIGIN = 'http://127.0.0.1:4274';
const STOREFRONT_DISABLED_ORIGIN = 'http://127.0.0.1:4275';

test('homepage presents the approved responsive collection journey', async ({ page }) => {
	await page.goto('/');

	await expect(page).toHaveTitle('Svelte Society Shop — Official Community Merch');
	await expect(
		page.getByRole('heading', { level: 1, name: 'Made for people who make with Svelte.' })
	).toBeVisible();
	await expect(page.getByText('Free shipping when you pick two.', { exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: 'Apparel' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: 'Accessories' })).toBeVisible();
	await expect(page.getByRole('link', { name: /Community Tee/ })).toHaveAttribute(
		'href',
		'/products/community-tee'
	);
	await expect(page.getByRole('link', { name: /Society Mug/ })).toHaveAttribute(
		'href',
		'/products/society-mug'
	);

	const hasHorizontalOverflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth
	);
	expect(hasHorizontalOverflow).toBe(false);
});

test('apparel requires a size before adding the selected variant', async ({ page }) => {
	await page.goto('/products/community-tee');

	await expect(page.getByRole('heading', { level: 1, name: 'Community Tee' })).toBeVisible();
	await expect(page.getByRole('status', { name: 'Variant status' })).toHaveText(
		'Choose a size to continue.'
	);
	await page.getByRole('button', { name: 'Add to cart' }).click();
	await expect(page.getByRole('alert')).toHaveText('Choose a size before adding to cart.');

	await page.getByText('M', { exact: true }).click();
	await page.getByRole('button', { name: 'Add to cart' }).click();
	await expect(page.getByRole('status', { name: 'Cart status' })).toHaveText(
		'Community Tee, M added to cart.'
	);
	await expect(page.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();
});

test('single-variant accessory is ready to add without a redundant selector', async ({ page }) => {
	await page.goto('/products/society-mug');

	await expect(page.getByRole('heading', { level: 1, name: 'Society Mug' })).toBeVisible();
	await expect(page.getByRole('radiogroup')).toHaveCount(0);
	await expect(page.getByRole('status', { name: 'Variant status' })).toHaveText(
		'One size selected.'
	);

	await page.getByRole('button', { name: 'Add to cart' }).click();
	await expect(page.getByRole('status', { name: 'Cart status' })).toHaveText(
		'Society Mug, One size added to cart.'
	);
	await expect(page.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();
});

test('catalog outage shows the approved recoverable failure state', async ({ page }) => {
	await page.goto(CATALOG_UNAVAILABLE_ORIGIN);

	await expect(
		page.getByRole('heading', { level: 2, name: 'Collection temporarily unavailable.' })
	).toBeVisible();
	await expect(page.getByText('Your cart is safe. Try again shortly.')).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test('disabled storefront stops commerce before private catalog work', async ({ page }) => {
	await page.goto(`${STOREFRONT_DISABLED_ORIGIN}/products/community-tee`);

	await expect(page).toHaveURL(`${STOREFRONT_DISABLED_ORIGIN}/`);
	await expect(
		page.getByRole('heading', { level: 1, name: 'The collection is getting ready.' })
	).toBeVisible();
	await expect(page.getByRole('link', { name: 'Visit Svelte Society' })).toBeVisible();
});
