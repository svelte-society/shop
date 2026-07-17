import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const track = vi.hoisted(() => vi.fn());

vi.mock('$lib/analytics/events', () => ({ track }));

import CancelPage from './+page.svelte';

describe('checkout cancellation page', () => {
	it('reports the checkout return once without checkout data', async () => {
		render(CancelPage);

		await expect.element(page.getByRole('heading', { level: 1 })).toBeVisible();
		await expect.poll(() => track.mock.calls).toEqual([['checkout_cancelled']]);
	});
});
