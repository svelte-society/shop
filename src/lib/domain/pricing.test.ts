import { describe, expect, it } from 'vitest';
import {
	displayCartPrice,
	displayPriceForDestination,
	pricingDestination,
	VAT_TABLE_REVIEWED_AT
} from './pricing';

describe('destination pricing', () => {
	it.each([
		['SE', 2_500, 1_000, 3_500],
		['DE', 2_380, 952, 3_332],
		['FI', 2_510, 1_004, 3_514],
		['HU', 2_540, 1_016, 3_556],
		['JP', 2_000, 800, 2_800]
	] as const)('projects %s with integer cents', (country, merchandise, shipping, total) => {
		const destination = pricingDestination(country);
		expect(displayPriceForDestination(2_000, destination).grossCents).toBe(merchandise);
		expect(displayCartPrice([{ netUnitCents: 2_000, quantity: 1 }], destination)).toMatchObject({
			shipping: { grossCents: shipping },
			totalGrossCents: total
		});
	});

	it('keeps shipping free for two units', () => {
		expect(
			displayCartPrice([{ netUnitCents: 2_000, quantity: 2 }], pricingDestination('FI'))
		).toMatchObject({ shipping: { netCents: 0, vatCents: 0, grossCents: 0 } });
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER])('rejects unsafe cents %s', (cents) => {
		expect(() => displayPriceForDestination(cents, pricingDestination('SE'))).toThrowError(
			'INVALID_CENTS'
		);
	});

	it('records the VAT review date', () => expect(VAT_TABLE_REVIEWED_AT).toBe('2026-07-22'));
});
