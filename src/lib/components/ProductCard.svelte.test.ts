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
			priceId: 'price_tee_small_current',
			label: 'S',
			sortOrder: 10,
			currency: 'eur',
			unitAmountCents: 2_000
		},
		{
			priceId: 'price_tee_medium_current',
			label: 'M',
			sortOrder: 20,
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
		const link = page.getByRole('link').first();
		link.element().addEventListener('click', (event) => event.preventDefault());

		await link.click();

		expect(track.mock.calls).toEqual([['product_viewed']]);
	});

	it('keeps product navigation and quick add as separate card interactions', async () => {
		render(ProductCard, { product: pricePublicProduct(product, destination) });

		await expect.element(page.getByRole('button', { name: 'Add to cart' })).toBeVisible();
		expect(page.getByRole('link').all()).toHaveLength(2);
		expect(
			document.querySelector('a button, button a, a [role="button"], button [role="link"]')
		).toBeNull();
	});

	it.each([
		['SE', '€25.00'],
		['DE', '€23.80'],
		['JP', '€20.00']
	] as const)('projects a net catalog price for %s', async (country, amount) => {
		render(ProductCard, { product: pricePublicProduct(product, pricingDestination(country)) });
		await expect.element(page.getByText(amount)).toBeVisible();
	});

	it('reveals an already-cached product image on mount', async () => {
		const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);

		try {
			render(ProductCard, { product: pricePublicProduct(product, destination) });

			expect(
				page.getByRole('img', { name: 'Community Tee' }).element().closest('.product-frame')
			).toHaveAttribute('aria-busy', 'false');
			expect(page.getByText('Loading product image…').query()).toBeNull();
		} finally {
			complete.mockRestore();
		}
	});
});
