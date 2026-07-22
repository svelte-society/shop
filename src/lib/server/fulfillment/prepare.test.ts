import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FulfillmentStatus, OrderWithLines, PaymentStatus } from '$lib/domain/orders';
import { migrate } from '$lib/server/db/migrate.server';
import type { ShopDatabase } from '$lib/server/db/types';
import type { FulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import type { FulfillmentDetails, StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import {
	createStripeFulfillmentGateway,
	type StripeFulfillmentClient
} from '$lib/server/stripe/client.server';
import type { StyriaOrderPayload } from '$lib/server/styria/types';
import {
	SqliteApprovalRepository,
	type ApprovalRepository,
	type NewSubmissionApproval
} from './approvals.server';
import { FulfillmentPreparationService, type PreparationResult } from './prepare.server';
import { SqliteFulfillmentRepository } from './repository.server';

const migrationsDirectory = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const now = new Date('2026-07-17T10:00:00.000Z');

function orderFixture(
	overrides: {
		paymentStatus?: PaymentStatus;
		fulfillmentStatus?: FulfillmentStatus;
		destinationCountry?: string;
	} = {}
): OrderWithLines {
	return {
		id: 'order_prepare',
		checkoutSessionId: 'cs_test_prepare',
		paymentIntentId: 'pi_test_prepare',
		customerId: 'cus_test_prepare',
		checkoutDraftId: 'draft_prepare',
		currency: 'eur',
		amounts: {
			subtotal: 5_598,
			discount: 0,
			shipping: 0,
			shippingTax: 0,
			tax: 1_400,
			total: 6_998
		},
		destinationCountry: overrides.destinationCountry ?? 'SE',
		paymentStatus: overrides.paymentStatus ?? 'paid',
		fulfillmentStatus: overrides.fulfillmentStatus ?? 'pending_review',
		styriaOrderId: null,
		styriaStatus: null,
		trackingNumber: null,
		submittedAt: null,
		shippedAt: null,
		updatedAt: new Date('2026-07-17T09:30:00.000Z'),
		lastErrorCode: null,
		lines: [
			{
				orderId: 'order_prepare',
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
				retailUnitAmount: 3_499,
				currency: 'eur'
			}
		]
	};
}

function fulfillmentFixture(): FulfillmentDetails {
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
		},
		email: 'ada@example.test'
	};
}

function expectedPayload(): StyriaOrderPayload {
	return {
		external_id: 'cs_test_prepare',
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
	};
}

class StaticOrderReader implements Pick<FulfillmentRepository, 'inspect'> {
	constructor(readonly order: OrderWithLines | null) {}

	inspect(): ReturnType<FulfillmentRepository['inspect']> {
		return this.order ? { ...structuredClone(this.order), events: [], supportNotes: [] } : null;
	}
}

class CurrentStripeFulfillment implements StripeFulfillmentGateway {
	readonly calls: string[] = [];

	constructor(readonly details = fulfillmentFixture()) {}

	async retrieveFulfillmentDetails(checkoutSessionId: string): Promise<FulfillmentDetails> {
		this.calls.push(checkoutSessionId);
		return structuredClone(this.details);
	}
}

class CapturingApprovals implements ApprovalRepository {
	readonly creates: NewSubmissionApproval[] = [];

	create(input: NewSubmissionApproval): void {
		this.creates.push(structuredClone(input));
	}
}

function service(
	overrides: {
		order?: OrderWithLines | null;
		stripe?: CurrentStripeFulfillment;
		approvals?: ApprovalRepository;
	} = {}
): {
	service: FulfillmentPreparationService;
	stripe: CurrentStripeFulfillment;
	approvals: ApprovalRepository;
} {
	const stripe = overrides.stripe ?? new CurrentStripeFulfillment();
	const approvals = overrides.approvals ?? new CapturingApprovals();
	return {
		service: new FulfillmentPreparationService({
			fulfillment: new StaticOrderReader(
				overrides.order === undefined ? orderFixture() : overrides.order
			),
			stripe,
			approvals,
			brandName: 'Svelte Society',
			comment: 'Approved Svelte Society fulfillment'
		}),
		stripe,
		approvals
	};
}

function expectBlocked(result: PreparationResult, code: string): void {
	expect(result).toEqual(
		expect.objectContaining({
			status: 'blocked',
			approvalId: null,
			expiresAt: null,
			payloadHash: null,
			payload: null,
			blockers: expect.arrayContaining([expect.objectContaining({ code })])
		})
	);
}

describe('fulfillment preparation', () => {
	it('binds approvals to the current Customer business name instead of the stale Session snapshot', async () => {
		const session = {
			id: 'cs_test_prepare',
			object: 'checkout.session',
			customer_details: { business_name: 'Stale Snapshot Company AB' },
			customer: {
				id: 'cus_test_prepare',
				object: 'customer',
				business_name: 'Current Company AB',
				email: 'ada@example.test',
				shipping: {
					name: 'Ada Lovelace',
					phone: '+46 70 123 45 67',
					address: {
						line1: 'Sveltegatan 5',
						line2: 'Suite 3',
						city: 'Stockholm',
						state: 'Stockholm',
						postal_code: '111 22',
						country: 'SE'
					}
				}
			}
		};
		const calls: string[] = [];
		const client: StripeFulfillmentClient = {
			checkout: {
				sessions: {
					async retrieve(checkoutSessionId) {
						calls.push(checkoutSessionId);
						return structuredClone(session);
					}
				}
			}
		};
		const approvals = new CapturingApprovals();
		const preparation = new FulfillmentPreparationService({
			fulfillment: new StaticOrderReader(orderFixture()),
			stripe: createStripeFulfillmentGateway(client),
			approvals,
			brandName: 'Svelte Society',
			comment: 'Approved Svelte Society fulfillment'
		});

		const first = await preparation.prepare('order_prepare', now);
		session.customer.business_name = 'Updated Current Company AB';
		const second = await preparation.prepare('order_prepare', now);

		expect(session.customer_details.business_name).toBe('Stale Snapshot Company AB');
		expect(first.status).toBe('ready');
		expect(second.status).toBe('ready');
		if (first.status !== 'ready' || second.status !== 'ready') throw new Error('Expected ready');
		expect(first.payload.shipping_address.company).toBe('Current Company AB');
		expect(second.payload.shipping_address.company).toBe('Updated Current Company AB');
		expect(second.payloadHash).not.toBe(first.payloadHash);
		expect(approvals.creates.map((approval) => approval.payloadHash)).toEqual([
			first.payloadHash,
			second.payloadHash
		]);
		expect(calls).toEqual(['cs_test_prepare', 'cs_test_prepare']);
	});

	it('prepares the exact Styria payload and a random ten-minute one-use approval', async () => {
		const setup = service();

		const first = await setup.service.prepare('order_prepare', now);
		const second = await setup.service.prepare('order_prepare', now);

		expect(first).toEqual({
			status: 'ready',
			orderId: 'order_prepare',
			approvalId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			expiresAt: '2026-07-17T10:10:00.000Z',
			payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			payload: expectedPayload(),
			warnings: [],
			blockers: []
		});
		expect(second.status).toBe('ready');
		if (first.status !== 'ready' || second.status !== 'ready') throw new Error('Expected ready');
		expect(second.payloadHash).toBe(first.payloadHash);
		expect(second.approvalId).not.toBe(first.approvalId);
		expect(setup.stripe.calls).toEqual(['cs_test_prepare', 'cs_test_prepare']);
		expect((setup.approvals as CapturingApprovals).creates).toEqual([
			{
				approvalId: first.approvalId,
				orderId: 'order_prepare',
				payloadHash: first.payloadHash,
				expiresAt: new Date('2026-07-17T10:10:00.000Z')
			},
			{
				approvalId: second.approvalId,
				orderId: 'order_prepare',
				payloadHash: second.payloadHash,
				expiresAt: new Date('2026-07-17T10:10:00.000Z')
			}
		]);
		expect(JSON.stringify(first)).not.toContain('ada@example.test');
		expect(first.payload).not.toHaveProperty('email');
	});

	it.each([
		['partially_refunded' as const, 'PAYMENT_PARTIALLY_REFUNDED'],
		['refunded' as const, 'PAYMENT_REFUNDED']
	])(
		'warns for %s payment without automatically blocking approval',
		async (paymentStatus, code) => {
			const setup = service({ order: orderFixture({ paymentStatus }) });

			const result = await setup.service.prepare('order_prepare', now);

			expect(result).toEqual(
				expect.objectContaining({
					status: 'ready',
					warnings: [expect.objectContaining({ code })],
					blockers: []
				})
			);
			expect((setup.approvals as CapturingApprovals).creates).toHaveLength(1);
		}
	);

	it.each([
		'submitting',
		'submitted',
		'awaiting_vendor_payment',
		'in_production',
		'shipped',
		'review_required',
		'cancelled'
	] satisfies FulfillmentStatus[])(
		'blocks non-pending fulfillment status %s before Stripe',
		async (status) => {
			const setup = service({ order: orderFixture({ fulfillmentStatus: status }) });

			const result = await setup.service.prepare('order_prepare', now);

			expectBlocked(result, 'FULFILLMENT_STATUS_NOT_PREPARABLE');
			expect(setup.stripe.calls).toEqual([]);
			expect((setup.approvals as CapturingApprovals).creates).toEqual([]);
		}
	);

	it('blocks a missing immutable design before Stripe and creates no approval', async () => {
		const order = orderFixture();
		order.lines[0].designReference = '';
		order.lines[0].designPlacements = {};
		const setup = service({ order });

		const result = await setup.service.prepare('order_prepare', now);

		expectBlocked(result, 'IMMUTABLE_DESIGN_MISSING');
		expect(setup.stripe.calls).toEqual([]);
		expect((setup.approvals as CapturingApprovals).creates).toEqual([]);
	});

	it.each(['GB', 'US'])(
		'blocks unsupported local destination %s before Stripe',
		async (country) => {
			const setup = service({ order: orderFixture({ destinationCountry: country }) });

			const result = await setup.service.prepare('order_prepare', now);

			expectBlocked(result, 'DESTINATION_COUNTRY_UNSUPPORTED');
			expect(setup.stripe.calls).toEqual([]);
			expect((setup.approvals as CapturingApprovals).creates).toEqual([]);
		}
	);

	it('blocks a current Stripe destination mismatch and creates no approval', async () => {
		const details = fulfillmentFixture();
		details.address.countryCode = 'US';
		details.address.state = 'NY';
		const setup = service({ stripe: new CurrentStripeFulfillment(details) });

		const result = await setup.service.prepare('order_prepare', now);

		expectBlocked(result, 'FULFILLMENT_DETAILS_INVALID');
		expect((setup.approvals as CapturingApprovals).creates).toEqual([]);
	});

	it('throws stable redacted errors for missing orders, invalid time, and approval write failures', async () => {
		await expect(
			service({ order: null }).service.prepare('order_prepare', now)
		).rejects.toMatchObject({
			name: 'PreparationError',
			code: 'FULFILLMENT_ORDER_NOT_FOUND',
			message: 'FULFILLMENT_ORDER_NOT_FOUND'
		});
		await expect(
			service().service.prepare('order_prepare', new Date(Number.NaN))
		).rejects.toMatchObject({
			code: 'FULFILLMENT_PREPARATION_INVALID'
		});
		const failure = service({
			approvals: {
				create() {
					throw new Error('ada@example.test Sveltegatan 5 raw sqlite');
				}
			}
		});
		const operation = failure.service.prepare('order_prepare', now);
		await expect(operation).rejects.toMatchObject({
			name: 'PreparationError',
			code: 'SUBMISSION_APPROVAL_CREATE_FAILED',
			message: 'SUBMISSION_APPROVAL_CREATE_FAILED'
		});
		await expect(operation).rejects.not.toThrow(/ada@example|Sveltegatan|raw sqlite/);
	});
});

function seedRealOrder(database: ShopDatabase): void {
	database
		.prepare(
			`INSERT INTO checkout_drafts (
				id, stripe_checkout_session_id, contract_version, currency, total_unit_count,
				shipping_mode, created_at, expires_at, completed_at, destination_country
			) VALUES ('draft_prepare', 'cs_test_prepare', 2, 'eur', 2, 'free', ?, ?, ?, 'SE')`
		)
		.run('2026-07-17T09:00:00.000Z', '2026-07-17T10:00:00.000Z', '2026-07-17T09:30:00.000Z');
	database
		.prepare(
			`INSERT INTO orders (
				id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
				checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
				shipping_tax_amount, tax_amount, total_amount, destination_country, payment_status, fulfillment_status,
				updated_at
			) VALUES (
				'order_prepare', 'cs_test_prepare', 'pi_test_prepare', 'cus_test_prepare',
				'draft_prepare', 'eur', 4000, 0, 0, 0, 1000, 5000, 'SE', 'paid', 'pending_review', ?
			)`
		)
		.run('2026-07-17T09:30:00.000Z');
	database
		.prepare(
			`INSERT INTO order_lines (
				order_id, line_index, stripe_product_id, stripe_price_id, product_name,
				variant_label, sku, styria_product_number, design_reference, design_json,
				quantity, unit_amount, currency, retail_unit_amount
			) VALUES (
				'order_prepare', 0, 'prod_community_tee', 'price_community_tee_m',
				'Community Tee', 'M', 'SS-TEE-M', 'STYRIA-TEE-M', 'society-community-v1',
				'{"back":"https://cdn.example.test/designs/community-back.svg","front":"https://cdn.example.test/designs/community-front.svg"}',
				2, 2000, 'eur', 2500
			)`
		)
		.run();
}

describe('preparation privacy boundary', () => {
	let database: ShopDatabase | undefined;

	afterEach(() => {
		database?.close();
		database = undefined;
	});

	it('seeds an exact two-unit free-shipping v2 snapshot', () => {
		database = new Database(':memory:');
		database.pragma('foreign_keys = ON');
		migrate(database, migrationsDirectory);
		seedRealOrder(database);

		expect(
			database
				.prepare(
					`SELECT subtotal_amount, shipping_amount, shipping_tax_amount, tax_amount, total_amount
					FROM orders WHERE id = 'order_prepare'`
				)
				.get()
		).toEqual({
			subtotal_amount: 4_000,
			shipping_amount: 0,
			shipping_tax_amount: 0,
			tax_amount: 1_000,
			total_amount: 5_000
		});
		expect(
			database
				.prepare(
					`SELECT quantity, unit_amount, retail_unit_amount
					FROM order_lines WHERE order_id = 'order_prepare'`
				)
				.get()
		).toEqual({ quantity: 2, unit_amount: 2_000, retail_unit_amount: 2_500 });
	});

	it('writes only approval metadata to SQLite and never mutates fulfillment status', async () => {
		database = new Database(':memory:');
		database.pragma('foreign_keys = ON');
		migrate(database, migrationsDirectory);
		seedRealOrder(database);
		const preparation = new FulfillmentPreparationService({
			fulfillment: new SqliteFulfillmentRepository(database),
			stripe: new CurrentStripeFulfillment(),
			approvals: new SqliteApprovalRepository(database),
			brandName: 'Svelte Society',
			comment: 'Approved Svelte Society fulfillment'
		});

		await expect(preparation.prepare('order_prepare', now)).resolves.toMatchObject({
			status: 'ready'
		});

		const tableNames = database
			.prepare(
				`SELECT name FROM sqlite_schema
				WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
			)
			.all()
			.map((row) => (row as { name: string }).name);
		const persisted = JSON.stringify(
			tableNames.map((table) => ({
				table,
				rows: database?.prepare(`SELECT * FROM ${table}`).all()
			}))
		);
		expect(persisted).not.toMatch(
			/ada@example\.test|Ada|Lovelace|Analytical Engines|Sveltegatan|Stockholm|111 22|\+46 70/
		);
		expect(database.prepare('SELECT count(*) AS count FROM submission_approvals').get()).toEqual({
			count: 1
		});
		expect(
			database.prepare('SELECT fulfillment_status FROM orders WHERE id = ?').get('order_prepare')
		).toEqual({ fulfillment_status: 'pending_review' });
		expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
			count: 0
		});
	});
});
