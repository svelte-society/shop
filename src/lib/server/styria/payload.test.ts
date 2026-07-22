import type { OrderWithLines } from '$lib/domain/orders';
import { describe, expect, it } from 'vitest';
import {
	buildStyriaPayload,
	canonicalJson,
	hashStyriaPayload,
	type StyriaFulfillmentDetails,
	StyriaPayloadError
} from './payload';

function orderFixture(): OrderWithLines {
	return {
		id: 'order_123',
		checkoutSessionId: 'cs_test_checkout_123',
		paymentIntentId: 'pi_test_123',
		customerId: 'cus_test_123',
		checkoutDraftId: 'draft_123',
		currency: 'eur',
		amounts: { subtotal: 5_598, discount: 0, shipping: 1_000, tax: 1_649, total: 8_247 },
		destinationCountry: 'SE',
		paymentStatus: 'paid',
		fulfillmentStatus: 'pending_review',
		styriaOrderId: null,
		styriaStatus: null,
		trackingNumber: null,
		submittedAt: null,
		shippedAt: null,
		lastErrorCode: null,
		updatedAt: new Date('2026-07-17T08:00:00.000Z'),
		lines: [
			{
				orderId: 'order_123',
				lineIndex: 0,
				stripeProductId: 'prod_community_tee',
				stripePriceId: 'price_community_tee_m',
				productName: 'Community Tee',
				variantLabel: 'M',
				sku: 'SS-TEE-M',
				styriaProductNumber: 'STYRIA-TEE-M',
				designReference: 'society-community-v1',
				designPlacements: {
					back: 'https://cdn.example.test/designs/community-back.svg',
					front: 'https://cdn.example.test/designs/community-front.svg'
				},
				quantity: 2,
				unitAmount: 2_799,
				currency: 'eur'
			}
		]
	};
}

function fulfillmentFixture(): StyriaFulfillmentDetails {
	return {
		recipient: {
			firstName: 'Ada',
			lastName: 'Lovelace',
			company: 'Analytical Engines AB',
			phone: '+46 70 123 45 67'
		},
		address: {
			line1: 'Sveltegatan 5',
			line2: 'Suite 3',
			city: 'Stockholm',
			state: 'Stockholm',
			postalCode: '111 22',
			countryCode: 'SE'
		}
	};
}

function build(
	overrides: {
		order?: OrderWithLines;
		fulfillment?: StyriaFulfillmentDetails;
		brandName?: string;
		comment?: string;
		allowedCountries?: readonly string[];
	} = {}
) {
	return buildStyriaPayload({
		order: overrides.order ?? orderFixture(),
		fulfillment: overrides.fulfillment ?? fulfillmentFixture(),
		brandName: overrides.brandName ?? 'Svelte Society',
		comment: overrides.comment ?? 'Approved Svelte Society fulfillment',
		allowedCountries: overrides.allowedCountries
	});
}

describe('buildStyriaPayload', () => {
	it('accepts and preserves an exact Styria embroidery position', () => {
		const order = orderFixture();
		order.lines[0].designPlacements = {
			'Embroidery Centre Chest': 'https://cdn.example.test/designs/community-embroidery.png'
		};

		expect(build({ order }).items[0].designs).toEqual({
			'Embroidery Centre Chest': 'https://cdn.example.test/designs/community-embroidery.png'
		});
	});

	it('builds the exact EU courier payload from immutable checkout snapshots', () => {
		expect(build()).toEqual({
			external_id: 'cs_test_checkout_123',
			brandName: 'Svelte Society',
			comment: 'Approved Svelte Society fulfillment',
			shipping_address: {
				firstName: 'Ada',
				lastName: 'Lovelace',
				company: 'Analytical Engines AB',
				address1: 'Sveltegatan 5',
				address2: 'Suite 3',
				city: 'Stockholm',
				county: 'Stockholm',
				postcode: '111 22',
				country: 'Sweden',
				phone1: '+46 70 123 45 67'
			},
			shipping: { shippingMethod: 'courier' },
			items: [
				{
					pn: 'STYRIA-TEE-M',
					quantity: 2,
					retailPrice: 27.99,
					description: 'Design reference: society-community-v1',
					designs: {
						back: 'https://cdn.example.test/designs/community-back.svg',
						front: 'https://cdn.example.test/designs/community-front.svg'
					}
				}
			]
		});
	});

	it('converts a US address and preserves its required state as county', () => {
		const fulfillment = fulfillmentFixture();
		fulfillment.recipient.company = '';
		fulfillment.address = {
			line1: '123 Broadway',
			line2: '',
			city: 'New York',
			state: 'NY',
			postalCode: '10001',
			countryCode: 'US'
		};

		const order = orderFixture();
		order.destinationCountry = 'US';
		expect(build({ order, fulfillment, allowedCountries: ['US'] }).shipping_address).toEqual({
			firstName: 'Ada',
			lastName: 'Lovelace',
			company: '',
			address1: '123 Broadway',
			address2: '',
			city: 'New York',
			county: 'NY',
			postcode: '10001',
			country: 'United States',
			phone1: '+46 70 123 45 67'
		});
	});

	it('converts an enabled Asian destination and rejects it when omitted from the provider allowlist', () => {
		const fulfillment = fulfillmentFixture();
		fulfillment.address.countryCode = 'JP';
		fulfillment.address.city = 'Tokyo';
		fulfillment.address.postalCode = '100-0001';
		fulfillment.address.state = 'Tokyo';
		const order = orderFixture();
		order.destinationCountry = 'JP';

		expect(
			build({ order, fulfillment, allowedCountries: ['SE', 'JP'] }).shipping_address.country
		).toBe('Japan');
		expect(() => build({ order, fulfillment, allowedCountries: ['SE'] })).toThrowError(
			expect.objectContaining({ code: 'STYRIA_COUNTRY_UNSUPPORTED' })
		);
	});

	it('copies checkout design placements and binds the immutable design reference', () => {
		const order = orderFixture();
		const payload = build({ order });

		order.lines[0].designPlacements.front = 'https://malicious.example.test/changed.svg';

		expect(payload.items[0].designs.front).toBe(
			'https://cdn.example.test/designs/community-front.svg'
		);
		expect(payload.items[0].description).toBe('Design reference: society-community-v1');
		expect(payload.items[0].pn).toBe('STYRIA-TEE-M');
	});

	it.each([
		['first name', (details: StyriaFulfillmentDetails) => (details.recipient.firstName = '')],
		['last name', (details: StyriaFulfillmentDetails) => (details.recipient.lastName = '')],
		['phone', (details: StyriaFulfillmentDetails) => (details.recipient.phone = '')],
		['address line', (details: StyriaFulfillmentDetails) => (details.address.line1 = '')],
		['city', (details: StyriaFulfillmentDetails) => (details.address.city = '')],
		['postcode', (details: StyriaFulfillmentDetails) => (details.address.postalCode = '')],
		['country', (details: StyriaFulfillmentDetails) => (details.address.countryCode = '')]
	])('rejects missing fulfillment %s with a stable error', (_label, mutate) => {
		const fulfillment = fulfillmentFixture();
		mutate(fulfillment);

		expect(() => build({ fulfillment })).toThrowError(
			expect.objectContaining({
				name: 'StyriaPayloadError',
				code: 'STYRIA_FULFILLMENT_INVALID',
				message: 'STYRIA_FULFILLMENT_INVALID'
			})
		);
	});

	it('requires a US state and rejects unsupported country codes', () => {
		const missingState = fulfillmentFixture();
		missingState.address.countryCode = 'US';
		missingState.address.state = '';
		expect(() => build({ fulfillment: missingState })).toThrowError(StyriaPayloadError);

		const unsupported = fulfillmentFixture();
		unsupported.address.countryCode = 'GB';
		const unsupportedOrder = orderFixture();
		unsupportedOrder.destinationCountry = 'GB';
		expect(() => build({ order: unsupportedOrder, fulfillment: unsupported })).toThrowError(
			expect.objectContaining({ code: 'STYRIA_COUNTRY_UNSUPPORTED' })
		);
	});

	it.each([
		['external ID', (order: OrderWithLines) => (order.checkoutSessionId = '')],
		['product number', (order: OrderWithLines) => (order.lines[0].styriaProductNumber = '')],
		['quantity', (order: OrderWithLines) => (order.lines[0].quantity = 0)],
		['price', (order: OrderWithLines) => (order.lines[0].unitAmount = -1)],
		['currency', (order: OrderWithLines) => (order.lines[0].currency = 'usd' as 'eur')],
		['design reference', (order: OrderWithLines) => (order.lines[0].designReference = '')],
		['design placements', (order: OrderWithLines) => (order.lines[0].designPlacements = {})]
	])('rejects missing or invalid line fulfillment data: %s', (_label, mutate) => {
		const order = orderFixture();
		mutate(order);

		expect(() => build({ order })).toThrowError(
			expect.objectContaining({ code: 'STYRIA_ORDER_SNAPSHOT_INVALID' })
		);
	});
});

describe('canonical Styria approval hashing', () => {
	it('recursively sorts object keys while preserving array order', () => {
		expect(canonicalJson({ b: 1, a: { y: 2, x: 3 }, c: [{ z: 2, a: 1 }] })).toBe(
			'{"a":{"x":3,"y":2},"b":1,"c":[{"a":1,"z":2}]}'
		);
	});

	it('uses locale-independent UTF-16 key ordering', () => {
		expect(canonicalJson({ ä: 2, z: 1 })).toBe('{"z":1,"ä":2}');
	});

	it('produces a deterministic lower-case SHA-256 approval hash distinct from SHA-1 auth', () => {
		const first = build();
		const second = {
			items: first.items,
			shipping: first.shipping,
			shipping_address: first.shipping_address,
			comment: first.comment,
			brandName: first.brandName,
			external_id: first.external_id
		};

		expect(hashStyriaPayload(first)).toBe(hashStyriaPayload(second));
		expect(hashStyriaPayload(first)).toMatch(/^[a-f0-9]{64}$/);
		expect(hashStyriaPayload(first)).not.toHaveLength(40);
	});

	it('rejects values that cannot be represented as stable JSON', () => {
		expect(() => canonicalJson({ unsafe: undefined })).toThrowError(
			expect.objectContaining({ code: 'STYRIA_CANONICAL_JSON_INVALID' })
		);
		expect(() => canonicalJson(Number.NaN)).toThrowError(
			expect.objectContaining({ code: 'STYRIA_CANONICAL_JSON_INVALID' })
		);
	});
});
