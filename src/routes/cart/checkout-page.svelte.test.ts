import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PublicCatalogProduct } from '$lib/domain/catalog';
import { cart } from '$lib/stores/cart.svelte';
import { pricingDestination } from '$lib/domain/pricing';

const beginCheckout = vi.hoisted(() => vi.fn<(lines: unknown) => Promise<void>>());
const track = vi.hoisted(() => vi.fn());

vi.mock('$lib/client/checkout', () => ({ beginCheckout }));
vi.mock('$lib/analytics/events', () => ({ track }));

import CartPage from './+page.svelte';

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
	variants: [
		{
			priceId: 'price_tee_medium_current',
			label: 'M',
			sortOrder: 10,
			currency: 'eur',
			unitAmountCents: 2_000
		}
	]
};

const data = {
	products: [product],
	catalogUnavailable: false,
	checkoutEnabled: true,
	pricingDestination: pricingDestination('DE')
};

describe('cart page checkout submission state', () => {
	beforeEach(() => {
		beginCheckout.mockReset();
		cart.clear();
		cart.add('price_tee_medium_current');
		track.mockReset();
	});

	it('reports the cart view once when the page mounts', async () => {
		render(CartPage, { data, params: {}, form: null });

		await expect.poll(() => track.mock.calls).toEqual([['cart_viewed']]);
		await expect.element(page.getByText('Merchandise')).toBeVisible();
		const summary = page.getByRole('complementary', { name: 'Order summary' });
		await expect.element(summary.getByText('€23.80')).toBeVisible();
		await expect.element(summary.getByText('€9.52')).toBeVisible();
		await expect.element(summary.getByText('€5.32')).toBeVisible();
		await expect.element(summary.getByText('€33.32')).toBeVisible();
	});

	it('keeps the button disabled and blocks a second request after navigation is assigned', async () => {
		const assigned: string[] = [];
		beginCheckout.mockImplementation(async () => {
			assigned.push('https://checkout.stripe.com/c/pay/cs_test_client');
		});
		render(CartPage, { data, params: {}, form: null });
		const button = page.getByRole('button', { name: 'Continue to secure checkout' });
		await expect.poll(() => track).toHaveBeenCalledWith('cart_viewed');
		track.mockReset();

		await button.click();

		expect(assigned).toEqual(['https://checkout.stripe.com/c/pay/cs_test_client']);
		expect(track.mock.calls).toEqual([['checkout_started']]);
		const pendingButton = page.getByRole('button', { name: 'Opening secure checkout…' });
		await expect.element(pendingButton).toBeDisabled();
		(pendingButton.element() as HTMLButtonElement).click();
		expect(beginCheckout).toHaveBeenCalledTimes(1);
	});

	it('re-enables checkout after failure without changing the cart', async () => {
		const originalLines = structuredClone(cart.lines);
		beginCheckout.mockRejectedValue(new Error('provider failure'));
		render(CartPage, { data, params: {}, form: null });
		const button = page.getByRole('button', { name: 'Continue to secure checkout' });

		await button.click();

		await expect.element(button).toBeEnabled();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent(
				'Checkout is temporarily unavailable. Your cart is safe. Try again shortly.'
			);
		expect(cart.lines).toEqual(originalLines);
	});

	it('removes a stale price only while the catalog is available', async () => {
		cart.clear();
		cart.add('price_tee_medium_old');
		render(CartPage, { data, params: {}, form: null });

		await expect
			.element(page.getByText('A product price changed. Please add the item again.'))
			.toBeVisible();
		expect(cart.lines).toEqual([]);
	});

	it('preserves a stale price during a catalog outage', async () => {
		cart.clear();
		cart.add('price_tee_medium_old');
		render(CartPage, { data: { ...data, catalogUnavailable: true }, params: {}, form: null });

		await expect.element(page.getByText('Collection temporarily unavailable.')).toBeVisible();
		expect(cart.lines).toEqual([{ priceId: 'price_tee_medium_old', quantity: 1 }]);
	});
});
