import type { CatalogVariant } from '$lib/domain/catalog';
import type { CatalogGateway } from '$lib/server/catalog/gateway';
import { parseStripeCatalog } from '$lib/server/catalog/parse';
import type { StripeCheckoutClient } from '$lib/server/stripe/checkout.server';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import type { StripeOrderClient } from '$lib/server/stripe/paid-checkout';
import {
	STRIPE_CATALOG_LOADED_AT,
	stripeAccessoryPrice,
	stripeAccessoryProduct,
	stripePrice,
	stripeProduct
} from './stripe-catalog';
import {
	paidCheckoutProviderFixture,
	type PaidCheckoutProviderFixture
} from './stripe-paid-checkout';

type CatalogScenario = 'available' | 'unavailable' | 'guard-proof';

export class StripeFulfillmentError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'StripeFulfillmentError';
	}
}

export function createStripeFulfillmentGateway(): StripeFulfillmentGateway {
	return {
		async retrieveFulfillmentDetails(): Promise<never> {
			throw new StripeFulfillmentError('STRIPE_FIXTURE_UNAVAILABLE');
		}
	};
}

function scenario(): CatalogScenario {
	const value = process.env.TEST_CATALOG_SCENARIO ?? 'available';
	if (value === 'available' || value === 'unavailable' || value === 'guard-proof') return value;
	throw new Error('TEST_CATALOG_SCENARIO_INVALID');
}

const PRODUCTS = [
	stripeProduct({
		metadata: {
			sort_order: '10'
		}
	}),
	stripeAccessoryProduct({
		metadata: {
			sort_order: '20'
		}
	})
];

const PRICES_BY_PRODUCT = new Map([
	[
		'prod_apparel',
		[
			stripePrice({
				id: 'price_apparel_small',
				metadata: {
					label: 'S',
					sort_order: '10',
					sku: 'SS-TEE-S',
					styria_pn: 'STYRIA-TEE-S'
				}
			}),
			stripePrice()
		]
	],
	['prod_accessory', [stripeAccessoryPrice()]]
]);

export function createStripeFixtureClient(fixture: PaidCheckoutProviderFixture): StripeOrderClient {
	return {
		checkout: {
			sessions: {
				async retrieve() {
					return structuredClone(fixture.session);
				},
				async listLineItems(_sessionId, parameters) {
					const cursor = parameters?.starting_after;
					const pageIndex = cursor
						? fixture.linePages.findIndex((page) => page.data.at(-1)?.id === cursor) + 1
						: 0;
					return structuredClone(fixture.linePages[pageIndex]);
				}
			}
		},
		paymentIntents: {
			async retrieve() {
				return structuredClone(fixture.refundPaymentIntent);
			}
		}
	};
}

export function createStripeClient(
	stripeSecretKey: string
): StripeCheckoutClient & StripeOrderClient {
	void stripeSecretKey;
	const fixture = paidCheckoutProviderFixture({
		sessionId: 'cs_test_browser_verified',
		draftId: 'draft-test-browser-verified',
		shippingAmount: 1_000,
		lines: [
			{
				id: 'li_browser_mug',
				priceId: 'price_accessory_one',
				quantity: 1,
				unitAmount: 1_600,
				taxAmount: 400
			}
		]
	});
	const orderClient = createStripeFixtureClient(fixture);
	const verified = process.env.TEST_STRIPE_SCENARIO === 'verified';
	const unavailable = async (): Promise<never> => {
		throw new Error('STRIPE_FIXTURE_UNAVAILABLE');
	};

	return {
		checkout: {
			sessions: {
				create: verified
					? async () => ({
							id: fixture.session.id,
							url: `https://checkout.stripe.com/c/pay/${fixture.session.id}`
						})
					: unavailable,
				expire: verified ? async (sessionId) => ({ id: sessionId }) : unavailable,
				retrieve: verified ? orderClient.checkout.sessions.retrieve : unavailable,
				listLineItems: verified ? orderClient.checkout.sessions.listLineItems : unavailable
			}
		},
		paymentIntents: {
			retrieve: verified ? orderClient.paymentIntents.retrieve : unavailable
		}
	};
}

async function parsedFixtureCatalog() {
	return parseStripeCatalog(
		PRODUCTS,
		async (productId) => PRICES_BY_PRODUCT.get(productId) ?? [],
		STRIPE_CATALOG_LOADED_AT
	);
}

export function createCatalogGateway(stripeSecretKey: string): CatalogGateway {
	void stripeSecretKey;
	const activeScenario = scenario();
	if (activeScenario === 'guard-proof') throw new Error('STOREFRONT_GUARD_BYPASSED');

	async function loadMerchCatalog() {
		if (activeScenario === 'unavailable') throw new Error('CATALOG_UNAVAILABLE');
		return parsedFixtureCatalog();
	}

	return {
		loadMerchCatalog,
		async resolveVariants(priceIds) {
			const snapshot = await loadMerchCatalog();
			const variants = new Map<string, CatalogVariant>();

			for (const product of snapshot.products) {
				for (const variant of product.variants) variants.set(variant.priceId, variant);
			}

			return priceIds
				.map((priceId) => variants.get(priceId))
				.filter((variant): variant is CatalogVariant => variant !== undefined);
		}
	};
}
