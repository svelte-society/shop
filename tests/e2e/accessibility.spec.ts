import { expect, test, type Locator, type Page } from '@playwright/test';

async function expectAtLeast44Pixels(locator: Locator): Promise<void> {
	const box = await locator.boundingBox();
	expect(box, 'control must have a rendered box').not.toBeNull();
	expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}

async function addMug(page: Page): Promise<void> {
	await page.goto('/products/society-mug');
	await expect(page.getByRole('status', { name: 'Variant status' })).toHaveText(
		'One size selected.'
	);
	await page.getByRole('button', { name: 'Add to cart' }).click();
	await expect(page.getByRole('status', { name: 'Cart status' })).toContainText('added to cart');
}

test('keyboard users reach a visible skip link and the main content', async ({ page }) => {
	await page.goto('/');
	await page.keyboard.press('Tab');

	const skipLink = page.getByRole('link', { name: 'Skip to content' });
	await expect(skipLink).toBeFocused();
	const focusStyle = await skipLink.evaluate((element) => {
		const style = getComputedStyle(element);
		return { boxShadow: style.boxShadow, transform: style.transform };
	});
	expect(focusStyle.boxShadow).not.toBe('none');
	await expect
		.poll(async () => (await skipLink.boundingBox())?.y ?? Number.NEGATIVE_INFINITY)
		.toBeGreaterThanOrEqual(0);

	await page.keyboard.press('Enter');
	await expect(page.locator('#main-content')).toBeFocused();
});

test('keyboard variant selection announces the selected apparel size', async ({ page }) => {
	await page.goto('/products/community-tee');
	const small = page.getByRole('radio', { name: 'S' });
	const medium = page.getByRole('radio', { name: 'M' });

	await expect(page.getByRole('status', { name: 'Variant status' })).toHaveText(
		'Choose a size to continue.'
	);
	await small.focus();
	await page.keyboard.press('ArrowRight');
	await expect(medium).toBeChecked();
	await expect(page.getByRole('status', { name: 'Variant status' })).toHaveText('M selected.');

	await page.getByRole('button', { name: 'Add to cart' }).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('status', { name: 'Cart status' })).toHaveText(
		'Community Tee, M added to cart.'
	);
});

test('cart threshold is exposed as a polite live region', async ({ page }) => {
	await addMug(page);
	await page.goto('/cart');

	const shippingStatus = page.getByText('Add one more item for free shipping.');
	await expect(shippingStatus).toHaveAttribute('aria-live', 'polite');
	await page.getByLabel('Quantity').fill('2');
	await page.getByLabel('Quantity').press('Tab');
	await expect(page.getByText('Free shipping unlocked.')).toHaveAttribute('aria-live', 'polite');
});

test('reduced-motion preference collapses storefront transitions', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/');

	const durations = await page
		.getByRole('link', { name: 'Shop the collection' })
		.first()
		.evaluate((element) => {
			const style = getComputedStyle(element);
			return `${style.transitionDuration},${style.animationDuration}`.split(',').map((duration) => {
				const value = Number.parseFloat(duration);
				return duration.trim().endsWith('ms') ? value : value * 1000;
			});
		});

	expect(Math.max(...durations)).toBeLessThanOrEqual(0.01);
});

test('primary actions and purchase controls meet the 44px target', async ({ page }) => {
	await page.goto('/');
	await expectAtLeast44Pixels(page.getByRole('link', { name: 'Shop the collection' }).first());
	await page.waitForLoadState('networkidle');

	await page.goto('/products/community-tee');
	await expectAtLeast44Pixels(page.getByRole('button', { name: 'Add to cart' }));
	await expectAtLeast44Pixels(
		page.getByRole('radiogroup', { name: 'Choose a size' }).getByText('S', { exact: true })
	);

	await addMug(page);
	await page.goto('/cart');
	await expectAtLeast44Pixels(page.getByLabel('Quantity'));
	await expectAtLeast44Pixels(page.getByRole('button', { name: 'Remove Society Mug, One size' }));
	await expectAtLeast44Pixels(page.getByRole('button', { name: 'Checkout opens soon' }));
});
