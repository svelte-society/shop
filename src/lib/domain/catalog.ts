import type { ProductionDetails } from './production';

export type CatalogCategory = 'apparel' | 'accessory';

export type CatalogDiagnostic = {
	providerId: string;
	code: string;
};

export type CatalogShippingRate = {
	id: string;
	netAmountCents: number;
};

export type CatalogShippingRates = {
	paid: CatalogShippingRate;
	free: CatalogShippingRate & { netAmountCents: 0 };
};

export type CatalogVariant = {
	priceId: string;
	productId: string;
	label: string;
	sortOrder: number;
	currency: 'eur';
	unitAmountCents: number;
	sku: string;
	styriaProductNumber: string;
};

export type ProductSizeChart = {
	unit: 'cm';
	sizes: string[];
	measurements: Array<{ label: string; values: number[] }>;
};

export type CatalogProduct = {
	providerId: string;
	slug: string;
	name: string;
	description: string;
	images: string[];
	sortOrder: number;
	category: CatalogCategory;
	materials: string;
	care: string;
	fit: string | null;
	sizeGuideUrl: string | null;
	sizeChart: ProductSizeChart | null;
	designReference: string;
	designPlacements: Record<string, string>;
	productionDetails: ProductionDetails;
	variants: CatalogVariant[];
};

export type CatalogSnapshot = {
	products: CatalogProduct[];
	shippingRates: CatalogShippingRates;
	diagnostics: CatalogDiagnostic[];
	loadedAt: Date;
	stale: boolean;
};

export type PublicCatalogVariant = Omit<
	CatalogVariant,
	'productId' | 'sku' | 'styriaProductNumber'
>;

export type PublicCatalogProduct = Omit<
	CatalogProduct,
	'providerId' | 'designReference' | 'designPlacements' | 'productionDetails' | 'variants'
> & {
	variants: PublicCatalogVariant[];
};

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function hasExactKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(input).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(input: unknown): input is string {
	return typeof input === 'string' && input.trim().length > 0;
}

function isSafeNonNegativeInteger(input: unknown): input is number {
	return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0;
}

function isHttpsUrl(input: unknown): input is string {
	if (typeof input !== 'string') return false;

	try {
		return new URL(input).protocol === 'https:';
	} catch {
		return false;
	}
}

function isCatalogDiagnostic(input: unknown): input is CatalogDiagnostic {
	return (
		isRecord(input) &&
		hasExactKeys(input, ['providerId', 'code']) &&
		isNonEmptyString(input.providerId) &&
		isNonEmptyString(input.code)
	);
}

function isCatalogVariant(input: unknown): input is CatalogVariant {
	return (
		isRecord(input) &&
		hasExactKeys(input, [
			'priceId',
			'productId',
			'label',
			'sortOrder',
			'currency',
			'unitAmountCents',
			'sku',
			'styriaProductNumber'
		]) &&
		isNonEmptyString(input.priceId) &&
		isNonEmptyString(input.productId) &&
		isNonEmptyString(input.label) &&
		isSafeNonNegativeInteger(input.sortOrder) &&
		input.currency === 'eur' &&
		isSafeNonNegativeInteger(input.unitAmountCents) &&
		input.unitAmountCents > 0 &&
		isNonEmptyString(input.sku) &&
		isNonEmptyString(input.styriaProductNumber)
	);
}

function isCatalogShippingRate(input: unknown, expectedAmount: 'positive' | 'zero'): boolean {
	return (
		isRecord(input) &&
		hasExactKeys(input, ['id', 'netAmountCents']) &&
		isNonEmptyString(input.id) &&
		isSafeNonNegativeInteger(input.netAmountCents) &&
		(expectedAmount === 'positive' ? input.netAmountCents > 0 : input.netAmountCents === 0)
	);
}

function isCatalogShippingRates(input: unknown): input is CatalogShippingRates {
	return (
		isRecord(input) &&
		hasExactKeys(input, ['paid', 'free']) &&
		isCatalogShippingRate(input.paid, 'positive') &&
		isCatalogShippingRate(input.free, 'zero') &&
		(input.paid as CatalogShippingRate).id !== (input.free as CatalogShippingRate).id
	);
}

export function isProductSizeChart(input: unknown): input is ProductSizeChart {
	if (
		!isRecord(input) ||
		!hasExactKeys(input, ['unit', 'sizes', 'measurements']) ||
		input.unit !== 'cm' ||
		!Array.isArray(input.sizes) ||
		input.sizes.length === 0 ||
		input.sizes.length > 20 ||
		!input.sizes.every(isNonEmptyString) ||
		new Set(input.sizes).size !== input.sizes.length ||
		!Array.isArray(input.measurements) ||
		input.measurements.length === 0 ||
		input.measurements.length > 10
	) {
		return false;
	}

	const labels = new Set<string>();
	for (const measurement of input.measurements) {
		if (
			!isRecord(measurement) ||
			!hasExactKeys(measurement, ['label', 'values']) ||
			!isNonEmptyString(measurement.label) ||
			labels.has(measurement.label) ||
			!Array.isArray(measurement.values) ||
			measurement.values.length !== input.sizes.length ||
			!measurement.values.every(
				(value) => typeof value === 'number' && Number.isFinite(value) && value > 0
			)
		) {
			return false;
		}
		labels.add(measurement.label);
	}

	return true;
}

function isCatalogProduct(input: unknown): input is CatalogProduct {
	if (
		!isRecord(input) ||
		!hasExactKeys(input, [
			'providerId',
			'slug',
			'name',
			'description',
			'images',
			'sortOrder',
			'category',
			'materials',
			'care',
			'fit',
			'sizeGuideUrl',
			'sizeChart',
			'designReference',
			'designPlacements',
			'productionDetails',
			'variants'
		]) ||
		!isNonEmptyString(input.providerId) ||
		!isNonEmptyString(input.slug) ||
		!isNonEmptyString(input.name) ||
		!isNonEmptyString(input.description) ||
		!Array.isArray(input.images) ||
		input.images.length === 0 ||
		!input.images.every(isHttpsUrl) ||
		!isSafeNonNegativeInteger(input.sortOrder) ||
		(input.category !== 'apparel' && input.category !== 'accessory') ||
		!isNonEmptyString(input.materials) ||
		!isNonEmptyString(input.care) ||
		(input.fit !== null && !isNonEmptyString(input.fit)) ||
		(input.category === 'apparel' && !isNonEmptyString(input.fit)) ||
		(input.sizeGuideUrl !== null && !isHttpsUrl(input.sizeGuideUrl)) ||
		(input.sizeChart !== null && !isProductSizeChart(input.sizeChart)) ||
		!isNonEmptyString(input.designReference) ||
		!isRecord(input.designPlacements) ||
		Object.keys(input.designPlacements).length === 0 ||
		!Object.values(input.designPlacements).every(isHttpsUrl) ||
		!isRecord(input.productionDetails) ||
		!hasExactKeys(input.productionDetails, ['mockupPlacements', 'threadColors']) ||
		!isRecord(input.productionDetails.mockupPlacements) ||
		!Object.values(input.productionDetails.mockupPlacements).every(isHttpsUrl) ||
		!isRecord(input.productionDetails.threadColors) ||
		!Object.values(input.productionDetails.threadColors).every(
			(colors) => Array.isArray(colors) && colors.length > 0 && colors.every(isNonEmptyString)
		) ||
		!Array.isArray(input.variants) ||
		input.variants.length === 0 ||
		!input.variants.every(isCatalogVariant)
	) {
		return false;
	}

	return input.variants.every((variant) => variant.productId === input.providerId);
}

export function assertCatalogSnapshot(input: unknown): asserts input is CatalogSnapshot {
	if (
		!isRecord(input) ||
		!hasExactKeys(input, ['products', 'shippingRates', 'diagnostics', 'loadedAt', 'stale']) ||
		!Array.isArray(input.products) ||
		!input.products.every(isCatalogProduct) ||
		!isCatalogShippingRates(input.shippingRates) ||
		!Array.isArray(input.diagnostics) ||
		!input.diagnostics.every(isCatalogDiagnostic) ||
		!(input.loadedAt instanceof Date) ||
		!Number.isFinite(input.loadedAt.getTime()) ||
		typeof input.stale !== 'boolean'
	) {
		throw new Error('CATALOG_SNAPSHOT_INVALID');
	}

	const slugs = input.products.map((product) => product.slug);
	const priceIds = input.products.flatMap((product) =>
		product.variants.map((variant) => variant.priceId)
	);

	if (new Set(slugs).size !== slugs.length || new Set(priceIds).size !== priceIds.length) {
		throw new Error('CATALOG_SNAPSHOT_INVALID');
	}
}

export function cloneCatalogSnapshot(
	snapshot: CatalogSnapshot,
	stale = snapshot.stale
): CatalogSnapshot {
	return {
		products: snapshot.products.map((product) => ({
			...product,
			images: [...product.images],
			sizeChart: product.sizeChart
				? {
						unit: product.sizeChart.unit,
						sizes: [...product.sizeChart.sizes],
						measurements: product.sizeChart.measurements.map((measurement) => ({
							label: measurement.label,
							values: [...measurement.values]
						}))
					}
				: null,
			designPlacements: { ...product.designPlacements },
			productionDetails: {
				mockupPlacements: { ...product.productionDetails.mockupPlacements },
				threadColors: Object.fromEntries(
					Object.entries(product.productionDetails.threadColors).map(([position, colors]) => [
						position,
						[...colors]
					])
				)
			},
			variants: product.variants.map((variant) => ({ ...variant }))
		})),
		shippingRates: {
			paid: { ...snapshot.shippingRates.paid },
			free: { ...snapshot.shippingRates.free }
		},
		diagnostics: snapshot.diagnostics.map((entry) => ({ ...entry })),
		loadedAt: new Date(snapshot.loadedAt),
		stale
	};
}

export function freezeCatalogSnapshot(snapshot: CatalogSnapshot): CatalogSnapshot {
	for (const product of snapshot.products) {
		for (const variant of product.variants) Object.freeze(variant);
		if (product.sizeChart) {
			for (const measurement of product.sizeChart.measurements) {
				Object.freeze(measurement.values);
				Object.freeze(measurement);
			}
			Object.freeze(product.sizeChart.measurements);
			Object.freeze(product.sizeChart.sizes);
			Object.freeze(product.sizeChart);
		}
		Object.freeze(product.variants);
		Object.freeze(product.images);
		Object.freeze(product.designPlacements);
		Object.freeze(product.productionDetails.mockupPlacements);
		for (const colors of Object.values(product.productionDetails.threadColors))
			Object.freeze(colors);
		Object.freeze(product.productionDetails.threadColors);
		Object.freeze(product.productionDetails);
		Object.freeze(product);
	}

	for (const entry of snapshot.diagnostics) Object.freeze(entry);
	Object.freeze(snapshot.shippingRates.paid);
	Object.freeze(snapshot.shippingRates.free);
	Object.freeze(snapshot.shippingRates);
	Object.freeze(snapshot.products);
	Object.freeze(snapshot.diagnostics);
	Object.freeze(snapshot.loadedAt);
	return Object.freeze(snapshot);
}

export function immutableCatalogSnapshot(
	snapshot: CatalogSnapshot,
	stale = snapshot.stale
): CatalogSnapshot {
	return freezeCatalogSnapshot(cloneCatalogSnapshot(snapshot, stale));
}

export function toPublicCatalogProduct(product: CatalogProduct): PublicCatalogProduct {
	return {
		slug: product.slug,
		name: product.name,
		description: product.description,
		images: [...product.images],
		sortOrder: product.sortOrder,
		category: product.category,
		materials: product.materials,
		care: product.care,
		fit: product.fit,
		sizeGuideUrl: product.sizeGuideUrl,
		sizeChart: product.sizeChart
			? {
					unit: product.sizeChart.unit,
					sizes: [...product.sizeChart.sizes],
					measurements: product.sizeChart.measurements.map((measurement) => ({
						label: measurement.label,
						values: [...measurement.values]
					}))
				}
			: null,
		variants: product.variants.map((variant) => ({
			priceId: variant.priceId,
			label: variant.label,
			sortOrder: variant.sortOrder,
			currency: variant.currency,
			unitAmountCents: variant.unitAmountCents
		}))
	};
}
