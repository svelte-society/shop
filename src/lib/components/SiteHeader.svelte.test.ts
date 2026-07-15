import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { cart } from '$lib/stores/cart.svelte';
import SiteHeader from './SiteHeader.svelte';

describe('SiteHeader', () => {
	beforeEach(() => cart.clear());
	afterEach(() => cart.clear());

	it('exposes the primary storefront destinations as labelled links', async () => {
		render(SiteHeader);

		await expect
			.element(page.getByRole('link', { name: 'Society Shop home' }))
			.toHaveAttribute('href', '/');
		await expect
			.element(page.getByRole('link', { name: 'Collection' }))
			.toHaveAttribute('href', '/#collection');
		await expect
			.element(page.getByRole('link', { name: 'Svelte Society' }))
			.toHaveAttribute('href', 'https://sveltesociety.dev/');
		await expect
			.element(page.getByRole('link', { name: 'Cart, 0 items' }))
			.toHaveAttribute('href', '/cart');
	});

	it('keeps the accessible cart count in sync with cart behavior', async () => {
		render(SiteHeader);

		await expect.element(page.getByRole('link', { name: 'Cart, 0 items' })).toHaveTextContent('0');

		cart.add('price_test_shirt', 2);

		await expect.element(page.getByRole('link', { name: 'Cart, 2 items' })).toHaveTextContent('2');

		cart.setQuantity('price_test_shirt', 1);

		await expect.element(page.getByRole('link', { name: 'Cart, 1 item' })).toHaveTextContent('1');
	});
});
