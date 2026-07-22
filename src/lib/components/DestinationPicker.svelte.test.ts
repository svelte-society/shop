import '../../app.css';
import { describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { DestinationOption, PricingDestination } from '$lib/domain/pricing';
import DestinationPicker from './DestinationPicker.svelte';

const destination: PricingDestination = {
	countryCode: 'SE',
	displayName: 'Sweden',
	region: 'eu',
	vatBasisPoints: 2500,
	requiresImportChargeCopy: false
};

const destinations: readonly DestinationOption[] = [
	{ countryCode: 'DE', displayName: 'Germany', region: 'eu' },
	{ countryCode: 'SE', displayName: 'Sweden', region: 'eu' },
	{ countryCode: 'JP', displayName: 'Japan', region: 'asia' }
];

function renderPicker() {
	return render(DestinationPicker, {
		destination,
		destinations,
		returnTo: '/products/society-tee?size=m'
	});
}

describe('DestinationPicker', () => {
	it('opens a labelled country chooser with regional groups and the current radio selected', async () => {
		renderPicker();

		const trigger = page.getByRole('button', {
			name: 'Choose delivery country, currently Sweden'
		});
		await expect.element(trigger).toHaveTextContent('Deliver to: Sweden');
		await trigger.click();

		await expect.element(page.getByRole('dialog')).toBeVisible();
		await expect
			.element(page.getByRole('heading', { name: 'Choose delivery country' }))
			.toBeVisible();
		await expect.element(page.getByRole('group', { name: 'EU countries' })).toBeVisible();
		await expect.element(page.getByRole('group', { name: 'Asia countries' })).toBeVisible();
		await expect.element(page.getByRole('radio', { name: 'Sweden' })).toBeChecked();
	});

	it('filters available country radios from the labelled search field', async () => {
		renderPicker();
		await page.getByRole('button', { name: 'Choose delivery country, currently Sweden' }).click();

		const search = page.getByRole('searchbox', { name: 'Search delivery countries' });
		await search.fill('japan');

		await expect.element(page.getByRole('radio', { name: 'Japan' })).toBeVisible();
		await expect.element(page.getByRole('radio', { name: 'Sweden' })).not.toBeInTheDocument();
	});

	it('keeps a native POST form with the selected country and return path', async () => {
		renderPicker();
		await page.getByRole('button', { name: 'Choose delivery country, currently Sweden' }).click();

		const form = document.querySelector('dialog form');
		expect(form).not.toBeNull();
		expect(form).toHaveAttribute('method', 'POST');
		expect(form).toHaveAttribute('action', '/preferences/destination');
		await expect
			.element(page.getByLabelText('Return to'))
			.toHaveValue('/products/society-tee?size=m');
	});

	it('closes with Escape and restores focus to the trigger', async () => {
		renderPicker();
		const trigger = page.getByRole('button', {
			name: 'Choose delivery country, currently Sweden'
		});
		await trigger.click();
		await expect.element(page.getByRole('dialog')).toBeVisible();

		await userEvent.keyboard('{Escape}');

		expect((document.querySelector('dialog') as HTMLDialogElement).open).toBe(false);
		expect(document.activeElement).toBe(trigger.element());
	});

	it('keeps trigger, options, and action buttons at least 44px high', async () => {
		renderPicker();
		const trigger = page.getByRole('button', {
			name: 'Choose delivery country, currently Sweden'
		});
		expect(Number.parseFloat(getComputedStyle(trigger.element()).minHeight)).toBeGreaterThanOrEqual(
			44
		);

		await trigger.click();
		const swedenOption = page.getByRole('radio', { name: 'Sweden' }).element().parentElement;
		expect(swedenOption).not.toBeNull();
		for (const control of [
			swedenOption as HTMLElement,
			page.getByRole('button', { name: 'Cancel' }),
			page.getByRole('button', { name: 'Update country' })
		]) {
			const element = control instanceof HTMLElement ? control : control.element();
			expect(Number.parseFloat(getComputedStyle(element).minHeight)).toBeGreaterThanOrEqual(44);
		}
	});
});
