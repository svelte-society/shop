import { ASIA_DESTINATIONS, EU_DESTINATIONS, type MarketDestination } from './destinations';
import type { PublicCatalogProduct, PublicCatalogVariant } from './catalog';

export const VAT_TABLE_REVIEWED_AT = '2026-07-22';
export const VAT_TABLE_SOURCE =
	'https://europa.eu/youreurope/business/finance-and-tax/vat/vat-rules-rates/index_en.htm';

export type DestinationRegion = 'eu' | 'asia';
export type PricingDestination = {
	countryCode: MarketDestination;
	displayName: string;
	region: DestinationRegion;
	vatBasisPoints: number;
	requiresImportChargeCopy: boolean;
};
export type DestinationOption = Pick<PricingDestination, 'countryCode' | 'displayName' | 'region'>;
export type DisplayPrice = { netCents: number; vatCents: number; grossCents: number };
export type CartDisplayPrice = {
	merchandise: DisplayPrice;
	shipping: DisplayPrice;
	totalNetCents: number;
	totalVatCents: number;
	totalGrossCents: number;
};
export type PricedPublicCatalogVariant = PublicCatalogVariant & { displayPrice: DisplayPrice };
export type PricedPublicCatalogProduct = Omit<PublicCatalogProduct, 'variants'> & {
	variants: PricedPublicCatalogVariant[];
};

const EU_VAT_BASIS_POINTS = Object.freeze({
	AT: 2000,
	BE: 2100,
	BG: 2000,
	HR: 2500,
	CY: 1900,
	CZ: 2100,
	DK: 2500,
	EE: 2400,
	FI: 2550,
	FR: 2000,
	DE: 1900,
	GR: 2400,
	HU: 2700,
	IE: 2300,
	IT: 2200,
	LV: 2100,
	LT: 2100,
	LU: 1700,
	MT: 1800,
	NL: 2100,
	PL: 2300,
	PT: 2300,
	RO: 2100,
	SK: 2300,
	ES: 2100,
	SE: 2500
} satisfies Record<(typeof EU_DESTINATIONS)[number], number>);

export function pricingDestination(countryCode: MarketDestination): PricingDestination {
	const eu = (EU_DESTINATIONS as readonly string[]).includes(countryCode);
	const asia = (ASIA_DESTINATIONS as readonly string[]).includes(countryCode);
	if (!eu && !asia) throw new Error('PRICING_DESTINATION_INVALID');
	const displayName = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode);
	if (!displayName) throw new Error('PRICING_DESTINATION_INVALID');
	return {
		countryCode,
		displayName,
		region: eu ? 'eu' : 'asia',
		vatBasisPoints: eu ? EU_VAT_BASIS_POINTS[countryCode as keyof typeof EU_VAT_BASIS_POINTS] : 0,
		requiresImportChargeCopy: !eu
	};
}

export function displayPriceForDestination(
	netCents: number,
	destination: PricingDestination
): DisplayPrice {
	if (!Number.isSafeInteger(netCents) || netCents < 0) throw new Error('INVALID_CENTS');
	const numerator = BigInt(netCents) * BigInt(10_000 + destination.vatBasisPoints);
	const gross = (numerator + 5_000n) / 10_000n;
	if (gross > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_CENTS');
	const grossCents = Number(gross);
	return { netCents, vatCents: grossCents - netCents, grossCents };
}

export function pricePublicProduct(
	product: PublicCatalogProduct,
	destination: PricingDestination
): PricedPublicCatalogProduct {
	return {
		...product,
		variants: product.variants.map((variant) => ({
			...variant,
			displayPrice: displayPriceForDestination(variant.unitAmountCents, destination)
		}))
	};
}

function safeCents(value: bigint): number {
	if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_CENTS');
	return Number(value);
}

export function displayCartPrice(
	lines: readonly { netUnitCents: number; quantity: number }[],
	destination: PricingDestination,
	paidShippingNetCents: number
): CartDisplayPrice {
	if (!Number.isSafeInteger(paidShippingNetCents) || paidShippingNetCents <= 0) {
		throw new Error('INVALID_CENTS');
	}
	let units = 0;
	let merchandiseNet = 0n;
	for (const line of lines) {
		if (
			!Number.isSafeInteger(line.netUnitCents) ||
			line.netUnitCents < 0 ||
			!Number.isSafeInteger(line.quantity) ||
			line.quantity < 1
		)
			throw new Error('INVALID_CENTS');
		units += line.quantity;
		if (!Number.isSafeInteger(units)) throw new Error('INVALID_CENTS');
		merchandiseNet += BigInt(line.netUnitCents) * BigInt(line.quantity);
	}
	const merchandise = displayPriceForDestination(safeCents(merchandiseNet), destination);
	const shipping = displayPriceForDestination(units === 1 ? paidShippingNetCents : 0, destination);
	return {
		merchandise,
		shipping,
		totalNetCents: safeCents(BigInt(merchandise.netCents) + BigInt(shipping.netCents)),
		totalVatCents: safeCents(BigInt(merchandise.vatCents) + BigInt(shipping.vatCents)),
		totalGrossCents: safeCents(BigInt(merchandise.grossCents) + BigInt(shipping.grossCents))
	};
}

function formatVatRate(basisPoints: number): string {
	return basisPoints % 100 === 0 ? String(basisPoints / 100) : (basisPoints / 100).toFixed(1);
}

export function pricingDisclosure(destination: PricingDestination): string {
	return destination.region === 'eu'
		? `Includes ${formatVatRate(destination.vatBasisPoints)}% ${destination.displayName} VAT. Exact tax is confirmed from your delivery address at checkout.`
		: 'EU VAT excluded. Import VAT, duties, brokerage, or carrier fees may be charged on arrival.';
}
