import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import AnnouncementStrip from './AnnouncementStrip.svelte';

describe('AnnouncementStrip', () => {
	it('states the shop purpose without repeating the shipping promotion', async () => {
		render(AnnouncementStrip);

		await expect
			.element(page.getByText('Every purchase supports Svelte Society.', { exact: true }))
			.toBeVisible();
		expect(page.getByText('Free shipping when you pick two.', { exact: true }).query()).toBeNull();
	});
});
