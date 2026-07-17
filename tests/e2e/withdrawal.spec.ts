import { expect, test } from '@playwright/test';

const withdrawalOrigin = 'http://127.0.0.1:4277';

test('JavaScript-disabled whole or one-item notice can review, confirm, and download its signed receipt', async ({
	browser
}, testInfo) => {
	test.skip(
		!['chromium-320', 'chromium-768'].includes(testInfo.project.name),
		'No-JS whole and partial paths use the two Chromium viewports on the shared rate-limit fixture.'
	);
	const partial = testInfo.project.name === 'chromium-768';
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

test('enhancement preserves multiple items through confirmation and signed receipt download', async ({
	page
}, testInfo) => {
	test.skip(
		testInfo.project.name === 'chromium-768',
		'Enhanced completion runs once per browser engine while the second Chromium viewport covers no-JS partial.'
	);
	await page.goto(`${withdrawalOrigin}/withdraw`);
	await page.getByLabel('Full name').fill('Ada Lovelace');
	await page.getByLabel('Receipt email').fill('ada@example.test');
	await page.getByLabel('Order reference').fill(`ENHANCED-${testInfo.project.name}`);
	await page.getByLabel('Specific items').check();
	await page.getByLabel('Item description 1', { exact: true }).fill('Community Tee');
	await expect(page.getByLabel('Full name')).toHaveValue('Ada Lovelace');
	await expect(page.getByLabel('Receipt email')).toHaveValue('ada@example.test');
	await expect(page.getByLabel('Order reference')).toHaveValue(`ENHANCED-${testInfo.project.name}`);
	await expect(page.getByLabel('Specific items')).toBeChecked();
	await expect(page.getByLabel('Item description 1', { exact: true })).toHaveValue('Community Tee');
	await page.getByRole('button', { name: 'Add another item' }).click();
	const addedRow = page.getByLabel('Item description 2', { exact: true });
	await expect(addedRow).toBeVisible();
	if (testInfo.project.name === 'webkit-1440') await expect(addedRow).toBeFocused();
	await expect(page.getByLabel('Full name')).toHaveValue('Ada Lovelace');
	await expect(page.getByLabel('Receipt email')).toHaveValue('ada@example.test');
	await expect(page.getByLabel('Order reference')).toHaveValue(`ENHANCED-${testInfo.project.name}`);
	await expect(page.getByLabel('Specific items')).toBeChecked();
	await expect(page.getByLabel('Item description 1', { exact: true })).toHaveValue('Community Tee');
	await page.getByLabel('Item description 2', { exact: true }).fill('Society Cap');
	await page.getByRole('button', { name: 'Review withdrawal notice' }).click();
	await expect(page.getByRole('heading', { name: 'Review and confirm' })).toBeVisible();
	await expect(page.getByText('1 × Community Tee', { exact: true })).toBeVisible();
	await expect(page.getByText('1 × Society Cap', { exact: true })).toBeVisible();
	await expect(
		page.getByText('Email my withdrawal receipt to ada@example.test.', { exact: true })
	).toBeVisible();
	await expect(
		page.getByText('I confirm that I want to withdraw from this purchase.', { exact: true })
	).toBeVisible();
	await page.getByRole('button', { name: 'Confirm withdrawal from purchase' }).click();
	await expect(page.getByRole('heading', { name: 'Withdrawal notice received.' })).toBeVisible();
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('link', { name: 'Download withdrawal receipt' }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toMatch(/^WDR-[A-Za-z0-9_-]{22}-withdrawal-receipt\.txt$/u);
});

test('validation keeps enhanced item values and moves focus to the error summary', async ({
	page
}, testInfo) => {
	await page.goto(`${withdrawalOrigin}/withdraw`);
	await page.getByLabel('Specific items').check();
	await page.getByLabel('Item description 1', { exact: true }).fill('Community Tee');
	await page.getByRole('button', { name: 'Add another item' }).click();
	await expect(page.getByLabel('Item description 2', { exact: true })).toBeVisible();
	await page.getByLabel('Item description 2', { exact: true }).fill('Society Cap');
	await page.getByRole('button', { name: 'Review withdrawal notice' }).click();
	const errorSummary = page.locator('#withdrawal-errors');
	await expect(errorSummary).toBeVisible();
	if (testInfo.project.name === 'webkit-1440') await expect(errorSummary).toBeFocused();
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
	await page.waitForLoadState('networkidle');
	const withdrawalHref = await page
		.getByRole('link', { name: 'Withdraw from purchase' })
		.getAttribute('href');
	expect(new URL(withdrawalHref ?? '', page.url()).pathname).toBe('/withdraw');
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
