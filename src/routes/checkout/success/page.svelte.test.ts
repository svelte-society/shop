import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { cart } from '$lib/stores/cart.svelte';
import SuccessPage from './+page.svelte';

const data = {
	storefrontEnabled: true,
	checkoutEnabled: true,
	showOpeningSoon: false,
	verified: true
} as const;

afterEach(() => cart.clear());

describe('verified checkout success page', () => {
	it('renders only the approved receipt, fulfillment, and support expectations', async () => {
		render(SuccessPage, { data, params: {}, form: null });

		await expect
			.element(page.getByRole('heading', { level: 1 }))
			.toHaveTextContent('Order received.');
		await expect
			.element(
				page.getByText(
					"Stripe is emailing your receipt and invoice now. Your order is queued for fulfillment review. We'll email again when it ships.",
					{ exact: true }
				)
			)
			.toBeVisible();
		const support = page.getByRole('link', { name: 'merch@sveltesociety.dev' });
		await expect.element(support).toHaveAttribute('href', 'mailto:merch@sveltesociety.dev');
		expect(document.body.textContent).not.toContain('Checkout complete');
		expect(document.body.textContent).not.toMatch(/cs_test|pi_test|cus_test|street|card/i);
	});

	it('clears the browser cart only after the verified page mounts', async () => {
		cart.add('price_accessory_one');
		expect(cart.totalUnits).toBe(1);

		render(SuccessPage, { data, params: {}, form: null });

		await expect.poll(() => cart.totalUnits).toBe(0);
		expect(window.localStorage.getItem('svelte-society-shop:cart:v1')).toBeNull();
	});
});
