export type CatalogCategory = 'apparel' | 'accessory';

export type CatalogDiagnostic = {
	providerId: string;
	code: string;
};

export type CatalogVariant = {
	priceId: string;
	productId: string;
	label: string;
	sortOrder: number;
	currency: 'eur';
	unitAmountCents: number;
	referenceGrossCents: number;
	sku: string;
	styriaProductNumber: string;
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
	designReference: string;
	designPlacements: Record<string, string>;
	variants: CatalogVariant[];
};

export type CatalogSnapshot = {
	products: CatalogProduct[];
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
	'providerId' | 'designReference' | 'designPlacements' | 'variants'
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
			'referenceGrossCents',
			'sku',
			'styriaProductNumber'
		]) &&
		isNonEmptyString(input.priceId) &&
		isNonEmptyString(input.productId) &&
		isNonEmptyString(input.label) &&
		isSafeNonNegativeInteger(input.sortOrder) &&
		input.currency === 'eur' &&
		isSafeNonNegativeInteger(input.unitAmountCents) &&
		isSafeNonNegativeInteger(input.referenceGrossCents) &&
		isNonEmptyString(input.sku) &&
		isNonEmptyString(input.styriaProductNumber)
	);
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
			'designReference',
			'designPlacements',
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
		!isNonEmptyString(input.designReference) ||
		!isRecord(input.designPlacements) ||
		Object.keys(input.designPlacements).length === 0 ||
		!Object.values(input.designPlacements).every(isHttpsUrl) ||
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
		!hasExactKeys(input, ['products', 'diagnostics', 'loadedAt', 'stale']) ||
		!Array.isArray(input.products) ||
		!input.products.every(isCatalogProduct) ||
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
			designPlacements: { ...product.designPlacements },
			variants: product.variants.map((variant) => ({ ...variant }))
		})),
		diagnostics: snapshot.diagnostics.map((entry) => ({ ...entry })),
		loadedAt: new Date(snapshot.loadedAt),
		stale
	};
}

export function freezeCatalogSnapshot(snapshot: CatalogSnapshot): CatalogSnapshot {
	for (const product of snapshot.products) {
		for (const variant of product.variants) Object.freeze(variant);
		Object.freeze(product.variants);
		Object.freeze(product.images);
		Object.freeze(product.designPlacements);
		Object.freeze(product);
	}

	for (const entry of snapshot.diagnostics) Object.freeze(entry);
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
		variants: product.variants.map((variant) => ({
			priceId: variant.priceId,
			label: variant.label,
			sortOrder: variant.sortOrder,
			currency: variant.currency,
			unitAmountCents: variant.unitAmountCents,
			referenceGrossCents: variant.referenceGrossCents
		}))
	};
}
