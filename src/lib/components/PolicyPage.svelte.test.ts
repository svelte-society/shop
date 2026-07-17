import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PolicyPage from './PolicyPage.svelte';

describe('PolicyPage', () => {
	it('renders a semantic, scannable document with familiar information navigation', async () => {
		const screen = render(PolicyPage, {
			document: {
				title: 'Shipping',
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
			.element(screen.getByRole('heading', { level: 2, name: 'Where we ship' }))
			.toBeVisible();
		await expect.element(screen.getByText('Effective 2026-07-17')).toBeVisible();
		await expect
			.element(screen.getByRole('navigation', { name: 'Information pages' }))
			.toBeVisible();
		for (const name of ['Shipping', 'Returns', 'Privacy', 'Terms', 'About']) {
			await expect.element(screen.getByRole('link', { name, exact: true })).toBeVisible();
		}
		await expect
			.element(screen.getByRole('link', { name: 'Email support' }))
			.toHaveAttribute('href', 'mailto:merch@sveltesociety.dev');
	});
});
