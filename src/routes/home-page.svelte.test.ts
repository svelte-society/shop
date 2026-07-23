import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { pricingDestination } from '$lib/domain/pricing';
import HomePage from './+page.svelte';

describe('storefront home page', () => {
	it('leads with Society support and keeps practical ordering details after the collection', async () => {
		render(HomePage, {
			data: {
				products: [],
				paidShippingNetCents: null,
				stale: false,
				catalogUnavailable: false,
				pricingDestination: pricingDestination('SE')
			},
			params: {},
			form: null
		});

		await expect
			.element(page.getByRole('heading', { name: 'Wear Svelte. Support the community.' }))
			.toBeVisible();
		await expect
			.element(
				page.getByText(
					'Every purchase supports Svelte Society’s continued work across the ecosystem—organizing community events, sharing useful resources, and helping Svelte developers connect.',
					{ exact: true }
				)
			)
			.toBeVisible();
		await expect
			.element(page.getByRole('heading', { name: 'Your purchase supports' }))
			.toBeVisible();

		for (const item of [
			'Community events',
			'Shared resources',
			'Open-source projects',
			'Developer connections'
		]) {
			await expect.element(page.getByText(item, { exact: true })).toBeVisible();
		}

		expect(page.getByText('items ship free', { exact: false }).query()).toBeNull();
		await expect
			.element(page.getByRole('heading', { name: 'From cart to doorstep.' }))
			.toBeVisible();
		await expect
			.element(page.getByText('Free shipping when you pick two or more.', { exact: false }))
			.toBeVisible();
		expect(
			page.getByRole('heading', { name: 'Find your piece of the Society.' }).query()
		).toBeNull();
		expect(page.getByRole('link', { name: 'Shop the collection' }).all()).toHaveLength(1);
	});
});
