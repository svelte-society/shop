import { expect, test } from '@playwright/test';

const withdrawalOrigin = 'http://127.0.0.1:4277';

test('JavaScript-disabled whole or one-item notice can review, confirm, and download its signed receipt', async ({
	browser
}, testInfo) => {
	const partial =
		testInfo.project.name === 'chromium-768' || testInfo.project.name === 'webkit-1440';
	const context = await browser.newContext({ javaScriptEnabled: false });
	const page = await context.newPage();
	await page.goto(`${withdrawalOrigin}/withdraw`);
	await page.getByLabel('Full name').fill('Ada Lovelace');
	await page.getByLabel('Receipt email').fill('ada@example.test');
	await page.getByLabel('Order reference').fill(`ORDER-${testInfo.project.name}`);
	if (partial) {
		await page.getByLabel('Specific items').check();
		await page.getByLabel('Item description 1', { exact: true }).fill('Community Tee');
		await page.getByLabel('Quantity 1', { exact: true }).fill('1');
	}
	await page.getByRole('button', { name: 'Review withdrawal notice' }).click();
	await expect(page.getByRole('heading', { name: 'Review and confirm' })).toBeVisible();
	await expect(
		page.getByText(partial ? 'Specific items' : 'The whole purchase', { exact: true })
	).toBeVisible();
	await page.getByRole('button', { name: 'Confirm withdrawal from purchase' }).click();
	await expect(page.getByRole('heading', { name: 'Withdrawal notice received.' })).toBeVisible();
	await expect(
		page.getByText('Your receipt email is queued. You can download it now.')
	).toBeVisible();
	await expect(page.getByText(/^WDR-/u)).toBeVisible();
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('link', { name: 'Download withdrawal receipt' }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toMatch(/^WDR-[A-Za-z0-9_-]{22}-withdrawal-receipt\.txt$/u);
	await context.close();
});

test('enhancement preserves multiple items and moves validation focus to the error summary', async ({
	page
}) => {
	await page.goto(`${withdrawalOrigin}/withdraw`);
	await page.getByLabel('Specific items').check();
	await page.getByLabel('Item description 1', { exact: true }).fill('Community Tee');
	await page.getByRole('button', { name: 'Add another item' }).click();
	await expect(page.getByLabel('Item description 2', { exact: true })).toBeFocused();
	await page.getByLabel('Item description 2', { exact: true }).fill('Society Cap');
	await page.getByRole('button', { name: 'Review withdrawal notice' }).click();
	await expect(page.locator('#withdrawal-errors')).toBeFocused();
	await expect(page.getByRole('link', { name: 'Enter your full name.' })).toHaveAttribute(
		'href',
		'#fullName'
	);
	await expect(page.getByLabel('Item description 1', { exact: true })).toHaveValue('Community Tee');
	await expect(page.getByLabel('Item description 2', { exact: true })).toHaveValue('Society Cap');
});

test('footer and Returns page expose the online notice without replacing damaged-item support', async ({
	page
}) => {
	await page.goto(`${withdrawalOrigin}/`);
	await expect(page.getByRole('link', { name: 'Withdraw from purchase' })).toHaveAttribute(
		'href',
		'/withdraw'
	);
	await page.goto(`${withdrawalOrigin}/returns`);
	await expect(
		page.getByRole('link', { name: 'Submit a withdrawal notice' }).first()
	).toHaveAttribute('href', /\/withdraw$/u);
	await expect(page.getByRole('heading', { name: 'Damaged or incorrect item' })).toBeVisible();
});

test('withdrawal layout fits the configured viewport and respects reduced motion', async ({
	page
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto(`${withdrawalOrigin}/withdraw`);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
		)
	).toBe(true);
	await expect(page.getByRole('button', { name: 'Review withdrawal notice' })).toBeVisible();
});
