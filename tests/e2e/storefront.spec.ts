import { expect, test } from '@playwright/test';

const CATALOG_UNAVAILABLE_ORIGIN = 'http://127.0.0.1:4274';
const STOREFRONT_DISABLED_ORIGIN = 'http://127.0.0.1:4275';

test('homepage presents the approved responsive collection journey', async ({ page }) => {
	await page.goto('/');

	await expect(page).toHaveTitle('Svelte Society Shop — Official Community Merch');
	const collectionHeading = page.getByRole('heading', { level: 1, name: 'Shop the collection.' });
	const firstProductImage = page.getByRole('img', { name: 'Community Tee' });
	const missionHeading = page.getByRole('heading', {
		level: 2,
		name: 'Wear Svelte. Support the community.'
	});
	await expect(collectionHeading).toBeVisible();
	await expect(firstProductImage).toBeVisible();
	await expect(missionHeading).toBeVisible();
	const [collectionBox, productBox, missionBox] = await Promise.all([
		collectionHeading.boundingBox(),
		firstProductImage.boundingBox(),
		missionHeading.boundingBox()
	]);
	expect(collectionBox).not.toBeNull();
	expect(productBox).not.toBeNull();
	expect(missionBox).not.toBeNull();
	expect(productBox?.y ?? 0).toBeGreaterThan(collectionBox?.y ?? 0);
	expect(productBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(page.viewportSize()?.height ?? 0);
	expect(missionBox?.y ?? 0).toBeGreaterThan((productBox?.y ?? 0) + (productBox?.height ?? 0));
	await expect(
		page.getByText('Every purchase supports Svelte Society.', { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole('heading', { level: 2, name: 'Your purchase supports' })
	).toBeVisible();
	for (const supportedWork of [
		'Community events',
		'Shared resources',
		'Open-source projects',
		'Developer connections'
	]) {
		await expect(page.getByText(supportedWork, { exact: true })).toBeVisible();
	}
	await expect(page.getByText(/€11\.71 for one item/)).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: 'Apparel' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: 'Accessories' })).toBeVisible();
	const destinationTrigger = page.getByRole('button', {
		name: 'Choose delivery country, currently Sweden'
	});
	await expect(destinationTrigger).toBeVisible();
	await expect(destinationTrigger).toHaveAttribute('title', 'Deliver to Sweden');
	await expect(destinationTrigger).toContainText('🇸🇪');
	await expect(page.getByRole('heading', { level: 3, name: 'Shipping' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: 'Regions' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: 'Support' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 3, name: 'Tax' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: /Community Tee/ }).first()).toHaveAttribute(
		'href',
		'/products/community-tee'
	);
	await expect(page.getByRole('link', { name: /Society Mug/ }).first()).toHaveAttribute(
		'href',
		'/products/society-mug'
	);
	await expect(page.locator('body')).not.toContainText(/Styria/i);

	const hasHorizontalOverflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth
	);
	expect(hasHorizontalOverflow).toBe(false);
});

test('homepage quick add selects apparel, adds an accessory, and persists the cart', async ({
	page
}) => {
	await page.goto('/');
	const teeCard = page.getByRole('article').filter({ hasText: 'Community Tee' });
	const mugCard = page.getByRole('article').filter({ hasText: 'Society Mug' });

	await teeCard.getByRole('button', { name: 'Add to cart' }).click();
	await page
		.getByRole('group', { name: 'Choose a size for Community Tee' })
		.getByRole('button', { name: 'M', exact: true })
		.click();

	await expect(page).toHaveURL(/\/$/);
	await expect(teeCard.getByRole('status', { name: 'Cart status' })).toHaveText(
		'Community Tee, M added to cart.'
	);
	await expect(page.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();

	await page.reload();
	await expect(page.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();
	await mugCard.getByRole('button', { name: 'Add to cart' }).click();

	await expect(page.getByRole('group', { name: 'Choose a size for Society Mug' })).toHaveCount(0);
	await expect(mugCard.getByRole('status', { name: 'Cart status' })).toHaveText(
		'Society Mug, One size added to cart.'
	);
	await expect(page.getByRole('link', { name: 'Cart, 2 items' })).toBeVisible();
});

for (const viewport of [
	{ name: 'desktop', width: 1280, height: 800 },
	{ name: 'mobile', width: 390, height: 844 }
] as const) {
	test(`header remains visible while scrolling on ${viewport.name}`, async ({ page }) => {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await page.goto('/');
		const header = page.locator('.site-header');

		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		await expect.poll(async () => (await header.boundingBox())?.y).toBe(0);
		await expect(header).toBeVisible();
	});
}

test('mobile header keeps the brand and primary navigation on one row', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await page.goto('/');

	const brandBox = await page.getByRole('link', { name: 'Society Shop home' }).boundingBox();
	const navigationBox = await page
		.getByRole('navigation', { name: 'Primary navigation' })
		.boundingBox();

	expect(brandBox).not.toBeNull();
	expect(navigationBox).not.toBeNull();
	expect(Math.abs((brandBox?.y ?? 0) - (navigationBox?.y ?? 0))).toBeLessThanOrEqual(2);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('country picker keeps its actions visible while only the country list scrolls', async ({
	page
}) => {
	await page.goto('/');
	await expect(page.getByRole('link', { name: 'Svelte Society' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Choose delivery country, currently Sweden' }).click();

	const dialog = page.getByRole('dialog');
	const countryList = dialog.locator('.destination-groups');
	const actions = dialog.locator('.dialog-actions');
	await expect(dialog).toBeVisible();
	await expect(actions.getByRole('button', { name: 'Cancel' })).toBeVisible();
	await expect(actions.getByRole('button', { name: 'Update country' })).toBeVisible();
	expect(await countryList.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
		true
	);

	const actionBoxBefore = await actions.boundingBox();
	await countryList.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	const actionBoxAfter = await actions.boundingBox();

	expect(actionBoxBefore).not.toBeNull();
	expect(actionBoxAfter).not.toBeNull();
	expect(actionBoxAfter?.y).toBe(actionBoxBefore?.y);
	expect((actionBoxAfter?.y ?? 0) + (actionBoxAfter?.height ?? 0)).toBeLessThanOrEqual(
		page.viewportSize()?.height ?? 0
	);
});

test('mobile country dialog focuses its search field without undersizing it', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await page.goto('/');
	await page.getByRole('button', { name: 'Choose delivery country, currently Sweden' }).click();

	const search = page.getByRole('searchbox', { name: 'Search delivery countries' });
	await expect(page.getByRole('dialog')).toBeVisible();
	await expect(search).toBeFocused();
	expect(
		Number.parseFloat(await search.evaluate((element) => getComputedStyle(element).fontSize))
	).toBeGreaterThanOrEqual(16);
});

test('apparel requires a size before adding the selected variant', async ({ page }) => {
	await page.goto('/products/community-tee');

	await expect(page.getByRole('heading', { level: 1, name: 'Community Tee' })).toBeVisible();
	await expect(page.getByRole('status', { name: 'Variant status' })).toHaveText(
		'Choose a size to continue.'
	);
	await page.getByRole('button', { name: 'Add to cart' }).click();
	await expect(page.getByRole('alert')).toHaveText('Choose a size before adding to cart.');

	await page
		.getByRole('radiogroup', { name: 'Choose a size' })
		.getByText('M', { exact: true })
		.click();
	await page.getByRole('button', { name: 'Add to cart' }).click();
	await expect(page.getByRole('status', { name: 'Cart status' })).toHaveText(
		'Community Tee, M added to cart.'
	);
	await expect(page.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();
});

test('three-size product guide fits the mobile viewport without horizontal overflow', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await page.goto('/products/community-tee');

	const sizeGuide = page.locator('.size-guide');
	const tableWrap = sizeGuide.locator('.table-wrap');
	await expect(sizeGuide).toBeVisible();

	const layout = await tableWrap.evaluate((element) => ({
		documentWidth: document.documentElement.scrollWidth,
		viewportWidth: window.innerWidth,
		visibleWidth: element.clientWidth,
		contentWidth: element.scrollWidth
	}));

	expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
	expect(layout.contentWidth).toBeLessThanOrEqual(layout.visibleWidth);
});

test('single-variant accessory is ready to add without a redundant selector', async ({ page }) => {
	await page.goto('/products/society-mug');

	await expect(page.getByRole('heading', { level: 1, name: 'Society Mug' })).toBeVisible();
	await expect(page.getByRole('radiogroup')).toHaveCount(0);
	await expect(page.getByRole('status', { name: 'Variant status' })).toHaveText(
		'One size selected.'
	);

	await page.getByRole('button', { name: 'Add to cart' }).click();
	await expect(page.getByRole('status', { name: 'Cart status' })).toHaveText(
		'Society Mug, One size added to cart.'
	);
	await expect(page.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();
});

test('catalog outage shows the approved recoverable failure state', async ({ page }) => {
	await page.goto(CATALOG_UNAVAILABLE_ORIGIN);

	await expect(
		page.getByRole('heading', { level: 2, name: 'Collection temporarily unavailable.' })
	).toBeVisible();
	await expect(page.getByText('Your cart is safe. Try again shortly.')).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test('disabled storefront stops commerce before private catalog work', async ({ page }) => {
	await page.goto(`${STOREFRONT_DISABLED_ORIGIN}/products/community-tee`);

	await expect(page).toHaveURL(`${STOREFRONT_DISABLED_ORIGIN}/`);
	await expect(
		page.getByRole('heading', { level: 1, name: 'The collection is getting ready.' })
	).toBeVisible();
	await expect(page.getByRole('link', { name: 'Visit Svelte Society' })).toBeVisible();
});

test('disabled storefront keeps every information page and footer destination available', async ({
	page
}) => {
	const pages = [
		['/shipping', 'Shipping'],
		['/returns', 'Returns and withdrawal'],
		['/privacy', 'Privacy'],
		['/terms', 'Terms of sale'],
		['/about', 'About the Shop']
	] as const;

	for (const [path, heading] of pages) {
		await page.goto(`${STOREFRONT_DISABLED_ORIGIN}${path}`);

		await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
		await expect(page.getByText('The collection is getting ready.')).toHaveCount(0);
		await expect(page.locator('body')).not.toContainText(/Styria/i);
		const footer = page.locator('footer');
		for (const [destination, label] of [
			['/shipping', 'Shipping'],
			['/returns', 'Returns'],
			['/privacy', 'Privacy'],
			['/terms', 'Terms'],
			['/about', 'About']
		] as const) {
			await expect(footer.getByRole('link', { name: label, exact: true })).toHaveAttribute(
				'href',
				destination
			);
		}
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
		).toBe(false);
	}
});
