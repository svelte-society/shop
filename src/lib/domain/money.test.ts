import { describe, expect, it } from 'vitest';
import { formatEur, swedishReferenceGrossCents } from './money';

describe('swedishReferenceGrossCents', () => {
	it('converts the EUR 20 net reference price to EUR 25 gross', () => {
		expect(swedishReferenceGrossCents(2_000)).toBe(2_500);
	});

	it('calculates a large safe gross value without losing integer precision', () => {
		expect(swedishReferenceGrossCents(7_205_759_403_792_791)).toBe(9_007_199_254_740_989);
	});

	it('rejects a gross result outside safe integer cents', () => {
		expect(() => swedishReferenceGrossCents(7_205_759_403_792_794)).toThrowError('INVALID_CENTS');
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid integer cents %s', (cents) => {
		expect(() => swedishReferenceGrossCents(cents)).toThrowError('INVALID_CENTS');
	});
});

describe('formatEur', () => {
	it('formats integer cents as EUR for the requested locale', () => {
		expect(formatEur(2_000, 'en-IE')).toBe('€20.00');
	});

	it('preserves the final cent when formatting a high safe integer value', () => {
		expect(formatEur(9_000_000_000_000_001, 'en-IE')).toBe('€90,000,000,000,000.01');
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid integer cents %s', (cents) => {
		expect(() => formatEur(cents, 'en-IE')).toThrowError('INVALID_CENTS');
	});
});
