import { expect, test, type Page } from '@playwright/test';

const CART_STORAGE_KEY = 'svelte-society-shop:cart:v1';
const CHECKOUT_DISABLED_ORIGIN = 'http://127.0.0.1:4273';
const CHECKOUT_ENABLED_ORIGIN = 'http://127.0.0.1:4276';
const CART_SEEDED_SESSION_KEY = 'svelte-society-shop:e2e-cart-seeded';
const STORED_CART = {
	version: 1,
	lines: [{ priceId: 'price_accessory_one', quantity: 1 }]
} as const;

async function seedCart(page: Page, origin: string): Promise<void> {
	await page.addInitScript(
		({ expectedOrigin, key, sessionKey, value }) => {
			if (
				window.location.origin === expectedOrigin &&
				window.sessionStorage.getItem(sessionKey) !== 'true'
			) {
				window.localStorage.setItem(key, JSON.stringify(value));
				window.sessionStorage.setItem(sessionKey, 'true');
			}
		},
		{
			expectedOrigin: origin,
			key: CART_STORAGE_KEY,
			sessionKey: CART_SEEDED_SESSION_KEY,
			value: STORED_CART
		}
	);
}

async function storedCart(page: Page): Promise<string | null> {
	return page.evaluate((key) => window.localStorage.getItem(key), CART_STORAGE_KEY);
}

test('checkout disabled leaves the persisted cart behind a disabled action', async ({ page }) => {
	await seedCart(page, CHECKOUT_DISABLED_ORIGIN);
	await page.goto(`${CHECKOUT_DISABLED_ORIGIN}/cart`);

	await expect(page.getByRole('button', { name: 'Checkout opens soon' })).toBeDisabled();
	expect(JSON.parse((await storedCart(page)) ?? 'null')).toEqual(STORED_CART);
});

test('checkout error announces recovery and preserves the cart', async ({ page }) => {
	await seedCart(page, CHECKOUT_ENABLED_ORIGIN);
	await page.route(`${CHECKOUT_ENABLED_ORIGIN}/checkout`, async (route) => {
		await route.fulfill({
			status: 503,
			contentType: 'application/problem+json',
			body: JSON.stringify({
				type: 'about:blank',
				title: 'Checkout unavailable',
				status: 503,
				code: 'CHECKOUT_PROVIDER_UNAVAILABLE'
			})
		});
	});
	await page.goto(`${CHECKOUT_ENABLED_ORIGIN}/cart`);

	await page.getByRole('button', { name: 'Continue to secure checkout' }).click();
	await expect(page.getByRole('alert')).toHaveText(
		'Checkout is temporarily unavailable. Your cart is safe. Try again shortly.'
	);
	expect(JSON.parse((await storedCart(page)) ?? 'null')).toEqual(STORED_CART);
});

test('successful checkout creation navigates only to the secure Stripe host', async ({ page }) => {
	const redirectUrl = 'https://checkout.stripe.com/c/pay/cs_test_browser_redirect';
	await seedCart(page, CHECKOUT_ENABLED_ORIGIN);
	await page.route(`${CHECKOUT_ENABLED_ORIGIN}/checkout`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ redirectUrl })
		});
	});
	await page.route('https://checkout.stripe.com/**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<h1>Stripe Checkout</h1>'
		});
	});
	await page.goto(`${CHECKOUT_ENABLED_ORIGIN}/cart`);

	await page.getByRole('button', { name: 'Continue to secure checkout' }).click();
	await expect(page).toHaveURL(redirectUrl);
	await expect(page.getByRole('heading', { name: 'Stripe Checkout' })).toBeVisible();

	await page.goto(`${CHECKOUT_ENABLED_ORIGIN}/cart`);
	expect(JSON.parse((await storedCart(page)) ?? 'null')).toEqual(STORED_CART);
});

test('checkout cancellation keeps the cart available for recovery', async ({ page }) => {
	await seedCart(page, CHECKOUT_ENABLED_ORIGIN);
	await page.goto(`${CHECKOUT_ENABLED_ORIGIN}/checkout/cancel`);

	await expect(page.getByRole('heading', { level: 1, name: 'Checkout cancelled.' })).toBeVisible();
	await expect(
		page.getByText('Your cart is still saved. Review it whenever you are ready.')
	).toBeVisible();
	expect(JSON.parse((await storedCart(page)) ?? 'null')).toEqual(STORED_CART);
});

test('verified paid merch success shows approved copy and clears the cart after load', async ({
	page
}) => {
	await seedCart(page, CHECKOUT_ENABLED_ORIGIN);
	const response = await page.goto(
		`${CHECKOUT_ENABLED_ORIGIN}/checkout/success?session_id=cs_test_browser_verified`
	);

	expect(response?.status()).toBe(200);
	await expect(page.getByRole('heading', { level: 1, name: 'Order received.' })).toBeVisible();
	await expect(
		page.getByText(
			"Stripe is emailing your receipt and invoice now. We've received your order and will email you again when it ships.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		page.locator('#main-content').getByRole('link', { name: 'merch@sveltesociety.dev' })
	).toHaveAttribute('href', 'mailto:merch@sveltesociety.dev');
	await expect.poll(() => storedCart(page)).toBeNull();
	await expect(page.getByRole('link', { name: 'Cart, 0 items' })).toBeVisible();
	expect(await page.locator('body').innerText()).not.toMatch(
		/cs_test|pi_test|cus_test|street|card/i
	);
});

test('unverified success fails closed without clearing the cart', async ({ page }) => {
	await seedCart(page, CHECKOUT_ENABLED_ORIGIN);
	const response = await page.goto(
		`${CHECKOUT_ENABLED_ORIGIN}/checkout/success?session_id=cs_test_browser_unverified`
	);

	expect(response?.status()).toBe(404);
	await expect(page.getByRole('heading', { level: 1, name: 'Order received.' })).toHaveCount(0);
	expect(JSON.parse((await storedCart(page)) ?? 'null')).toEqual(STORED_CART);
});
