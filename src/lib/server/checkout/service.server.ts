import { parseCart, selectShippingMode, totalUnits, type CartLine } from '$lib/domain/cart';
import type { CatalogProduct, CatalogVariant } from '$lib/domain/catalog';
import type { NewCheckoutDraftLine } from '$lib/domain/orders';
import type { CatalogService } from '$lib/server/catalog/service.server';
import type { CheckoutDraftRepository } from '$lib/server/db/checkout-drafts.server';
import { CHECKOUT_CONTRACT_VERSION, type StripeCheckoutGateway } from '$lib/server/stripe/gateway';
import { enqueueAlert, type AlertService } from '$lib/server/monitoring/alerts.server';

export { CHECKOUT_CONTRACT_VERSION } from '$lib/server/stripe/gateway';

const CHECKOUT_DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;

export type CheckoutErrorCode =
	| 'CHECKOUT_REQUEST_INVALID'
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
	start(input: unknown): Promise<{ redirectUrl: string }>;
}

type ResolvedCartLine = {
	line: CartLine;
	product: CatalogProduct;
	variant: CatalogVariant;
};

export type CheckoutServiceOptions = {
	catalog: Pick<CatalogService, 'resolveCart'>;
	drafts: CheckoutDraftRepository;
	stripe: StripeCheckoutGateway;
	paidShippingRateId: string;
	freeShippingRateId: string;
	productionOrigin: URL;
	allowedCountries: readonly string[];
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

function validateResolution(lines: CartLine[], resolved: ResolvedCartLine[]): ResolvedCartLine[] {
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

	return resolved;
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
		async start(input: unknown): Promise<{ redirectUrl: string }> {
			const lines = parseCheckoutCart(input);
			const observedAt = clock();
			let resolved: ResolvedCartLine[];

			try {
				resolved = validateResolution(lines, await options.catalog.resolveCart(lines));
			} catch (error) {
				if (error instanceof CheckoutError) throw error;
				if (error instanceof Error && error.message === 'CATALOG_VARIANT_UNAVAILABLE') {
					throw new CheckoutError('CHECKOUT_VARIANT_UNAVAILABLE');
				}
				notifyUnavailable('catalog', observedAt);
				throw new CheckoutError('CHECKOUT_CATALOG_UNAVAILABLE');
			}

			const shippingMode = selectShippingMode(lines);
			const createdAt = observedAt;
			let draft;

			try {
				draft = options.drafts.create({
					contractVersion: CHECKOUT_CONTRACT_VERSION,
					currency: 'eur',
					totalUnitCount: totalUnits(lines),
					shippingMode,
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
					lines: resolved.map((item) => ({
						priceId: item.variant.priceId,
						quantity: item.line.quantity
					})),
					shippingRateId:
						shippingMode === 'paid' ? options.paidShippingRateId : options.freeShippingRateId,
					allowedCountries: options.allowedCountries,
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
