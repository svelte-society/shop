import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { CatalogProduct, CatalogVariant } from '$lib/domain/catalog';
import type { CheckoutDraft, CheckoutDraftWithLines, NewCheckoutDraft } from '$lib/domain/orders';
import { ALLOWED_DESTINATIONS } from '$lib/domain/destinations';
import type { CatalogService } from '$lib/server/catalog/service.server';
import type { CheckoutDraftRepository } from '$lib/server/db/checkout-drafts.server';
import {
	createStripeCheckoutGateway,
	type StripeCheckoutClient
} from '$lib/server/stripe/checkout.server';
import type { CreateCheckoutInput, StripeCheckoutGateway } from '$lib/server/stripe/gateway';
import type { AlertService } from '$lib/server/monitoring/alerts.server';
import { CHECKOUT_CONTRACT_VERSION, CheckoutError, createCheckoutService } from './service.server';

const NOW = new Date('2026-07-16T10:00:00.000Z');
const ORIGIN = new URL('https://shop.sveltesociety.dev');

const product: CatalogProduct = {
	providerId: 'prod_tee',
	slug: 'community-tee',
	name: 'Community Tee',
	description: 'A community tee for people who make with Svelte.',
	images: ['https://cdn.example.com/products/tee.png'],
	sortOrder: 10,
	category: 'apparel',
	materials: '100% organic cotton',
	care: 'Wash at 30°C',
	fit: 'Regular fit',
	sizeGuideUrl: 'https://cdn.example.com/guides/tee.pdf',
	sizeChart: null,
	designReference: 'society-community-v1',
	designPlacements: {
		back: 'https://cdn.example.com/designs/back.svg',
		front: 'https://cdn.example.com/designs/front.svg'
	},
	productionDetails: { mockupPlacements: {}, threadColors: {} },
	variants: []
};

const medium: CatalogVariant = {
	priceId: 'price_tee_medium_current',
	productId: product.providerId,
	label: 'M',
	sortOrder: 10,
	currency: 'eur',
	unitAmountCents: 2_000,
	referenceGrossCents: 2_500,
	sku: 'SS-TEE-M',
	styriaProductNumber: 'STYRIA-TEE-M'
};

const large: CatalogVariant = {
	...medium,
	priceId: 'price_tee_large_current',
	label: 'L',
	sortOrder: 20,
	sku: 'SS-TEE-L',
	styriaProductNumber: 'STYRIA-TEE-L'
};

function resolvedLine(variant: CatalogVariant, quantity: number) {
	return {
		line: { priceId: variant.priceId, quantity },
		product: { ...product, variants: [medium, large] },
		variant
	};
}

class RecordingDraftRepository implements CheckoutDraftRepository {
	readonly events: string[];
	readonly creates: NewCheckoutDraft[] = [];
	readonly attachments: Array<{ draftId: string; sessionId: string }> = [];
	attachFailure: Error | undefined;

	constructor(events: string[] = []) {
		this.events = events;
	}

	create(input: NewCheckoutDraft): CheckoutDraft {
		this.events.push('draft:create');
		this.creates.push(structuredClone(input));
		return {
			id: 'draft_123',
			checkoutSessionId: null,
			contractVersion: input.contractVersion,
			currency: input.currency,
			totalUnitCount: input.totalUnitCount,
			shippingMode: input.shippingMode,
			createdAt: input.createdAt,
			expiresAt: input.expiresAt,
			completedAt: null
		};
	}

	attachSession(draftId: string, sessionId: string): void {
		this.events.push('draft:attach');
		if (this.attachFailure) throw this.attachFailure;
		this.attachments.push({ draftId, sessionId });
	}

	findById(): CheckoutDraftWithLines | null {
		return null;
	}

	markCompleted(): void {}
}

class RecordingStripeGateway implements StripeCheckoutGateway {
	readonly events: string[];
	readonly creations: CreateCheckoutInput[] = [];
	readonly expirations: string[] = [];
	createFailure: Error | undefined;
	expireFailure: Error | undefined;

	constructor(events: string[] = []) {
		this.events = events;
	}

	async createSession(input: CreateCheckoutInput) {
		this.events.push('stripe:create');
		this.creations.push(structuredClone(input));
		if (this.createFailure) throw this.createFailure;
		return { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' };
	}

	async expireSession(sessionId: string): Promise<void> {
		this.events.push('stripe:expire');
		this.expirations.push(sessionId);
		if (this.expireFailure) throw this.expireFailure;
	}
}

type ResolvedCart = Awaited<ReturnType<CatalogService['resolveCart']>>;

function serviceFixture(
	options: {
		resolved?: ResolvedCart;
		resolveFailure?: Error;
		drafts?: RecordingDraftRepository;
		stripe?: RecordingStripeGateway;
		alerts?: AlertService;
		allowedCountries?: readonly string[];
	} = {}
) {
	const resolveInputs: Array<Array<{ priceId: string; quantity: number }>> = [];
	const drafts = options.drafts ?? new RecordingDraftRepository();
	const stripe = options.stripe ?? new RecordingStripeGateway();
	const catalog: Pick<CatalogService, 'resolveCart'> = {
		async resolveCart(lines) {
			resolveInputs.push(structuredClone(lines));
			if (options.resolveFailure) throw options.resolveFailure;
			return options.resolved ?? [resolvedLine(medium, 1)];
		}
	};
	const service = createCheckoutService({
		catalog,
		drafts,
		stripe,
		paidShippingRateId: 'shr_paid_10_eur',
		freeShippingRateId: 'shr_free',
		productionOrigin: ORIGIN,
		allowedCountries: options.allowedCountries ?? ALLOWED_DESTINATIONS,
		clock: () => new Date(NOW),
		alerts: options.alerts
	});

	return { service, resolveInputs, drafts, stripe };
}

async function expectCheckoutCode(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toMatchObject({ name: 'CheckoutError', code });
}

describe('createCheckoutService', () => {
	it('passes exactly the injected Styria-supported destinations to Stripe', async () => {
		const { service, stripe } = serviceFixture({ allowedCountries: ['SE', 'JP', 'TW'] });

		await service.start([{ priceId: medium.priceId, quantity: 1 }]);

		expect(stripe.creations[0]?.allowedCountries).toEqual(['SE', 'JP', 'TW']);
		expect(stripe.creations[0]?.allowedCountries).not.toContain('US');
	});

	it.each([
		['non-array input', { lines: [{ priceId: medium.priceId, quantity: 1 }] }],
		['empty cart', []],
		['client price details', [{ priceId: medium.priceId, quantity: 1, unitAmount: 1 }]],
		['fractional quantity', [{ priceId: medium.priceId, quantity: 1.5 }]],
		['over-limit quantity', [{ priceId: medium.priceId, quantity: 21 }]]
	])('rejects %s before catalog, draft, or provider work', async (_label, input) => {
		const { service, resolveInputs, drafts, stripe } = serviceFixture();

		await expectCheckoutCode(service.start(input), 'CHECKOUT_REQUEST_INVALID');

		expect(resolveInputs).toEqual([]);
		expect(drafts.creates).toEqual([]);
		expect(stripe.creations).toEqual([]);
	});

	it('maps a stale or unavailable Price to a stable conflict without creating a draft', async () => {
		const { service, drafts, stripe } = serviceFixture({
			resolveFailure: new Error('CATALOG_VARIANT_UNAVAILABLE')
		});

		await expectCheckoutCode(
			service.start([{ priceId: 'price_retired', quantity: 1 }]),
			'CHECKOUT_VARIANT_UNAVAILABLE'
		);

		expect(drafts.creates).toEqual([]);
		expect(stripe.creations).toEqual([]);
	});

	it('alerts an unexpected checkout-time catalog provider outage with no cart details', async () => {
		const alerts = { enqueueAlert: vi.fn() };
		const { service, drafts, stripe } = serviceFixture({
			resolveFailure: new Error('private catalog provider response and stack'),
			alerts
		});

		await expectCheckoutCode(
			service.start([{ priceId: medium.priceId, quantity: 1 }]),
			'CHECKOUT_CATALOG_UNAVAILABLE'
		);
		expect(alerts.enqueueAlert).toHaveBeenCalledWith('CHECKOUT_UNAVAILABLE', 'catalog', NOW);
		expect(JSON.stringify(alerts.enqueueAlert.mock.calls)).not.toContain(medium.priceId);
		expect(drafts.creates).toEqual([]);
		expect(stripe.creations).toEqual([]);
	});

	it('creates an immutable server-catalog snapshot before one-unit paid Checkout', async () => {
		const events: string[] = [];
		const drafts = new RecordingDraftRepository(events);
		const stripe = new RecordingStripeGateway(events);
		const { service } = serviceFixture({
			resolved: [resolvedLine(medium, 1)],
			drafts,
			stripe
		});

		await expect(service.start([{ priceId: medium.priceId, quantity: 1 }])).resolves.toEqual({
			redirectUrl: 'https://checkout.stripe.com/c/pay/cs_test_123'
		});

		expect(events).toEqual(['draft:create', 'stripe:create', 'draft:attach']);
		expect(drafts.creates).toEqual([
			{
				contractVersion: CHECKOUT_CONTRACT_VERSION,
				currency: 'eur',
				totalUnitCount: 1,
				shippingMode: 'paid',
				createdAt: NOW,
				expiresAt: new Date('2026-07-17T10:00:00.000Z'),
				lines: [
					{
						stripeProductId: 'prod_tee',
						stripePriceId: 'price_tee_medium_current',
						productName: 'Community Tee',
						variantLabel: 'M',
						sku: 'SS-TEE-M',
						styriaProductNumber: 'STYRIA-TEE-M',
						designReference: 'society-community-v1',
						designPlacements: {
							back: 'https://cdn.example.com/designs/back.svg',
							front: 'https://cdn.example.com/designs/front.svg'
						},
						productionDetails: { mockupPlacements: {}, threadColors: {} },
						quantity: 1,
						unitAmount: 2_000,
						currency: 'eur'
					}
				]
			}
		]);
		expect(stripe.creations[0]).toMatchObject({
			draftId: 'draft_123',
			lines: [{ priceId: medium.priceId, quantity: 1 }],
			shippingRateId: 'shr_paid_10_eur'
		});
		expect(drafts.attachments).toEqual([{ draftId: 'draft_123', sessionId: 'cs_test_123' }]);
	});

	it('selects free shipping for two distinct server-resolved units', async () => {
		const { service, stripe, drafts } = serviceFixture({
			resolved: [resolvedLine(medium, 1), resolvedLine(large, 1)]
		});

		await service.start([
			{ priceId: medium.priceId, quantity: 1 },
			{ priceId: large.priceId, quantity: 1 }
		]);

		expect(drafts.creates[0]).toMatchObject({ totalUnitCount: 2, shippingMode: 'free' });
		expect(stripe.creations[0]).toMatchObject({
			shippingRateId: 'shr_free',
			lines: [
				{ priceId: medium.priceId, quantity: 1 },
				{ priceId: large.priceId, quantity: 1 }
			]
		});
	});

	it('merges duplicate lines and selects free shipping for two of the same variant', async () => {
		const { service, resolveInputs, stripe } = serviceFixture({
			resolved: [resolvedLine(medium, 2)]
		});

		await service.start([
			{ priceId: medium.priceId, quantity: 1 },
			{ priceId: medium.priceId, quantity: 1 }
		]);

		expect(resolveInputs).toEqual([[{ priceId: medium.priceId, quantity: 2 }]]);
		expect(stripe.creations[0]).toMatchObject({
			shippingRateId: 'shr_free',
			lines: [{ priceId: medium.priceId, quantity: 2 }]
		});
	});

	it('uses the exact approved countries and canonical success/cancel URLs', async () => {
		const { service, stripe } = serviceFixture();

		await service.start([{ priceId: medium.priceId, quantity: 1 }]);

		expect(stripe.creations[0]).toEqual({
			draftId: 'draft_123',
			lines: [{ priceId: medium.priceId, quantity: 1 }],
			shippingRateId: 'shr_paid_10_eur',
			allowedCountries: ALLOWED_DESTINATIONS,
			successUrl:
				'https://shop.sveltesociety.dev/checkout/success?session_id={CHECKOUT_SESSION_ID}',
			cancelUrl: 'https://shop.sveltesociety.dev/checkout/cancel'
		});
	});

	it('does not attach when Stripe times out or fails', async () => {
		const alerts = { enqueueAlert: vi.fn() };
		const stripe = new RecordingStripeGateway();
		stripe.createFailure = new Error('Connection timed out for sk_test_secret');
		const { service, drafts } = serviceFixture({ stripe, alerts });

		await expectCheckoutCode(
			service.start([{ priceId: medium.priceId, quantity: 1 }]),
			'CHECKOUT_PROVIDER_UNAVAILABLE'
		);

		expect(drafts.creates).toHaveLength(1);
		expect(drafts.attachments).toEqual([]);
		expect(stripe.expirations).toEqual([]);
		expect(alerts.enqueueAlert).toHaveBeenCalledWith(
			'CHECKOUT_UNAVAILABLE',
			'stripe-checkout',
			NOW
		);
	});

	it('does not alert on expected request or retired-variant errors', async () => {
		const alerts = { enqueueAlert: vi.fn() };
		const { service } = serviceFixture({
			resolveFailure: new Error('CATALOG_VARIANT_UNAVAILABLE'),
			alerts
		});

		await expectCheckoutCode(service.start({ private: 'payload' }), 'CHECKOUT_REQUEST_INVALID');
		await expectCheckoutCode(
			service.start([{ priceId: 'retired_price', quantity: 1 }]),
			'CHECKOUT_VARIANT_UNAVAILABLE'
		);
		expect(alerts.enqueueAlert).not.toHaveBeenCalled();
	});

	it('keeps the draft unattached when Stripe returns a malformed Checkout Session', async () => {
		const drafts = new RecordingDraftRepository();
		const stripe = createStripeCheckoutGateway({
			checkout: {
				sessions: {
					async create() {
						return {
							id: 'anything',
							url: 'https://attacker.example/c/pay/anything'
						};
					},
					async expire(sessionId) {
						return { id: sessionId };
					}
				}
			}
		});
		const service = createCheckoutService({
			catalog: {
				async resolveCart() {
					return [resolvedLine(medium, 1)];
				}
			},
			drafts,
			stripe,
			paidShippingRateId: 'shr_paid_10_eur',
			freeShippingRateId: 'shr_free',
			productionOrigin: ORIGIN,
			allowedCountries: ALLOWED_DESTINATIONS,
			clock: () => new Date(NOW)
		});

		await expectCheckoutCode(
			service.start([{ priceId: medium.priceId, quantity: 1 }]),
			'CHECKOUT_PROVIDER_UNAVAILABLE'
		);

		expect(drafts.creates).toHaveLength(1);
		expect(drafts.attachments).toEqual([]);
	});

	it('expires a created Session and hides its URL when local correlation fails', async () => {
		const drafts = new RecordingDraftRepository();
		drafts.attachFailure = new Error('SQLITE_BUSY: /private/shop.sqlite');
		const stripe = new RecordingStripeGateway();
		const { service } = serviceFixture({ drafts, stripe });

		await expectCheckoutCode(
			service.start([{ priceId: medium.priceId, quantity: 1 }]),
			'CHECKOUT_CORRELATION_FAILED'
		);

		expect(stripe.expirations).toEqual(['cs_test_123']);
	});

	it('keeps the stable correlation error when compensating expiry also fails', async () => {
		const drafts = new RecordingDraftRepository();
		drafts.attachFailure = new Error('CHECKOUT_DRAFT_SESSION_CONFLICT');
		const stripe = new RecordingStripeGateway();
		stripe.expireFailure = new Error('Stripe expiry timeout');
		const { service } = serviceFixture({ drafts, stripe });

		await expectCheckoutCode(
			service.start([{ priceId: medium.priceId, quantity: 1 }]),
			'CHECKOUT_CORRELATION_FAILED'
		);

		expect(stripe.expirations).toEqual(['cs_test_123']);
	});

	it('uses only stable non-secret service errors', () => {
		const error = new CheckoutError('CHECKOUT_PROVIDER_UNAVAILABLE');

		expect(error).toMatchObject({
			name: 'CheckoutError',
			message: 'CHECKOUT_PROVIDER_UNAVAILABLE',
			code: 'CHECKOUT_PROVIDER_UNAVAILABLE'
		});
	});
});

describe('createStripeCheckoutGateway', () => {
	it('constructs the exact Stripe Checkout request and draft-scoped idempotency key', async () => {
		let creation:
			| {
					params: Stripe.Checkout.SessionCreateParams;
					options: Stripe.RequestOptions | undefined;
			  }
			| undefined;
		const client: StripeCheckoutClient = {
			checkout: {
				sessions: {
					async create(params, options) {
						creation = { params: structuredClone(params), options: structuredClone(options) };
						return {
							id: 'cs_test_123',
							url: 'https://checkout.stripe.com/c/pay/cs_test_123'
						};
					},
					async expire(sessionId) {
						return { id: sessionId };
					}
				}
			}
		};
		const gateway = createStripeCheckoutGateway(client);

		await expect(
			gateway.createSession({
				draftId: 'draft_123',
				lines: [
					{ priceId: medium.priceId, quantity: 1 },
					{ priceId: large.priceId, quantity: 2 }
				],
				shippingRateId: 'shr_free',
				allowedCountries: ALLOWED_DESTINATIONS,
				successUrl:
					'https://shop.sveltesociety.dev/checkout/success?session_id={CHECKOUT_SESSION_ID}',
				cancelUrl: 'https://shop.sveltesociety.dev/checkout/cancel'
			})
		).resolves.toEqual({
			id: 'cs_test_123',
			url: 'https://checkout.stripe.com/c/pay/cs_test_123'
		});

		expect(creation).toEqual({
			params: {
				mode: 'payment',
				line_items: [
					{ price: medium.priceId, quantity: 1 },
					{ price: large.priceId, quantity: 2 }
				],
				customer_creation: 'always',
				automatic_tax: { enabled: true },
				tax_id_collection: { enabled: true },
				phone_number_collection: { enabled: true },
				invoice_creation: { enabled: true },
				consent_collection: { terms_of_service: 'required' },
				locale: 'auto',
				shipping_options: [{ shipping_rate: 'shr_free' }],
				shipping_address_collection: { allowed_countries: [...ALLOWED_DESTINATIONS] },
				success_url:
					'https://shop.sveltesociety.dev/checkout/success?session_id={CHECKOUT_SESSION_ID}',
				cancel_url: 'https://shop.sveltesociety.dev/checkout/cancel',
				client_reference_id: 'draft_123',
				metadata: {
					product_type: 'merch',
					checkout_contract_version: String(CHECKOUT_CONTRACT_VERSION),
					checkout_draft_id: 'draft_123'
				},
				payment_intent_data: {
					description: 'Svelte Society merch',
					metadata: {
						product_type: 'merch',
						checkout_contract_version: String(CHECKOUT_CONTRACT_VERSION),
						checkout_draft_id: 'draft_123'
					}
				}
			},
			options: { idempotencyKey: 'checkout-draft:draft_123' }
		});
	});

	it('expires exactly the correlated Checkout Session', async () => {
		const expired: string[] = [];
		const client: StripeCheckoutClient = {
			checkout: {
				sessions: {
					async create() {
						return {
							id: 'cs_test_unused',
							url: 'https://checkout.stripe.com/c/pay/cs_test_unused'
						};
					},
					async expire(sessionId) {
						expired.push(sessionId);
						return { id: sessionId };
					}
				}
			}
		};

		await createStripeCheckoutGateway(client).expireSession('cs_test_123');

		expect(expired).toEqual(['cs_test_123']);
	});

	it.each([
		['missing Session ID', '', 'https://checkout.stripe.com/c/pay/cs_test_valid'],
		['unprefixed Session ID', 'anything', 'https://checkout.stripe.com/c/pay/cs_test_valid'],
		[
			'whitespace in the Session ID',
			'cs_test invalid',
			'https://checkout.stripe.com/c/pay/cs_test_valid'
		],
		[
			'URL-like Session ID',
			'https://checkout.stripe.com/c/pay/cs_test_valid',
			'https://checkout.stripe.com/c/pay/cs_test_valid'
		],
		['missing URL', 'cs_test_valid', null],
		['non-HTTPS URL', 'cs_test_valid', 'javascript:alert(1)'],
		['attacker host', 'cs_test_valid', 'https://attacker.example/c/pay/cs_test_valid'],
		['lookalike host', 'cs_test_valid', 'https://checkout-stripe.com/c/pay/cs_test_valid'],
		[
			'subdomain suffix host',
			'cs_test_valid',
			'https://checkout.stripe.com.attacker.example/c/pay/cs_test_valid'
		],
		[
			'userinfo',
			'cs_test_valid',
			'https://attacker.example@checkout.stripe.com/c/pay/cs_test_valid'
		],
		[
			'surrounding URL whitespace',
			'cs_test_valid',
			' https://checkout.stripe.com/c/pay/cs_test_valid '
		]
	])('rejects a provider response with %s', async (_label, id, url) => {
		const client: StripeCheckoutClient = {
			checkout: {
				sessions: {
					async create() {
						return { id, url };
					},
					async expire(sessionId) {
						return { id: sessionId };
					}
				}
			}
		};

		await expect(
			createStripeCheckoutGateway(client).createSession({
				draftId: 'draft_123',
				lines: [{ priceId: medium.priceId, quantity: 1 }],
				shippingRateId: 'shr_paid_10_eur',
				allowedCountries: ALLOWED_DESTINATIONS,
				successUrl:
					'https://shop.sveltesociety.dev/checkout/success?session_id={CHECKOUT_SESSION_ID}',
				cancelUrl: 'https://shop.sveltesociety.dev/checkout/cancel'
			})
		).rejects.toThrowError('STRIPE_CHECKOUT_SESSION_INVALID');
	});

	it.each([
		[
			'cs_test_a1B2C3_4',
			'https://checkout.stripe.com/c/pay/cs_test_a1B2C3_4#fidkdWxOYHwnPyd1blpxYHZxWjA0'
		],
		['cs_live_Z9y8X7_6', 'https://checkout.stripe.com/c/pay/cs_live_Z9y8X7_6']
	])('accepts a valid Stripe Checkout Session fixture %s', async (id, url) => {
		const client: StripeCheckoutClient = {
			checkout: {
				sessions: {
					async create() {
						return { id, url };
					},
					async expire(sessionId) {
						return { id: sessionId };
					}
				}
			}
		};

		await expect(
			createStripeCheckoutGateway(client).createSession({
				draftId: 'draft_123',
				lines: [{ priceId: medium.priceId, quantity: 1 }],
				shippingRateId: 'shr_paid_10_eur',
				allowedCountries: ALLOWED_DESTINATIONS,
				successUrl:
					'https://shop.sveltesociety.dev/checkout/success?session_id={CHECKOUT_SESSION_ID}',
				cancelUrl: 'https://shop.sveltesociety.dev/checkout/cancel'
			})
		).resolves.toEqual({ id, url });
	});
});
