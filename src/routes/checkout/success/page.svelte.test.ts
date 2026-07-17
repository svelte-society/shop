import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { cart } from '$lib/stores/cart.svelte';

const track = vi.hoisted(() => vi.fn());

vi.mock('$lib/analytics/events', () => ({ track }));

import SuccessPage from './+page.svelte';

const data = {
	storefrontEnabled: true,
	checkoutEnabled: true,
	showOpeningSoon: false,
	verified: true
} as const;

let originalUrl: string;
let originalHistoryState: unknown;

function replaceBrowserUrl(state: unknown, url: string | URL): void {
	History.prototype.replaceState.call(window.history, state, '', url);
}

beforeEach(() => {
	originalUrl = window.location.href;
	originalHistoryState = window.history.state;
});

afterEach(() => {
	replaceBrowserUrl(originalHistoryState, originalUrl);
	track.mockReset();
	cart.clear();
});

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
		await expect.poll(() => track.mock.calls).toEqual([['checkout_returned_successfully']]);
	});

	it('clears the browser cart only after the verified page mounts', async () => {
		cart.add('price_accessory_one');
		expect(cart.totalUnits).toBe(1);
		track.mockReset();

		render(SuccessPage, { data, params: {}, form: null });

		await expect.poll(() => cart.totalUnits).toBe(0);
		expect(window.localStorage.getItem('svelte-society-shop:cart:v1')).toBeNull();
		expect(track.mock.calls).toEqual([['checkout_returned_successfully']]);
	});

	it('removes the checkout query before tracking while preserving pathname and hash', async () => {
		const urlsObservedByTracker: string[] = [];
		replaceBrowserUrl(
			{ verified: true },
			'/checkout/success?session_id=cs_test_must_not_leave#receipt'
		);
		track.mockImplementation(() => {
			urlsObservedByTracker.push(
				`${window.location.pathname}${window.location.search}${window.location.hash}`
			);
		});

		render(SuccessPage, { data, params: {}, form: null });

		await expect.poll(() => track.mock.calls).toEqual([['checkout_returned_successfully']]);
		expect(urlsObservedByTracker).toEqual(['/checkout/success#receipt']);
		expect(window.location.pathname).toBe('/checkout/success');
		expect(window.location.search).toBe('');
		expect(window.location.hash).toBe('#receipt');
	});
});
