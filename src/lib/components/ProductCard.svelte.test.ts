import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PublicCatalogProduct } from '$lib/domain/catalog';
import { pricePublicProduct, pricingDestination } from '$lib/domain/pricing';

const track = vi.hoisted(() => vi.fn());

vi.mock('$lib/analytics/events', () => ({ track }));

import ProductCard from './ProductCard.svelte';

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
const destination = pricingDestination('SE');

describe('ProductCard analytics', () => {
	beforeEach(() => {
		track.mockReset();
	});

	it('reports the product navigation once without product data', async () => {
		render(ProductCard, { product: pricePublicProduct(product, destination) });
		const link = page.getByRole('link', { name: /Community Tee/ });
		link.element().addEventListener('click', (event) => event.preventDefault());

		await link.click();

		expect(track.mock.calls).toEqual([['product_viewed']]);
	});

	it.each([
		['SE', '€25.00'],
		['DE', '€23.80'],
		['JP', '€20.00']
	] as const)('projects a net catalog price for %s', async (country, amount) => {
		render(ProductCard, { product: pricePublicProduct(product, pricingDestination(country)) });
		await expect.element(page.getByText(amount)).toBeVisible();
	});
});
