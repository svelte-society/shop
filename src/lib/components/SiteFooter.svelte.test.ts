import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SiteFooter from './SiteFooter.svelte';

describe('SiteFooter', () => {
	it('links directly to the primary online withdrawal function', async () => {
		const screen = render(SiteFooter);
		await expect
			.element(screen.getByRole('link', { name: 'Withdraw from purchase' }))
			.toHaveAttribute('href', '/withdraw');
	});
});
