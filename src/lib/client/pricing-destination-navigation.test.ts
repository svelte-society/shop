import { describe, expect, it, vi } from 'vitest';
import { recoverPricingDestination } from './pricing-destination-navigation';

describe('recoverPricingDestination', () => {
	it('uses the safe relative location path when invalidation and client navigation both reject', async () => {
		const invalidate = vi.fn().mockRejectedValue(new Error('invalidation unavailable'));
		const goto = vi.fn().mockRejectedValue(new Error('navigation unavailable'));
		const assign = vi.fn();

		await recoverPricingDestination('/products/society-tee?size=m', { invalidate, goto, assign });

		expect(invalidate).toHaveBeenCalledWith('app:pricing-destination');
		expect(goto).toHaveBeenCalledWith('/products/society-tee?size=m', { invalidateAll: true });
		expect(assign).toHaveBeenCalledWith('/products/society-tee?size=m');
	});
});
