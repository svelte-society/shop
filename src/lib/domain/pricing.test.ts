import { describe, expect, it } from 'vitest';
import {
	displayCartPrice,
	displayPriceForDestination,
	pricingDisclosure,
	pricingDestination,
	pricePublicProduct,
	VAT_TABLE_REVIEWED_AT
} from './pricing';
import type { PublicCatalogProduct } from './catalog';
import type { MarketDestination } from './destinations';

const product: PublicCatalogProduct = {
	slug: 'community-tee',
	name: 'Community Tee',
	description: 'A community tee.',
	images: ['https://cdn.example.com/tee.png'],
	sortOrder: 1,
	category: 'apparel',
	materials: 'Cotton',
	care: 'Wash at 30°C',
	fit: null,
	sizeGuideUrl: null,
	sizeChart: null,
	variants: [
		{ priceId: 'price_tee', label: 'M', sortOrder: 1, currency: 'eur', unitAmountCents: 2_000 }
	]
};

describe('destination pricing', () => {
	it('projects public catalog variants through the selected destination', () => {
		expect(
			pricePublicProduct(product, pricingDestination('DE')).variants[0].displayPrice
		).toMatchObject({
			netCents: 2_000,
			vatCents: 380,
			grossCents: 2_380
		});
	});
	it.each([
		['SE', 2_500, 1_000, 3_500],
		['DE', 2_380, 952, 3_332],
		['FI', 2_510, 1_004, 3_514],
		['HU', 2_540, 1_016, 3_556],
		['JP', 2_000, 800, 2_800]
	] as const)('projects %s with integer cents', (country, merchandise, shipping, total) => {
		const destination = pricingDestination(country);
		expect(displayPriceForDestination(2_000, destination).grossCents).toBe(merchandise);
		expect(
			displayCartPrice([{ netUnitCents: 2_000, quantity: 1 }], destination, 800)
		).toMatchObject({
			shipping: { grossCents: shipping },
			totalGrossCents: total
		});
	});

	it('keeps shipping free for two units', () => {
		expect(
			displayCartPrice([{ netUnitCents: 2_000, quantity: 2 }], pricingDestination('FI'), 937)
		).toMatchObject({ shipping: { netCents: 0, vatCents: 0, grossCents: 0 } });
	});

	it('uses the trusted paid shipping amount supplied by the server', () => {
		expect(
			displayCartPrice([{ netUnitCents: 2_347, quantity: 1 }], pricingDestination('DE'), 937)
		).toMatchObject({
			shipping: { netCents: 937, vatCents: 178, grossCents: 1_115 },
			totalNetCents: 3_284,
			totalVatCents: 624,
			totalGrossCents: 3_908
		});
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER])('rejects unsafe cents %s', (cents) => {
		expect(() => displayPriceForDestination(cents, pricingDestination('SE'))).toThrowError(
			'INVALID_CENTS'
		);
	});

	it('records the VAT review date', () => expect(VAT_TABLE_REVIEWED_AT).toBe('2026-07-22'));

	it('rejects market countries outside the supported pricing regions', () => {
		expect(() => pricingDestination('US' as unknown as MarketDestination)).toThrowError(
			'PRICING_DESTINATION_INVALID'
		);
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid cart quantity %s',
		(quantity) => {
			expect(() =>
				displayCartPrice([{ netUnitCents: 2_000, quantity }], pricingDestination('SE'), 937)
			).toThrowError('INVALID_CENTS');
		}
	);

	it('rejects cart merchandise that exceeds safe integer cents', () => {
		expect(() =>
			displayCartPrice(
				[{ netUnitCents: Number.MAX_SAFE_INTEGER, quantity: 2 }],
				pricingDestination('JP'),
				937
			)
		).toThrowError('INVALID_CENTS');
	});

	it('projects EU and Asia destination metadata', () => {
		expect(pricingDestination('SE')).toMatchObject({
			countryCode: 'SE',
			displayName: 'Sweden',
			region: 'eu',
			vatBasisPoints: 2_500,
			requiresImportChargeCopy: false
		});
		expect(pricingDestination('JP')).toMatchObject({
			countryCode: 'JP',
			displayName: 'Japan',
			region: 'asia',
			vatBasisPoints: 0,
			requiresImportChargeCopy: true
		});
	});

	it('discloses Swedish VAT and Japanese import charges exactly', () => {
		expect(pricingDisclosure(pricingDestination('SE'))).toBe(
			'Includes 25% Sweden VAT. Exact tax is confirmed from your delivery address at checkout.'
		);
		expect(pricingDisclosure(pricingDestination('JP'))).toBe(
			'EU VAT excluded. Import VAT, duties, brokerage, or carrier fees may be charged on arrival.'
		);
	});
});
