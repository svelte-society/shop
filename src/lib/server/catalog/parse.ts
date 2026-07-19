import type Stripe from 'stripe';
import { swedishReferenceGrossCents } from '$lib/domain/money';
import type {
	CatalogCategory,
	CatalogDiagnostic,
	CatalogProduct,
	CatalogSnapshot,
	CatalogVariant
} from '$lib/domain/catalog';

type ParsedProduct = Omit<CatalogProduct, 'variants'>;

type ProductResult = {
	product: ParsedProduct | null;
	diagnostics: CatalogDiagnostic[];
};

type PriceResult = {
	variant: CatalogVariant | null;
	diagnostics: CatalogDiagnostic[];
};

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const DESIGN_KEY_PATTERN = /^design_url_([a-z0-9]+(?:_[a-z0-9]+)*)$/;

function diagnostic(providerId: string, code: string): CatalogDiagnostic {
	return { providerId, code };
}

function nonEmpty(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function integerMetadata(value: string | undefined): number | null {
	if (!value || !INTEGER_PATTERN.test(value)) return null;

	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function httpsUrl(value: string | null | undefined): string | null {
	if (!value) return null;

	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function productIdFor(price: Stripe.Price): string | null {
	if (typeof price.product === 'string') return price.product;
	if ('deleted' in price.product && price.product.deleted) return null;
	return price.product.id;
}

function parseProduct(source: Stripe.Product): ProductResult | null {
	if (source.metadata.product_type !== 'merch') return null;

	const diagnostics: CatalogDiagnostic[] = [];
	const add = (code: string) => diagnostics.push(diagnostic(source.id, code));

	if (!source.active) add('PRODUCT_INACTIVE');

	const name = nonEmpty(source.name);
	if (!name) add('PRODUCT_NAME_INVALID');

	const description = nonEmpty(source.description);
	if (!description) add('PRODUCT_DESCRIPTION_INVALID');

	const images = source.images.map(httpsUrl).filter((image): image is string => image !== null);
	if (images.length === 0) add('PRODUCT_IMAGE_INVALID');

	if (source.shippable !== true || !source.tax_code) {
		add('PRODUCT_PHYSICAL_GOODS_INVALID');
	}

	const slug = nonEmpty(source.metadata.slug);
	if (!slug || !SLUG_PATTERN.test(slug)) add('PRODUCT_SLUG_INVALID');

	const sortOrder = integerMetadata(source.metadata.sort_order);
	if (sortOrder === null) add('PRODUCT_SORT_ORDER_INVALID');

	const category = source.metadata.category;
	if (category !== 'apparel' && category !== 'accessory') add('PRODUCT_CATEGORY_INVALID');

	const materials = nonEmpty(source.metadata.materials);
	if (!materials) add('PRODUCT_MATERIALS_INVALID');

	const care = nonEmpty(source.metadata.care);
	if (!care) add('PRODUCT_CARE_INVALID');

	const fit = nonEmpty(source.metadata.fit);
	if (category === 'apparel' && !fit) add('PRODUCT_FIT_INVALID');

	const designReference = nonEmpty(source.metadata.design_reference);
	if (!designReference) add('PRODUCT_DESIGN_REFERENCE_INVALID');

	const designEntries = Object.entries(source.metadata)
		.map(([key, value]) => {
			const match = DESIGN_KEY_PATTERN.exec(key);
			return match ? ([match[1], httpsUrl(value)] as const) : null;
		})
		.filter((entry): entry is readonly [string, string | null] => entry !== null)
		.sort(([left], [right]) => compareStrings(left, right));

	if (designEntries.length === 0) add('PRODUCT_DESIGN_PLACEMENT_MISSING');
	if (designEntries.some(([, url]) => url === null)) add('PRODUCT_DESIGN_PLACEMENT_INVALID');

	const sizeGuideValue = nonEmpty(source.metadata.size_guide_url);
	const sizeGuideUrl = sizeGuideValue ? httpsUrl(sizeGuideValue) : null;
	if (sizeGuideValue && !sizeGuideUrl) add('PRODUCT_SIZE_GUIDE_INVALID');

	if (
		diagnostics.length > 0 ||
		!name ||
		!description ||
		!slug ||
		sortOrder === null ||
		(category !== 'apparel' && category !== 'accessory') ||
		!materials ||
		!care ||
		!designReference
	) {
		return { product: null, diagnostics };
	}

	return {
		product: {
			providerId: source.id,
			slug,
			name,
			description,
			images,
			sortOrder,
			category: category as CatalogCategory,
			materials,
			care,
			fit: category === 'apparel' ? fit : null,
			sizeGuideUrl,
			designReference,
			designPlacements: Object.fromEntries(
				designEntries.map(([position, url]) => [position, url as string])
			)
		},
		diagnostics
	};
}

function parsePrice(source: Stripe.Price, productId: string): PriceResult {
	const diagnostics: CatalogDiagnostic[] = [];
	const add = (code: string) => diagnostics.push(diagnostic(source.id, code));

	if (!source.active) add('PRICE_INACTIVE');
	if (productIdFor(source) !== productId) add('PRICE_PRODUCT_INVALID');
	if (source.type !== 'one_time' || source.recurring !== null) add('PRICE_TYPE_INVALID');
	if (source.billing_scheme !== 'per_unit') add('PRICE_BILLING_SCHEME_INVALID');
	if (source.currency !== 'eur') add('PRICE_CURRENCY_INVALID');
	if (
		source.unit_amount === null ||
		!Number.isSafeInteger(source.unit_amount) ||
		source.unit_amount < 0
	) {
		add('PRICE_UNIT_AMOUNT_INVALID');
	}
	if (source.tax_behavior !== 'exclusive') add('PRICE_TAX_INVALID');

	const label = nonEmpty(source.metadata.label);
	if (!label) add('PRICE_LABEL_INVALID');

	const sortOrder = integerMetadata(source.metadata.sort_order);
	if (sortOrder === null) add('PRICE_SORT_ORDER_INVALID');

	const sku = nonEmpty(source.metadata.sku);
	if (!sku) add('PRICE_SKU_INVALID');

	const styriaProductNumber = nonEmpty(source.metadata.styria_pn);
	if (!styriaProductNumber) add('PRICE_STYRIA_PN_INVALID');

	if (
		diagnostics.length > 0 ||
		source.unit_amount === null ||
		!label ||
		sortOrder === null ||
		!sku ||
		!styriaProductNumber
	) {
		return { variant: null, diagnostics };
	}

	return {
		variant: {
			priceId: source.id,
			productId,
			label,
			sortOrder,
			currency: 'eur',
			unitAmountCents: source.unit_amount,
			referenceGrossCents: swedishReferenceGrossCents(source.unit_amount),
			sku,
			styriaProductNumber
		},
		diagnostics
	};
}

function sortDiagnostics(diagnostics: CatalogDiagnostic[]): CatalogDiagnostic[] {
	return diagnostics.sort(
		(left, right) =>
			compareStrings(left.providerId, right.providerId) || compareStrings(left.code, right.code)
	);
}

function duplicateSlugClaimants(sources: readonly Stripe.Product[]): Set<string> {
	const claimsBySlug = new Map<string, string[]>();

	for (const source of sources) {
		if (source.metadata.product_type !== 'merch' || !source.active) continue;
		const slug = nonEmpty(source.metadata.slug);
		if (!slug || !SLUG_PATTERN.test(slug)) continue;
		const claimants = claimsBySlug.get(slug) ?? [];
		claimants.push(source.id);
		claimsBySlug.set(slug, claimants);
	}

	return new Set(
		Array.from(claimsBySlug.values())
			.filter((claimants) => claimants.length > 1)
			.flat()
	);
}

export async function parseStripeCatalog(
	sources: readonly Stripe.Product[],
	loadPrices: (productId: string) => Promise<readonly Stripe.Price[]>,
	loadedAt: Date
): Promise<CatalogSnapshot> {
	const diagnostics: CatalogDiagnostic[] = [];
	const duplicateProviderIds = duplicateSlugClaimants(sources);
	const uniqueProducts: ParsedProduct[] = [];

	for (const source of sources) {
		const result = parseProduct(source);
		if (!result) continue;
		diagnostics.push(...result.diagnostics);
		if (duplicateProviderIds.has(source.id)) {
			diagnostics.push(diagnostic(source.id, 'PRODUCT_SLUG_DUPLICATE'));
			continue;
		}
		if (result.product) uniqueProducts.push(result.product);
	}

	const products = (
		await Promise.all(
			uniqueProducts.map(async (product): Promise<CatalogProduct | null> => {
				const prices = await loadPrices(product.providerId);
				const parsedPrices = prices.map((price) => parsePrice(price, product.providerId));
				for (const result of parsedPrices) diagnostics.push(...result.diagnostics);

				const variants = parsedPrices
					.map((result) => result.variant)
					.filter((variant): variant is CatalogVariant => variant !== null)
					.sort(
						(left, right) =>
							left.sortOrder - right.sortOrder ||
							compareStrings(left.label, right.label) ||
							compareStrings(left.priceId, right.priceId)
					);

				if (variants.length === 0) {
					diagnostics.push(diagnostic(product.providerId, 'PRODUCT_NO_VALID_PRICES'));
					return null;
				}

				return { ...product, variants };
			})
		)
	)
		.filter((product): product is CatalogProduct => product !== null)
		.sort(
			(left, right) =>
				left.sortOrder - right.sortOrder ||
				compareStrings(left.name, right.name) ||
				compareStrings(left.providerId, right.providerId)
		);

	return {
		products,
		diagnostics: sortDiagnostics(diagnostics),
		loadedAt: new Date(loadedAt),
		stale: false
	};
}
