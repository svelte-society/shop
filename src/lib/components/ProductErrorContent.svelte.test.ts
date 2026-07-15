import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ProductErrorContent from './ProductErrorContent.svelte';

describe('ProductErrorContent', () => {
	it('explains that a 404 product is not in the collection', async () => {
		render(ProductErrorContent, { status: 404 });

		await expect
			.element(page.getByRole('heading', { level: 1, name: 'Product not found.' }))
			.toBeVisible();
		await expect
			.element(page.getByText('That product is not in the current collection.'))
			.toBeVisible();
		await expect.element(page.getByRole('link', { name: 'Browse the collection' })).toBeVisible();
	});

	it('uses an honest recoverable message for an unexpected error', async () => {
		render(ProductErrorContent, { status: 500 });

		await expect
			.element(page.getByRole('heading', { level: 1, name: 'Something went wrong.' }))
			.toBeVisible();
		await expect
			.element(page.getByText('The shop hit an unexpected error. Try again shortly.'))
			.toBeVisible();
		await expect.element(page.getByRole('link', { name: 'Back to the shop' })).toBeVisible();
	});
});
