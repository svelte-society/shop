import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PublicCatalogProduct } from '$lib/domain/catalog';
import { pricingDestination } from '$lib/domain/pricing';
import HomePage from './+page.svelte';

const product: PublicCatalogProduct = {
	slug: 'community-tee',
	name: 'Community Tee',
	description: 'A community tee for people who make with Svelte.',
	images: ['https://cdn.example.com/products/community-tee.png'],
	sortOrder: 10,
	category: 'apparel',
	materials: '100% organic cotton',
	care: 'Wash at 30°C',
	fit: 'Regular fit',
	sizeGuideUrl: null,
	sizeChart: null,
	variants: [
		{
			priceId: 'price_tee_m',
			label: 'M',
			sortOrder: 10,
			currency: 'eur',
			unitAmountCents: 2_000
		}
	]
};

describe('storefront home page', () => {
	it('leads with products, then explains Society support before practical ordering details', async () => {
		render(HomePage, {
			data: {
				products: [product],
				paidShippingNetCents: null,
				stale: false,
				catalogUnavailable: false,
				pricingDestination: pricingDestination('SE')
			},
			params: {},
			form: null
		});

		const collection = page.getByRole('heading', { level: 1, name: 'Shop the collection.' });
		const mission = page.getByRole('heading', {
			level: 2,
			name: 'Wear Svelte. Support the community.'
		});
		const commerce = page.getByRole('heading', { level: 2, name: 'From cart to doorstep.' });

		await expect.element(collection).toBeVisible();
		await expect.element(page.getByRole('link', { name: /Community Tee/ }).first()).toBeVisible();
		await expect.element(mission).toBeVisible();
		expect(
			collection.element().compareDocumentPosition(mission.element()) &
				Node.DOCUMENT_POSITION_FOLLOWING
		).not.toBe(0);
		expect(
			mission.element().compareDocumentPosition(commerce.element()) &
				Node.DOCUMENT_POSITION_FOLLOWING
		).not.toBe(0);
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
		await expect.element(commerce).toBeVisible();
		await expect
			.element(page.getByText('Free shipping when you pick two or more.', { exact: false }))
			.toBeVisible();
		expect(
			page.getByRole('heading', { name: 'Find your piece of the Society.' }).query()
		).toBeNull();
		expect(page.getByRole('link', { name: 'Shop the collection' }).query()).toBeNull();
		expect(page.getByRole('heading', { name: 'Svelte, out in the world.' }).query()).toBeNull();
	});
});
