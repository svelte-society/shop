import { describe, expect, it } from 'vitest';
import { parseCart, selectShippingMode, totalUnits, type CartLine } from './cart';

describe('parseCart', () => {
	it.each([
		{ label: 'zero', quantity: 0 },
		{ label: 'negative', quantity: -1 },
		{ label: 'fractional', quantity: 1.5 }
	])('rejects a $label quantity', ({ quantity }) => {
		expect(() => parseCart([{ priceId: 'price_tee_m', quantity }])).toThrowError('CART_INVALID');
	});

	it('merges duplicate Price IDs', () => {
		expect(
			parseCart([
				{ priceId: 'price_tee_m', quantity: 1 },
				{ priceId: 'price_hat', quantity: 1 },
				{ priceId: 'price_tee_m', quantity: 2 }
			])
		).toEqual([
			{ priceId: 'price_tee_m', quantity: 3 },
			{ priceId: 'price_hat', quantity: 1 }
		]);
	});

	it('merges duplicate Price IDs before enforcing the distinct Price limit', () => {
		const input = Array.from({ length: 10 }, (_, index) => ({
			priceId: `price_${index}`,
			quantity: 1
		}));

		expect(parseCart([...input, { priceId: 'price_0', quantity: 1 }])).toHaveLength(10);
	});

	it('rejects 11 distinct Prices', () => {
		const input = Array.from({ length: 11 }, (_, index) => ({
			priceId: `price_${index}`,
			quantity: 1
		}));

		expect(() => parseCart(input)).toThrowError('CART_TOO_MANY_DISTINCT_PRICES');
	});

	it('rejects 21 total units', () => {
		expect(() => parseCart([{ priceId: 'price_tee_m', quantity: 21 }])).toThrowError(
			'CART_TOO_MANY_UNITS'
		);
	});
});

describe('cart totals and shipping', () => {
	it.each<{
		label: string;
		lines: CartLine[];
		expectedUnits: number;
		expectedMode: 'paid' | 'free';
	}>([
		{
			label: 'one unit',
			lines: [{ priceId: 'price_tee_m', quantity: 1 }],
			expectedUnits: 1,
			expectedMode: 'paid'
		},
		{
			label: 'two distinct variants',
			lines: [
				{ priceId: 'price_tee_m', quantity: 1 },
				{ priceId: 'price_hat', quantity: 1 }
			],
			expectedUnits: 2,
			expectedMode: 'free'
		},
		{
			label: 'two units of the same variant',
			lines: [{ priceId: 'price_tee_m', quantity: 2 }],
			expectedUnits: 2,
			expectedMode: 'free'
		}
	])('selects $expectedMode shipping for $label', ({ lines, expectedUnits, expectedMode }) => {
		expect(totalUnits(lines)).toBe(expectedUnits);
		expect(selectShippingMode(lines)).toBe(expectedMode);
	});
});
