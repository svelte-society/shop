import '../../app.css';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { DestinationOption, PricingDestination } from '$lib/domain/pricing';

const navigation = vi.hoisted(() => ({ invalidate: vi.fn(), goto: vi.fn() }));

vi.mock('$app/navigation', () => navigation);

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

const fetchMock = vi.fn();
const { goto, invalidate } = navigation;

beforeEach(() => {
	fetchMock.mockReset();
	invalidate.mockReset();
	goto.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('DestinationPicker', () => {
	it('opens a labelled country chooser with regional groups and the current radio selected', async () => {
		renderPicker();

		const trigger = page.getByRole('button', {
			name: 'Choose delivery country, currently Sweden'
		});
		await expect.element(trigger).toHaveAttribute('title', 'Deliver to Sweden');
		expect(trigger.element().textContent?.replace(/\s/g, '')).toBe('🇸🇪⌄');
		await expect.element(trigger).not.toHaveTextContent('Deliver to: Sweden');
		await trigger.click();

		await expect.element(page.getByRole('dialog')).toBeVisible();
		await expect
			.element(page.getByRole('heading', { name: 'Choose delivery country' }))
			.toBeVisible();
		await expect.element(page.getByRole('group', { name: 'EU countries' })).toBeVisible();
		await expect.element(page.getByRole('group', { name: 'Asia countries' })).toBeVisible();
		await expect.element(page.getByRole('radio', { name: 'Sweden' })).toBeChecked();
	});

	it('keeps the selected country successful in native form data when filtering radios', async () => {
		renderPicker();
		await page.getByRole('button', { name: 'Choose delivery country, currently Sweden' }).click();

		const search = page.getByRole('searchbox', { name: 'Search delivery countries' });
		await search.fill('japan');

		await expect.element(page.getByRole('radio', { name: 'Japan' })).toBeVisible();
		const form = document.querySelector<HTMLFormElement>('dialog form');
		expect(form).not.toBeNull();
		expect(new FormData(form as HTMLFormElement).get('country')).toBe('SE');

		await search.fill('not-a-country');
		expect(new FormData(form as HTMLFormElement).get('country')).toBe('SE');
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

	it('keeps a fixed dialog shell while only the country list scrolls', async () => {
		renderPicker();
		await page.getByRole('button', { name: 'Choose delivery country, currently Sweden' }).click();

		const dialog = page.getByRole('dialog').element();
		const form = dialog.querySelector('form');
		const countryList = dialog.querySelector<HTMLElement>('.destination-groups');
		const actions = dialog.querySelector<HTMLElement>('.dialog-actions');

		expect(form).not.toBeNull();
		expect(countryList).not.toBeNull();
		expect(actions).not.toBeNull();
		expect(getComputedStyle(dialog).overflow).toBe('hidden');
		expect(getComputedStyle(form as HTMLFormElement).overflow).toBe('hidden');
		expect(getComputedStyle(countryList as HTMLElement).overflowY).toBe('auto');
		expect(getComputedStyle(countryList as HTMLElement).minHeight).toBe('0px');
		await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
		await expect.element(page.getByRole('button', { name: 'Update country' })).toBeVisible();
	});

	it('posts the validated selection, exposes pending state, invalidates pricing, and announces it', async () => {
		let resolveFetch: (response: Response) => void;
		fetchMock.mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				})
		);
		invalidate.mockResolvedValue(undefined);
		renderPicker();
		await page.getByRole('button', { name: 'Choose delivery country, currently Sweden' }).click();
		await page.getByRole('radio', { name: 'Japan' }).click();
		await page.getByRole('button', { name: 'Update country' }).click();

		await expect.element(page.getByRole('button', { name: 'Updating…' })).toBeDisabled();
		expect(fetchMock).toHaveBeenCalledOnce();
		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect((request.body as FormData).get('country')).toBe('JP');
		expect((request.body as FormData).get('returnTo')).toBe('/products/society-tee?size=m');

		resolveFetch!(new Response(null, { status: 200 }));

		await expect.element(page.getByRole('status')).toHaveTextContent('Prices updated for Japan.');
		expect(invalidate).toHaveBeenCalledWith('app:pricing-destination');
		expect((document.querySelector('dialog') as HTMLDialogElement).open).toBe(false);
	});

	it('keeps the dialog retryable and shows an alert for a non-OK response', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
		renderPicker();
		await page.getByRole('button', { name: 'Choose delivery country, currently Sweden' }).click();
		await page.getByRole('button', { name: 'Update country' }).click();

		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('We couldn’t update your delivery country. Please try again.');
		await expect.element(page.getByRole('dialog')).toBeVisible();
		await expect.element(page.getByRole('button', { name: 'Update country' })).toBeEnabled();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it('keeps the dialog retryable and shows an alert for a rejected request', async () => {
		fetchMock.mockRejectedValue(new Error('network unavailable'));
		renderPicker();
		await page.getByRole('button', { name: 'Choose delivery country, currently Sweden' }).click();
		await page.getByRole('button', { name: 'Update country' }).click();

		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('We couldn’t update your delivery country. Please try again.');
		await expect.element(page.getByRole('dialog')).toBeVisible();
		await expect.element(page.getByRole('button', { name: 'Update country' })).toBeEnabled();
	});

	it('navigates to the server-derived return path when pricing invalidation fails', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		invalidate.mockRejectedValue(new Error('invalidation unavailable'));
		goto.mockResolvedValue(undefined);
		renderPicker();
		await page.getByRole('button', { name: 'Choose delivery country, currently Sweden' }).click();
		await page.getByRole('button', { name: 'Update country' }).click();

		await vi.waitFor(() =>
			expect(goto).toHaveBeenCalledWith('/products/society-tee?size=m', { invalidateAll: true })
		);
		expect(invalidate).toHaveBeenCalledWith('app:pricing-destination');
	});
});
