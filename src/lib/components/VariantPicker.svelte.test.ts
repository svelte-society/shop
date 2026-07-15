import { describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PublicCatalogVariant } from '$lib/domain/catalog';
import VariantPicker from './VariantPicker.svelte';

const variants: PublicCatalogVariant[] = [
	{
		priceId: 'price_small',
		label: 'S',
		sortOrder: 10,
		currency: 'eur',
		unitAmountCents: 2_000,
		referenceGrossCents: 2_500
	},
	{
		priceId: 'price_medium',
		label: 'M',
		sortOrder: 20,
		currency: 'eur',
		unitAmountCents: 2_000,
		referenceGrossCents: 2_500
	}
];

describe('VariantPicker', () => {
	it('requires an explicit apparel selection', async () => {
		const onSelectionChange = vi.fn();
		render(VariantPicker, { category: 'apparel', variants, onSelectionChange });

		await expect.element(page.getByRole('radiogroup', { name: 'Choose a size' })).toBeVisible();
		await expect.element(page.getByRole('radio', { name: 'S' })).not.toBeChecked();
		await expect.element(page.getByRole('radio', { name: 'M' })).not.toBeChecked();
		await expect.element(page.getByRole('status')).toHaveTextContent('Choose a size to continue.');
		expect(onSelectionChange).not.toHaveBeenCalled();
	});

	it('automatically selects a single accessory variant without a redundant control', async () => {
		const onSelectionChange = vi.fn();
		render(VariantPicker, {
			category: 'accessory',
			variants: [{ ...variants[0], priceId: 'price_one_size', label: 'One size' }],
			onSelectionChange
		});

		await expect.element(page.getByRole('status')).toHaveTextContent('One size selected.');
		expect(page.getByRole('radiogroup', { name: 'Choose a size' }).query()).toBeNull();
		expect(onSelectionChange).toHaveBeenCalledOnce();
		expect(onSelectionChange).toHaveBeenCalledWith('price_one_size');
	});

	it('updates the nearby live region when keyboard selection changes', async () => {
		const onSelectionChange = vi.fn();
		render(VariantPicker, { category: 'apparel', variants, onSelectionChange });
		await page.getByText('S', { exact: true }).click();
		await userEvent.keyboard('{ArrowRight}');

		await expect.element(page.getByRole('radio', { name: 'M' })).toBeChecked();
		await expect.element(page.getByRole('status')).toHaveTextContent('M selected.');
		expect(onSelectionChange).toHaveBeenLastCalledWith('price_medium');
	});
});
