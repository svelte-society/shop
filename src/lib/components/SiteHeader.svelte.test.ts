import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { cart } from '$lib/stores/cart.svelte';
import SiteHeader from './SiteHeader.svelte';

const destination = {
	countryCode: 'SE' as const,
	displayName: 'Sweden',
	region: 'eu' as const,
	vatBasisPoints: 2500,
	requiresImportChargeCopy: false
};

const destinations = [
	{ countryCode: 'DE' as const, displayName: 'Germany', region: 'eu' as const },
	{ countryCode: 'SE' as const, displayName: 'Sweden', region: 'eu' as const },
	{ countryCode: 'JP' as const, displayName: 'Japan', region: 'asia' as const }
];

function renderHeader() {
	return render(SiteHeader, { destination, destinations, returnTo: '/' });
}

describe('SiteHeader', () => {
	beforeEach(() => cart.clear());
	afterEach(() => cart.clear());

	it('exposes only the shop primary destinations as labelled links', async () => {
		renderHeader();

		await expect
			.element(page.getByRole('link', { name: 'Society Shop home' }))
			.toHaveAttribute('href', '/');
		await expect
			.element(page.getByRole('link', { name: 'Collection' }))
			.toHaveAttribute('href', '/#collection');
		await expect
			.element(page.getByRole('link', { name: 'Svelte Society' }))
			.not.toBeInTheDocument();
		await expect
			.element(page.getByRole('link', { name: 'Cart, 0 items' }))
			.toHaveAttribute('href', '/cart');
	});

	it('keeps the accessible cart count in sync with cart behavior', async () => {
		renderHeader();

		await expect.element(page.getByRole('link', { name: 'Cart, 0 items' })).toHaveTextContent('0');

		cart.add('price_test_shirt', 2);

		await expect.element(page.getByRole('link', { name: 'Cart, 2 items' })).toHaveTextContent('2');

		cart.setQuantity('price_test_shirt', 1);

		await expect.element(page.getByRole('link', { name: 'Cart, 1 item' })).toHaveTextContent('1');
	});

	it('places the delivery country control before Cart in primary navigation order', async () => {
		renderHeader();

		const countryControl = page
			.getByRole('button', {
				name: 'Choose delivery country, currently Sweden'
			})
			.element();
		const cartLink = page.getByRole('link', { name: 'Cart, 0 items' }).element();
		expect(
			countryControl.compareDocumentPosition(cartLink) & Node.DOCUMENT_POSITION_FOLLOWING
		).not.toBe(0);
	});
});
