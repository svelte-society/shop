import type { CatalogGateway } from '$lib/server/catalog/gateway';
import { parseStripeCatalog, parseStripeShippingRates } from '$lib/server/catalog/parse';
import type { StripeCheckoutClient } from '$lib/server/stripe/checkout.server';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import { SqliteCheckoutDraftRepository } from '$lib/server/db/checkout-drafts.server';
import { openDatabase } from '$lib/server/db/connection.server';
import type { StripeOrderClient } from '$lib/server/stripe/paid-checkout';
import {
	STRIPE_CATALOG_LOADED_AT,
	stripeAccessoryPrice,
	stripeAccessoryProduct,
	stripePrice,
	stripeProduct,
	stripeShippingRate
} from './stripe-catalog';
import {
	paidCheckoutProviderFixture,
	type PaidCheckoutProviderFixture
} from './stripe-paid-checkout';

type CatalogScenario = 'available' | 'unavailable' | 'guard-proof';
const VERIFIED_SESSION_ID = 'cs_test_browser_verified';

function ensureVerifiedDraft(): string {
	const databasePath = process.env.DATABASE_PATH;
	if (!databasePath) throw new Error('TEST_DATABASE_PATH_MISSING');
	const database = openDatabase(databasePath, { fileMustExist: true });
	const existing = database
		.prepare('SELECT id FROM checkout_drafts WHERE stripe_checkout_session_id = ?')
		.get(VERIFIED_SESSION_ID) as { id: string } | undefined;
	if (existing) return existing.id;

	const drafts = new SqliteCheckoutDraftRepository(database);
	const draft = drafts.create({
		contractVersion: 2,
		destinationCountry: 'SE',
		currency: 'eur',
		totalUnitCount: 1,
		shippingMode: 'paid',
		shippingRateId: 'shr_paid_8_eur',
		shippingNetAmount: 800,
		createdAt: new Date('2026-07-22T09:00:00.000Z'),
		expiresAt: new Date('2026-07-23T09:00:00.000Z'),
		lines: [
			{
				stripeProductId: 'prod_accessory',
				stripePriceId: 'price_accessory_one',
				productName: 'Society Mug',
				variantLabel: 'One size',
				sku: 'SS-MUG',
				styriaProductNumber: 'STYRIA-MUG',
				designReference: 'society-mug-v1',
				designPlacements: { wrap: 'https://cdn.example.com/designs/mug-wrap.svg' },
				quantity: 1,
				unitAmount: 2_000,
				currency: 'eur'
			}
		]
	});
	drafts.attachSession(draft.id, VERIFIED_SESSION_ID);
	return draft.id;
}

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
	let fixture = paidCheckoutProviderFixture({
		sessionId: VERIFIED_SESSION_ID,
		draftId: 'draft-test-browser-verified',
		shippingSubtotal: 800,
		lines: [
			{
				id: 'li_browser_mug',
				priceId: 'price_accessory_one',
				quantity: 1,
				unitAmount: 2_000,
				taxAmount: 500
			}
		]
	});
	const verified = process.env.TEST_STRIPE_SCENARIO === 'verified';
	const unavailable = async (): Promise<never> => {
		throw new Error('STRIPE_FIXTURE_UNAVAILABLE');
	};
	const verifiedFixture = (): PaidCheckoutProviderFixture => {
		const draftId = ensureVerifiedDraft();
		if (fixture.session.metadata?.checkout_draft_id !== draftId) {
			fixture = paidCheckoutProviderFixture({
				sessionId: VERIFIED_SESSION_ID,
				draftId,
				shippingSubtotal: 800,
				lines: [
					{
						id: 'li_browser_mug',
						priceId: 'price_accessory_one',
						quantity: 1,
						unitAmount: 2_000,
						taxAmount: 500
					}
				]
			});
		}
		return fixture;
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
				retrieve: verified ? async () => structuredClone(verifiedFixture().session) : unavailable,
				listLineItems: verified
					? async (_sessionId, parameters) => {
							const activeFixture = verifiedFixture();
							const cursor = parameters?.starting_after;
							const pageIndex = cursor
								? activeFixture.linePages.findIndex((page) => page.data.at(-1)?.id === cursor) + 1
								: 0;
							return structuredClone(activeFixture.linePages[pageIndex]);
						}
					: unavailable
			}
		},
		paymentIntents: {
			retrieve: verified
				? async () => structuredClone(verifiedFixture().refundPaymentIntent)
				: unavailable
		}
	};
}

async function parsedFixtureCatalog(options: {
	paidShippingRateId: string;
	freeShippingRateId: string;
}) {
	return parseStripeCatalog(
		PRODUCTS,
		async (productId) => PRICES_BY_PRODUCT.get(productId) ?? [],
		STRIPE_CATALOG_LOADED_AT,
		parseStripeShippingRates({
			paid: {
				configuredId: options.paidShippingRateId,
				rate: stripeShippingRate({
					id: options.paidShippingRateId,
					fixed_amount: { amount: 937, currency: 'eur' }
				})
			},
			free: {
				configuredId: options.freeShippingRateId,
				rate: stripeShippingRate({
					id: options.freeShippingRateId,
					fixed_amount: { amount: 0, currency: 'eur' }
				})
			}
		})
	);
}

export function createCatalogGateway(
	stripeSecretKey: string,
	options: { paidShippingRateId: string; freeShippingRateId: string }
): CatalogGateway {
	void stripeSecretKey;
	const activeScenario = scenario();
	if (activeScenario === 'guard-proof') throw new Error('STOREFRONT_GUARD_BYPASSED');

	async function loadMerchCatalog() {
		if (activeScenario === 'unavailable') throw new Error('CATALOG_UNAVAILABLE');
		return parsedFixtureCatalog(options);
	}

	return { loadMerchCatalog };
}
