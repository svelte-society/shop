import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PolicyPage from './PolicyPage.svelte';

describe('PolicyPage', () => {
	it('renders a semantic, scannable document with familiar information navigation', async () => {
		const screen = render(PolicyPage, {
			document: {
				title: 'Shipping',
				summary: 'Where we deliver, what shipping costs, and when to expect your order.',
				effectiveDate: '2026-07-17',
				sections: [
					{
						heading: 'Where we ship',
						paragraphs: ['Configured destinations.'],
						links: [{ label: 'Email support', href: 'mailto:merch@sveltesociety.dev' }]
					}
				]
			}
		});

		await expect.element(screen.getByRole('main')).toBeVisible();
		await expect.element(screen.getByRole('article')).toBeVisible();
		await expect.element(screen.getByRole('heading', { level: 1, name: 'Shipping' })).toBeVisible();
		await expect
			.element(
				screen.getByText('Where we deliver, what shipping costs, and when to expect your order.')
			)
			.toBeVisible();
		await expect
			.element(screen.getByRole('heading', { level: 2, name: 'Where we ship' }))
			.toBeVisible();
		await expect.element(screen.getByText('Last updated 17 July 2026')).toBeVisible();
		await expect
			.element(screen.getByRole('navigation', { name: 'Information pages' }))
			.toBeVisible();
		for (const name of ['Shipping', 'Returns', 'Withdrawal form', 'Privacy', 'Terms', 'About']) {
			await expect.element(screen.getByRole('link', { name, exact: true })).toBeVisible();
		}
		await expect
			.element(screen.getByRole('link', { name: 'Email support' }))
			.toHaveAttribute('href', 'mailto:merch@sveltesociety.dev');
	});

	it('keeps non-policy information pages free of an effective date', async () => {
		const screen = render(PolicyPage, {
			document: {
				title: 'About the Shop',
				summary: 'Official Svelte Society merchandise, made for the community.',
				sections: [
					{
						heading: 'Made for Svelte people',
						paragraphs: ['Community shop information.']
					}
				]
			}
		});

		await expect
			.element(screen.getByText('Official Svelte Society merchandise, made for the community.'))
			.toBeVisible();
		expect(document.body.textContent).not.toContain('Effective');
		expect(document.body.textContent).not.toContain('Last updated');
	});
});
