import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import CartSummary from './CartSummary.svelte';

describe('CartSummary checkout action', () => {
	it('invokes checkout only while the public flag is enabled', async () => {
		let enabledClicks = 0;
		render(CartSummary, {
			totalUnits: 1,
			subtotalCents: 2_500,
			checkoutEnabled: true,
			onCheckout: () => {
				enabledClicks += 1;
			}
		});

		await page.getByRole('button', { name: 'Continue to secure checkout' }).click();
		await expect
			.element(page.getByText('Net subtotal (excl. VAT)'))
			.toBeVisible();
		await expect
			.element(
				page.getByText(
					/Prices and subtotal are shown net of VAT in EUR\. Destination VAT is confirmed from your delivery\s+and business details at checkout\./
				)
			)
			.toBeVisible();

		expect(enabledClicks).toBe(1);

		const disabledClicks: string[] = [];
		render(CartSummary, {
			totalUnits: 1,
			subtotalCents: 2_500,
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
			subtotalCents: 5_000,
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
});
