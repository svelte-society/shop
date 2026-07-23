import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PublicCatalogProduct } from '$lib/domain/catalog';
import { pricingDestination } from '$lib/domain/pricing';
import CatalogUnavailable from './CatalogUnavailable.svelte';
import ProductGallery from './ProductGallery.svelte';
import ProductGrid from './ProductGrid.svelte';
import ProductPage from '../../routes/products/[slug]/+page.svelte';

const apparel: PublicCatalogProduct = {
	slug: 'society-tee',
	name: 'Society Tee',
	description: 'A tee for Svelte meetups and everyday code.',
	images: [
		'https://cdn.example.com/society-tee-front.jpg',
		'https://cdn.example.com/society-tee-back.jpg'
	],
	sortOrder: 10,
	category: 'apparel',
	materials: 'Organic cotton',
	care: 'Wash at 30°C',
	fit: 'Regular fit',
	sizeGuideUrl: null,
	sizeChart: null,
	variants: [
		{
			priceId: 'price_tee',
			label: 'M',
			sortOrder: 10,
			currency: 'eur',
			unitAmountCents: 2_000
		}
	]
};

const accessory: PublicCatalogProduct = {
	...apparel,
	slug: 'society-mug',
	name: 'Society Mug',
	category: 'accessory',
	fit: null,
	images: ['https://cdn.example.com/society-mug.jpg'],
	variants: [{ ...apparel.variants[0], priceId: 'price_mug', label: 'One size' }]
};
const destination = pricingDestination('SE');

describe('catalog display components', () => {
	it('groups a mixed collection and exposes each product as a labelled link', async () => {
		render(ProductGrid, { products: [apparel, accessory], destination });

		await expect.element(page.getByRole('heading', { name: 'Apparel' })).toBeVisible();
		await expect.element(page.getByRole('heading', { name: 'Accessories' })).toBeVisible();
		const teeLink = page.getByRole('link', { name: /Society Tee/ });
		await expect.element(teeLink).toHaveAttribute('href', '/products/society-tee');
		await expect.element(teeLink).toHaveTextContent('€25.00');
	});

	it('shows an actionable empty collection state', async () => {
		render(ProductGrid, { products: [], destination });

		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent('The collection is being arranged. Check back shortly.');
	});

	it('switches the main product image from a labelled thumbnail control', async () => {
		render(ProductGallery, { name: apparel.name, images: apparel.images });

		await expect
			.element(page.getByRole('img', { name: 'Society Tee, image 1 of 2' }))
			.toBeVisible();
		await page.getByRole('button', { name: 'Show Society Tee image 2' }).click();
		await expect
			.element(page.getByRole('img', { name: 'Society Tee, image 2 of 2' }))
			.toBeVisible();
	});

	it('reveals a product image that is already cached when the component mounts', async () => {
		const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);

		try {
			render(ProductGallery, { name: apparel.name, images: apparel.images });

			expect(
				page.getByRole('img', { name: 'Society Tee, image 1 of 2' }).element().parentElement
			).toHaveAttribute('aria-busy', 'false');
			expect(page.getByText('Loading product image…').query()).toBeNull();
		} finally {
			complete.mockRestore();
		}
	});

	it('renders and selects duplicate image URLs by their position', async () => {
		const duplicateUrl = 'https://cdn.example.com/society-tee-detail.jpg';
		render(ProductGallery, {
			name: apparel.name,
			images: [duplicateUrl, duplicateUrl]
		});

		await expect
			.element(page.getByRole('img', { name: 'Society Tee, image 1 of 2' }))
			.toBeVisible();
		await page.getByRole('button', { name: 'Show Society Tee image 2' }).click();
		await expect
			.element(page.getByRole('img', { name: 'Society Tee, image 2 of 2' }))
			.toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Show Society Tee image 1' }))
			.toHaveAttribute('aria-pressed', 'false');
		await expect
			.element(page.getByRole('button', { name: 'Show Society Tee image 2' }))
			.toHaveAttribute('aria-pressed', 'true');
	});

	it('resets the gallery to the first image when reused for another product', async () => {
		const view = render(ProductGallery, { name: apparel.name, images: apparel.images });
		await page.getByRole('button', { name: 'Show Society Tee image 2' }).click();

		await view.rerender({
			name: 'Society Hoodie',
			images: [
				'https://cdn.example.com/society-hoodie-front.jpg',
				'https://cdn.example.com/society-hoodie-back.jpg'
			]
		});

		await expect
			.element(page.getByRole('img', { name: 'Society Hoodie, image 1 of 2' }))
			.toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Show Society Hoodie image 1' }))
			.toHaveAttribute('aria-pressed', 'true');
	});

	it('uses the approved temporary-unavailable message', async () => {
		render(CatalogUnavailable);

		await expect
			.element(page.getByRole('heading', { name: 'Collection temporarily unavailable.' }))
			.toBeVisible();
		await expect.element(page.getByText('Your cart is safe. Try again shortly.')).toBeVisible();
	});

	it('uses a page-level heading for an unavailable product page', async () => {
		render(ProductPage, {
			data: { product: null, catalogUnavailable: true },
			params: { slug: 'society-tee' },
			form: null
		});

		await expect
			.element(page.getByRole('heading', { level: 1, name: 'Collection temporarily unavailable.' }))
			.toBeVisible();
	});
});
