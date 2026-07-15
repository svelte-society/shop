import { describe, expect, it } from 'vitest';
import { formatEur, swedishReferenceGrossCents } from './money';

describe('swedishReferenceGrossCents', () => {
	it('converts the EUR 20 net reference price to EUR 25 gross', () => {
		expect(swedishReferenceGrossCents(2_000)).toBe(2_500);
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid integer cents %s', (cents) => {
		expect(() => swedishReferenceGrossCents(cents)).toThrowError('INVALID_CENTS');
	});
});

describe('formatEur', () => {
	it('formats integer cents as EUR for the requested locale', () => {
		expect(formatEur(2_000, 'en-IE')).toBe('€20.00');
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid integer cents %s', (cents) => {
		expect(() => formatEur(cents, 'en-IE')).toThrowError('INVALID_CENTS');
	});
});
