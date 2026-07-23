import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import CartSummary from './CartSummary.svelte';
import type { PricingDestination } from '$lib/domain/pricing';
import { displayCartPrice, pricingDestination } from '$lib/domain/pricing';

const germanCart = {
	merchandise: { netCents: 2_000, vatCents: 380, grossCents: 2_380 },
	shipping: { netCents: 800, vatCents: 152, grossCents: 952 },
	totalNetCents: 2_800,
	totalVatCents: 532,
	totalGrossCents: 3_332
};
const germanDestination: PricingDestination = {
	countryCode: 'DE',
	displayName: 'Germany',
	region: 'eu' as const,
	vatBasisPoints: 1900,
	requiresImportChargeCopy: false
};

describe('CartSummary checkout action', () => {
	it('invokes checkout only while the public flag is enabled', async () => {
		let enabledClicks = 0;
		render(CartSummary, {
			totalUnits: 1,
			cartDisplayPrice: germanCart,
			destination: germanDestination,
			checkoutEnabled: true,
			onCheckout: () => {
				enabledClicks += 1;
			}
		});

		await page.getByRole('button', { name: 'Continue to secure checkout' }).click();
		await expect.element(page.getByText('Merchandise')).toBeVisible();
		await expect
			.element(
				page.getByText(
					'Estimated for delivery to Germany. Your delivery address confirms VAT and the final total at checkout.'
				)
			)
			.toBeVisible();
		expect(document.body.textContent).not.toContain('Exact tax is confirmed');
		await expect.element(page.getByText('€23.80')).toBeVisible();
		await expect.element(page.getByText('€9.52')).toBeVisible();
		await expect.element(page.getByText('€5.32')).toBeVisible();
		await expect.element(page.getByText('€33.32')).toBeVisible();

		expect(enabledClicks).toBe(1);

		const disabledClicks: string[] = [];
		render(CartSummary, {
			totalUnits: 1,
			cartDisplayPrice: germanCart,
			destination: germanDestination,
			checkoutEnabled: false,
			onCheckout: () => {
				disabledClicks.push('clicked');
			}
		});

		await expect.element(page.getByRole('button', { name: 'Checkout opens soon' })).toBeDisabled();
		expect(disabledClicks).toEqual([]);
	});

	it('disables duplicate submission while pending and announces failure next to the action', async () => {
		render(CartSummary, {
			totalUnits: 2,
			cartDisplayPrice: germanCart,
			destination: germanDestination,
			checkoutEnabled: true,
			checkoutPending: true,
			checkoutError: 'Checkout is temporarily unavailable. Your cart is safe. Try again shortly.',
			onCheckout: () => undefined
		});

		await expect
			.element(page.getByRole('button', { name: 'Opening secure checkout…' }))
			.toBeDisabled();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent(
				'Checkout is temporarily unavailable. Your cart is safe. Try again shortly.'
			);

		const summary = page.getByRole('complementary', { name: 'Order summary' }).element();
		const button = summary.querySelector('button');
		const alert = summary.querySelector('[role="alert"]');
		expect(button?.nextElementSibling).toBe(alert);
	});

	it('shows free shipping for two German units', async () => {
		const destination = pricingDestination('DE');
		render(CartSummary, {
			totalUnits: 2,
			cartDisplayPrice: displayCartPrice([{ netUnitCents: 2_000, quantity: 2 }], destination, 937),
			destination,
			checkoutEnabled: true
		});

		const shippingRow = page.getByText('Shipping', { exact: true }).element().parentElement;
		expect(shippingRow?.textContent).toBe('Shipping€0.00');
		const totalRow = page.getByText('Estimated total', { exact: true }).element().parentElement;
		expect(totalRow?.textContent).toBe('Estimated total€47.60');
	});
});
