import { parseCart, selectShippingMode, totalUnits, type CartLine } from '$lib/domain/cart';
import type { CatalogProduct, CatalogShippingRates, CatalogVariant } from '$lib/domain/catalog';
import { isSupportedDestination, type MarketDestination } from '$lib/domain/destinations';
import type { NewCheckoutDraftLine } from '$lib/domain/orders';
import type { CatalogService } from '$lib/server/catalog/service.server';
import type { CheckoutDraftRepository } from '$lib/server/db/checkout-drafts.server';
import { CHECKOUT_CONTRACT_VERSION, type StripeCheckoutGateway } from '$lib/server/stripe/gateway';
import { enqueueAlert, type AlertService } from '$lib/server/monitoring/alerts.server';

export { CHECKOUT_CONTRACT_VERSION } from '$lib/server/stripe/gateway';

const CHECKOUT_DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;

export type CheckoutErrorCode =
	| 'CHECKOUT_REQUEST_INVALID'
	| 'CHECKOUT_DESTINATION_INVALID'
	| 'CHECKOUT_VARIANT_UNAVAILABLE'
	| 'CHECKOUT_CATALOG_UNAVAILABLE'
	| 'CHECKOUT_DRAFT_FAILED'
	| 'CHECKOUT_PROVIDER_UNAVAILABLE'
	| 'CHECKOUT_CORRELATION_FAILED';

export class CheckoutError extends Error {
	readonly code: CheckoutErrorCode;

	constructor(code: CheckoutErrorCode) {
		super(code);
		this.name = 'CheckoutError';
		this.code = code;
	}
}

export interface CheckoutService {
	start(input: unknown, destinationCountry: MarketDestination): Promise<{ redirectUrl: string }>;
}

type ResolvedCartLine = {
	line: CartLine;
	product: CatalogProduct;
	variant: CatalogVariant;
};

export type CheckoutServiceOptions = {
	catalog: Pick<CatalogService, 'resolveCartForCheckout'>;
	drafts: CheckoutDraftRepository;
	stripe: StripeCheckoutGateway;
	productionOrigin: URL;
	clock?: () => Date;
	alerts?: AlertService;
};

function parseCheckoutCart(input: unknown): CartLine[] {
	let lines: CartLine[];

	try {
		lines = parseCart(input);
	} catch {
		throw new CheckoutError('CHECKOUT_REQUEST_INVALID');
	}

	if (lines.length === 0) throw new CheckoutError('CHECKOUT_REQUEST_INVALID');
	return lines;
}

function validateShippingRates(input: CatalogShippingRates): CatalogShippingRates {
	if (
		!input ||
		!input.paid ||
		!input.free ||
		typeof input.paid.id !== 'string' ||
		input.paid.id.trim().length === 0 ||
		typeof input.free.id !== 'string' ||
		input.free.id.trim().length === 0 ||
		input.paid.id === input.free.id ||
		!Number.isSafeInteger(input.paid.netAmountCents) ||
		input.paid.netAmountCents <= 0 ||
		input.free.netAmountCents !== 0
	) {
		throw new Error('CATALOG_SHIPPING_RATE_INVALID');
	}
	return input;
}

function validateResolution(
	lines: CartLine[],
	resolution: Awaited<ReturnType<CatalogService['resolveCartForCheckout']>>
): { lines: ResolvedCartLine[]; shippingRates: CatalogShippingRates } {
	const resolved = resolution.lines;
	if (resolved.length !== lines.length) throw new CheckoutError('CHECKOUT_VARIANT_UNAVAILABLE');

	for (const [index, item] of resolved.entries()) {
		const expected = lines[index];
		if (
			item.line.priceId !== expected.priceId ||
			item.line.quantity !== expected.quantity ||
			item.variant.priceId !== expected.priceId ||
			item.variant.productId !== item.product.providerId ||
			item.variant.currency !== 'eur'
		) {
			throw new CheckoutError('CHECKOUT_VARIANT_UNAVAILABLE');
		}
	}

	return { lines: resolved, shippingRates: validateShippingRates(resolution.shippingRates) };
}

function snapshotLine(item: ResolvedCartLine): NewCheckoutDraftLine {
	return {
		stripeProductId: item.product.providerId,
		stripePriceId: item.variant.priceId,
		productName: item.product.name,
		variantLabel: item.variant.label,
		sku: item.variant.sku,
		styriaProductNumber: item.variant.styriaProductNumber,
		designReference: item.product.designReference,
		designPlacements: { ...item.product.designPlacements },
		productionDetails: {
			mockupPlacements: { ...item.product.productionDetails.mockupPlacements },
			threadColors: Object.fromEntries(
				Object.entries(item.product.productionDetails.threadColors).map(([position, colors]) => [
					position,
					[...colors]
				])
			)
		},
		quantity: item.line.quantity,
		unitAmount: item.variant.unitAmountCents,
		currency: 'eur'
	};
}

export function createCheckoutService(options: CheckoutServiceOptions): CheckoutService {
	const clock = options.clock ?? (() => new Date());
	const alerts = options.alerts ?? { enqueueAlert };

	function notifyUnavailable(subjectId: 'catalog' | 'stripe-checkout', now: Date): void {
		try {
			alerts.enqueueAlert('CHECKOUT_UNAVAILABLE', subjectId, now);
		} catch {
			// Checkout remains fail-closed even when alert persistence is unavailable.
		}
	}

	return {
		async start(
			input: unknown,
			destinationCountry: MarketDestination
		): Promise<{ redirectUrl: string }> {
			if (!isSupportedDestination(destinationCountry)) {
				throw new CheckoutError('CHECKOUT_DESTINATION_INVALID');
			}
			const lines = parseCheckoutCart(input);
			const observedAt = clock();
			let resolved: ResolvedCartLine[];
			let shippingRates: CatalogShippingRates;

			try {
				const resolution = validateResolution(
					lines,
					await options.catalog.resolveCartForCheckout(lines)
				);
				resolved = resolution.lines;
				shippingRates = resolution.shippingRates;
			} catch (error) {
				if (error instanceof CheckoutError) throw error;
				if (error instanceof Error && error.message === 'CATALOG_VARIANT_UNAVAILABLE') {
					throw new CheckoutError('CHECKOUT_VARIANT_UNAVAILABLE');
				}
				notifyUnavailable('catalog', observedAt);
				throw new CheckoutError('CHECKOUT_CATALOG_UNAVAILABLE');
			}

			const shippingMode = selectShippingMode(lines);
			const shippingRate = shippingRates[shippingMode];
			const createdAt = observedAt;
			let draft;

			try {
				draft = options.drafts.create({
					contractVersion: CHECKOUT_CONTRACT_VERSION,
					destinationCountry,
					currency: 'eur',
					totalUnitCount: totalUnits(lines),
					shippingMode,
					shippingRateId: shippingRate.id,
					shippingNetAmount: shippingRate.netAmountCents,
					createdAt,
					expiresAt: new Date(createdAt.getTime() + CHECKOUT_DRAFT_TTL_MS),
					lines: resolved.map(snapshotLine)
				});
			} catch {
				throw new CheckoutError('CHECKOUT_DRAFT_FAILED');
			}

			let session: { id: string; url: string };

			try {
				session = await options.stripe.createSession({
					draftId: draft.id,
					destinationCountry,
					lines: resolved.map((item) => ({
						priceId: item.variant.priceId,
						quantity: item.line.quantity,
						unitAmount: item.variant.unitAmountCents,
						productName: item.product.name,
						variantLabel: item.variant.label,
						taxCode: item.product.taxCode,
						images: [...item.product.images]
					})),
					shippingRateId: shippingRate.id,
					successUrl: `${options.productionOrigin.origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
					cancelUrl: `${options.productionOrigin.origin}/checkout/cancel`
				});
			} catch {
				notifyUnavailable('stripe-checkout', observedAt);
				throw new CheckoutError('CHECKOUT_PROVIDER_UNAVAILABLE');
			}

			try {
				options.drafts.attachSession(draft.id, session.id);
			} catch {
				try {
					await options.stripe.expireSession(session.id);
				} catch {
					// The stable correlation error takes precedence over compensating provider failure.
				}
				throw new CheckoutError('CHECKOUT_CORRELATION_FAILED');
			}

			return { redirectUrl: session.url };
		}
	};
}
