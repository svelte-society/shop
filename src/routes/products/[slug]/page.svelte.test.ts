import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PublicCatalogProduct } from '$lib/domain/catalog';
import { pricingDestination } from '$lib/domain/pricing';
import ProductPage from './+page.svelte';

const communityTee: PublicCatalogProduct = {
	slug: 'community-tee',
	name: 'Community Tee',
	description: 'Black organic cotton with the Svelte mark embroidered on the front.',
	images: ['https://cdn.example.com/community-tee.png'],
	sortOrder: 10,
	category: 'apparel',
	materials: '100% organic ring-spun combed cotton · 180 gsm',
	care: 'Wash at 30°C',
	fit: 'Medium fit',
	sizeGuideUrl: null,
	sizeChart: {
		unit: 'cm',
		sizes: ['S', 'M', 'L'],
		measurements: [
			{ label: 'Half chest', values: [49.5, 53.5, 56.5] },
			{ label: 'Body length', values: [69, 73, 75] },
			{ label: 'Sleeve length', values: [22.5, 24, 24.5] }
		]
	},
	variants: [
		{
			priceId: 'price_small',
			label: 'S',
			sortOrder: 10,
			currency: 'eur',
			unitAmountCents: 2_000
		},
		{
			priceId: 'price_medium',
			label: 'M',
			sortOrder: 20,
			currency: 'eur',
			unitAmountCents: 2_000
		},
		{
			priceId: 'price_large',
			label: 'L',
			sortOrder: 30,
			currency: 'eur',
			unitAmountCents: 2_000
		}
	]
};

function renderCommunityTee(): void {
	render(ProductPage, {
		data: { product: communityTee, catalogUnavailable: false, pricingDestination: pricingDestination('SE') },
		params: { slug: communityTee.slug },
		form: null
	});
}

describe('product details', () => {
	it('renders size measurements supplied by product metadata', async () => {
		render(ProductPage, {
			data: {
				product: {
					...communityTee,
					sizeChart: {
						unit: 'cm',
						sizes: ['S', 'M', 'L'],
						measurements: [
							{ label: 'Half chest', values: [50, 54, 57] },
							{ label: 'Body length', values: [70, 74, 76] }
						]
					}
				},
				catalogUnavailable: false,
				pricingDestination: pricingDestination('SE')
			},
			params: { slug: communityTee.slug },
			form: null
		});

		const table = page.getByRole('table', { name: 'Community Tee size guide' });
		await expect.element(table.getByRole('row', { name: 'Half chest 50 54 57' })).toBeVisible();
		await expect.element(table.getByRole('row', { name: 'Body length 70 74 76' })).toBeVisible();
	});

	it('shows the Community Tee measurements for each offered size', async () => {
		renderCommunityTee();

		const table = page.getByRole('table', { name: 'Community Tee size guide' });
		await expect.element(table).toBeVisible();
		for (const heading of ['Measurement', 'S', 'M', 'L']) {
			await expect
				.element(table.getByRole('columnheader', { name: heading, exact: true }))
				.toBeVisible();
		}
		await expect
			.element(table.getByRole('row', { name: 'Half chest 49.5 53.5 56.5' }))
			.toBeVisible();
		await expect.element(table.getByRole('row', { name: 'Body length 69 73 75' })).toBeVisible();
		await expect
			.element(table.getByRole('row', { name: 'Sleeve length 22.5 24 24.5' }))
			.toBeVisible();
	});

	it('keeps generic delivery and returns content out of item details', () => {
		renderCommunityTee();

		expect(page.getByRole('heading', { name: 'Materials' }).element()).toBeTruthy();
		expect(page.getByRole('heading', { name: 'Fit' }).element()).toBeTruthy();
		expect(page.getByRole('heading', { name: 'Care' }).element()).toBeTruthy();
		expect(page.getByRole('heading', { name: 'Delivery' }).query()).toBeNull();
		expect(page.getByRole('heading', { name: 'Returns' }).query()).toBeNull();
	});

	it('projects the item price and import-charge copy for the selected Asian destination', async () => {
		render(ProductPage, {
			data: { product: communityTee, catalogUnavailable: false, pricingDestination: pricingDestination('JP') },
			params: { slug: communityTee.slug },
			form: null
		});

		await expect.element(page.getByText('€20.00')).toBeVisible();
		await expect
			.element(
				page.getByText(
					'EU VAT excluded. Import VAT, duties, brokerage, or carrier fees may be charged on arrival.'
				)
			)
			.toBeVisible();
	});
});
