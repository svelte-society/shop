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
import {
	ASIA_DESTINATIONS,
	EU_DESTINATIONS,
	UK_DESTINATIONS,
	type MarketDestination
} from './destinations';

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
		['DE', 2_380, 1_000, 3_380],
		['FI', 2_510, 1_000, 3_510],
		['HU', 2_540, 1_000, 3_540],
		['GB', 2_000, 1_000, 3_000],
		['JP', 2_000, 1_000, 3_000]
	] as const)('projects %s with integer cents', (country, merchandise, shipping, total) => {
		const destination = pricingDestination(country);
		expect(displayPriceForDestination(2_000, destination).grossCents).toBe(merchandise);
		expect(
			displayCartPrice([{ netUnitCents: 2_000, quantity: 1 }], destination, 1_000)
		).toMatchObject({
			shipping: { grossCents: shipping },
			totalGrossCents: total
		});
	});

	it.each([...EU_DESTINATIONS, ...UK_DESTINATIONS, ...ASIA_DESTINATIONS])(
		'keeps the paid shipping gross fixed at €10 for %s',
		(country) => {
			expect(
				displayCartPrice([{ netUnitCents: 2_000, quantity: 1 }], pricingDestination(country), 1_000)
					.shipping.grossCents
			).toBe(1_000);
		}
	);

	it.each([
		['SE', 800, 200],
		['DE', 840, 160],
		['FI', 797, 203],
		['HU', 787, 213],
		['GB', 1_000, 0],
		['JP', 1_000, 0]
	] as const)('backs included shipping VAT out of the fixed gross for %s', (country, net, vat) => {
		expect(
			displayCartPrice([{ netUnitCents: 2_000, quantity: 1 }], pricingDestination(country), 1_000)
				.shipping
		).toEqual({ netCents: net, vatCents: vat, grossCents: 1_000 });
	});

	it('keeps shipping free for two units', () => {
		expect(
			displayCartPrice([{ netUnitCents: 2_000, quantity: 2 }], pricingDestination('FI'), 1_000)
		).toMatchObject({ shipping: { netCents: 0, vatCents: 0, grossCents: 0 } });
	});

	it('uses the trusted paid shipping amount supplied by the server', () => {
		expect(
			displayCartPrice([{ netUnitCents: 2_347, quantity: 1 }], pricingDestination('DE'), 1_000)
		).toMatchObject({
			shipping: { netCents: 840, vatCents: 160, grossCents: 1_000 },
			totalNetCents: 3_187,
			totalVatCents: 606,
			totalGrossCents: 3_793
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
				displayCartPrice([{ netUnitCents: 2_000, quantity }], pricingDestination('SE'), 1_000)
			).toThrowError('INVALID_CENTS');
		}
	);

	it('rejects cart merchandise that exceeds safe integer cents', () => {
		expect(() =>
			displayCartPrice(
				[{ netUnitCents: Number.MAX_SAFE_INTEGER, quantity: 2 }],
				pricingDestination('JP'),
				1_000
			)
		).toThrowError('INVALID_CENTS');
	});

	it('projects EU, UK, and Asia destination metadata', () => {
		expect(pricingDestination('SE')).toMatchObject({
			countryCode: 'SE',
			displayName: 'Sweden',
			region: 'eu',
			vatBasisPoints: 2_500,
			requiresImportChargeCopy: false
		});
		expect(pricingDestination('GB')).toMatchObject({
			countryCode: 'GB',
			displayName: 'United Kingdom',
			region: 'uk',
			vatBasisPoints: 0,
			requiresImportChargeCopy: true
		});
		expect(pricingDestination('JP')).toMatchObject({
			countryCode: 'JP',
			displayName: 'Japan',
			region: 'asia',
			vatBasisPoints: 0,
			requiresImportChargeCopy: true
		});
	});

	it('discloses Swedish VAT and non-EU import charges exactly', () => {
		expect(pricingDisclosure(pricingDestination('SE'))).toBe(
			'Includes 25% Sweden VAT. Exact tax is confirmed from your delivery address at checkout.'
		);
		expect(pricingDisclosure(pricingDestination('GB'))).toBe(
			'EU VAT excluded. Import VAT, duties, brokerage, or carrier fees may be charged on arrival.'
		);
		expect(pricingDisclosure(pricingDestination('JP'))).toBe(
			'EU VAT excluded. Import VAT, duties, brokerage, or carrier fees may be charged on arrival.'
		);
	});
});
