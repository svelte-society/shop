import Database from 'better-sqlite3';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
	NewCheckoutDraft,
	NewOutboxJob,
	PaidOrderInput,
	StripeEventInput
} from '$lib/domain/orders';
import { SqliteOrderEventRepository } from '$lib/server/audit/order-events.server';
import { SqliteCheckoutDraftRepository } from './checkout-drafts.server';
import { closeDatabase, openDatabase } from './connection.server';
import { migrate } from './migrate.server';
import { SqliteOrderRepository, SqlitePaidOrderUnitOfWork } from './orders.server';
import { SqliteOutboxRepository } from './outbox.server';
import { SqliteStripeEventRepository } from './stripe-events.server';
import type { ShopDatabase } from './types';

const migrationsDirectory = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const claimContenderPath = fileURLToPath(
	new URL('./repositories.claim-contender.mjs', import.meta.url)
);
const now = new Date('2026-07-16T08:30:00.000Z');

type ClaimContender = {
	child: ChildProcessWithoutNullStreams;
	completion: Promise<string[]>;
};

async function waitForFiles(paths: readonly string[]): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!paths.every(existsSync)) {
		if (Date.now() >= deadline) throw new Error('CLAIM_TEST_BARRIER_TIMEOUT');
		await delay(2);
	}
}

function spawnClaimContender(
	databasePath: string,
	paths: { ready: string; start: string; attempt: string; result: string }
): ClaimContender {
	const child = spawn(process.execPath, [claimContenderPath], {
		cwd: process.cwd(),
		env: {
			...process.env,
			SHOP_DB_PATH: databasePath,
			CLAIM_READY_PATH: paths.ready,
			CLAIM_START_PATH: paths.start,
			CLAIM_ATTEMPT_PATH: paths.attempt,
			CLAIM_RESULT_PATH: paths.result,
			CLAIM_NOW: now.toISOString()
		}
	});
	let stderr = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	const completion = new Promise<string[]>((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error('CLAIM_CONTENDER_TIMEOUT'));
		}, 10_000);
		child.once('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once('exit', (code) => {
			clearTimeout(timeout);
			if (code !== 0) {
				reject(new Error(`CLAIM_CONTENDER_FAILED:${code}:${stderr.trim()}`));
				return;
			}
			resolve(JSON.parse(readFileSync(paths.result, 'utf8')) as string[]);
		});
	});
	void completion.catch(() => undefined);
	return { child, completion };
}

function draftInput(overrides: Partial<NewCheckoutDraft> = {}): NewCheckoutDraft {
	return {
		contractVersion: 2,
		destinationCountry: 'SE',
		currency: 'eur',
		totalUnitCount: 2,
		shippingMode: 'free',
		shippingRateId: 'shr_free',
		shippingNetAmount: 0,
		createdAt: new Date('2026-07-16T08:00:00.000Z'),
		expiresAt: new Date('2026-07-16T09:00:00.000Z'),
		lines: [
			{
				stripeProductId: 'prod_tee',
				stripePriceId: 'price_tee_m',
				productName: 'Community Tee',
				variantLabel: 'M',
				sku: 'SS-TEE-M',
				styriaProductNumber: 'STYRIA-TEE-M',
				designReference: 'society-community-v1',
				designPlacements: {
					front: 'https://cdn.example.com/designs/front.svg',
					back: 'https://cdn.example.com/designs/back.svg'
				},
				productionDetails: {
					mockupPlacements: {
						front: 'https://cdn.example.com/mockups/front.png'
					},
					threadColors: { front: ['Orange (#FC4C02)', 'White (#FFFFFF)'] }
				},
				quantity: 2,
				unitAmount: 2_000,
				currency: 'eur'
			}
		],
		...overrides
	};
}

function paidOrderInput(draftId: string, overrides: Partial<PaidOrderInput> = {}): PaidOrderInput {
	return {
		checkoutSessionId: 'cs_paid',
		paymentIntentId: 'pi_paid',
		customerId: 'cus_paid',
		checkoutDraftId: draftId,
		currency: 'eur',
		amounts: {
			subtotal: 4_000,
			discount: 0,
			shipping: 0,
			shippingTax: 0,
			tax: 1_000,
			total: 5_000
		},
		destinationCountry: 'SE',
		updatedAt: now,
		lines: [
			{
				stripePriceId: 'price_tee_m',
				quantity: 2,
				unitAmount: 2_000,
				retailUnitAmount: 2_500
			}
		],
		...overrides
	};
}

function stripeEventInput(overrides: Partial<StripeEventInput> = {}): StripeEventInput {
	return {
		eventId: 'evt_paid',
		eventType: 'checkout.session.completed',
		processedAt: now,
		...overrides
	};
}

function outboxInput(overrides: Partial<NewOutboxJob> = {}): NewOutboxJob {
	return {
		kind: 'paid-order-alert',
		idempotencyKey: 'paid-order-alert:order-test',
		orderId: null,
		nextAttemptAt: now,
		...overrides
	};
}

let database: ShopDatabase;
let drafts: SqliteCheckoutDraftRepository;
let orders: SqliteOrderRepository;
let stripeEvents: SqliteStripeEventRepository;
let outbox: SqliteOutboxRepository;

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, migrationsDirectory);
	drafts = new SqliteCheckoutDraftRepository(database);
	orders = new SqliteOrderRepository(database);
	stripeEvents = new SqliteStripeEventRepository(database);
	outbox = new SqliteOutboxRepository(database);
});

afterEach(() => {
	closeDatabase();
});

describe('SqliteCheckoutDraftRepository', () => {
	it('persists immutable line snapshots with canonical JSON and detached values', () => {
		const input = draftInput();
		const created = drafts.create(input);
		input.lines[0].productName = 'Changed after create';
		input.lines[0].designPlacements.front = 'https://malicious.example/changed.svg';
		input.lines[0].productionDetails!.threadColors.front[0] = 'Changed';

		const found = drafts.findById(created.id);
		expect(found).toEqual(expect.objectContaining(created));
		expect(found).toMatchObject({
			shippingMode: 'free',
			shippingRateId: 'shr_free',
			shippingNetAmount: 0
		});
		expect(found?.lines).toEqual([
			expect.objectContaining({
				lineIndex: 0,
				productName: 'Community Tee',
				designPlacements: {
					back: 'https://cdn.example.com/designs/back.svg',
					front: 'https://cdn.example.com/designs/front.svg'
				},
				productionDetails: {
					mockupPlacements: { front: 'https://cdn.example.com/mockups/front.png' },
					threadColors: { front: ['Orange (#FC4C02)', 'White (#FFFFFF)'] }
				}
			})
		]);
		expect(
			(
				database
					.prepare('SELECT production_json FROM checkout_draft_lines WHERE draft_id = ?')
					.get(created.id) as { production_json: string }
			).production_json
		).toBe(
			'{"mockupPlacements":{"front":"https://cdn.example.com/mockups/front.png"},"threadColors":{"front":["Orange (#FC4C02)","White (#FFFFFF)"]}}'
		);
		expect(
			(
				database
					.prepare('SELECT design_json FROM checkout_draft_lines WHERE draft_id = ?')
					.get(created.id) as { design_json: string }
			).design_json
		).toBe(
			'{"back":"https://cdn.example.com/designs/back.svg","front":"https://cdn.example.com/designs/front.svg"}'
		);
	});

	it('requires contract v2 and a valid market destination when creating or mapping drafts', () => {
		expect(() => drafts.create(draftInput({ contractVersion: 1 }))).toThrowError(
			'CHECKOUT_DRAFT_INVALID'
		);
		expect(() =>
			drafts.create(
				draftInput({ destinationCountry: 'US' as NewCheckoutDraft['destinationCountry'] })
			)
		).toThrowError('CHECKOUT_DRAFT_INVALID');
		const draft = drafts.create(draftInput());
		expect(draft).toMatchObject({ contractVersion: 2, destinationCountry: 'SE' });
		database
			.prepare('UPDATE checkout_drafts SET destination_country = ? WHERE id = ?')
			.run('ZZ', draft.id);
		expect(() => drafts.findById(draft.id)).toThrowError('CHECKOUT_DRAFT_ROW_INVALID');
	});

	it('rejects malformed design JSON, unsafe cents, inconsistent totals, and invalid timestamps', () => {
		expect(() =>
			drafts.create(
				draftInput({
					lines: [
						{
							...draftInput().lines[0],
							designPlacements: { front: undefined } as unknown as Record<string, string>
						}
					]
				})
			)
		).toThrowError('CHECKOUT_DRAFT_INVALID');
		expect(() =>
			drafts.create(draftInput({ lines: [{ ...draftInput().lines[0], unitAmount: 20.5 }] }))
		).toThrowError('CHECKOUT_DRAFT_INVALID');
		expect(() => drafts.create(draftInput({ totalUnitCount: 1 }))).toThrowError(
			'CHECKOUT_DRAFT_INVALID'
		);
		expect(() => drafts.create(draftInput({ createdAt: new Date(Number.NaN) }))).toThrowError(
			'CHECKOUT_DRAFT_INVALID'
		);
		expect(() => drafts.create(draftInput({ shippingRateId: '' }))).toThrowError(
			'CHECKOUT_DRAFT_INVALID'
		);
		expect(() =>
			drafts.create(draftInput({ shippingNetAmount: Number.MAX_SAFE_INTEGER + 1 }))
		).toThrowError('CHECKOUT_DRAFT_INVALID');
		expect(() =>
			drafts.create(
				draftInput({
					totalUnitCount: 1,
					shippingMode: 'paid',
					shippingRateId: 'shr_paid',
					shippingNetAmount: 0,
					lines: [{ ...draftInput().lines[0], quantity: 1 }]
				})
			)
		).toThrowError('CHECKOUT_DRAFT_INVALID');
		expect(() => drafts.create(draftInput({ shippingNetAmount: 1 }))).toThrowError(
			'CHECKOUT_DRAFT_INVALID'
		);
	});

	it('rejects a corrupted stored shipping snapshot at the row boundary', () => {
		const draft = drafts.create(draftInput());
		database.exec('DROP TRIGGER checkout_drafts_shipping_required_update');
		database
			.prepare('UPDATE checkout_drafts SET shipping_net_amount = ? WHERE id = ?')
			.run(1, draft.id);

		expect(() => drafts.findById(draft.id)).toThrowError('CHECKOUT_DRAFT_ROW_INVALID');
	});

	it('attaches one unique Checkout Session idempotently and reports stable conflicts', () => {
		const first = drafts.create(draftInput());
		const second = drafts.create(draftInput());

		drafts.attachSession(first.id, 'cs_shared');
		drafts.attachSession(first.id, 'cs_shared');
		expect(drafts.findById(first.id)?.checkoutSessionId).toBe('cs_shared');
		expect(() => drafts.attachSession(first.id, 'cs_other')).toThrowError(
			'CHECKOUT_DRAFT_SESSION_CONFLICT'
		);
		expect(() => drafts.attachSession(second.id, 'cs_shared')).toThrowError(
			'CHECKOUT_SESSION_CONFLICT'
		);
		expect(() => drafts.attachSession('draft_missing', 'cs_missing')).toThrowError(
			'CHECKOUT_DRAFT_NOT_FOUND'
		);
	});

	it('translates an unexpected SQLite attach failure to a stable repository error', () => {
		const draft = drafts.create(draftInput());
		database.exec(`
			CREATE TRIGGER reject_session_attach BEFORE UPDATE OF stripe_checkout_session_id
			ON checkout_drafts
			BEGIN
				SELECT RAISE(ABORT, 'raw attach failure');
			END
		`);

		expect(() => drafts.attachSession(draft.id, 'cs_failed')).toThrowError(
			'CHECKOUT_DRAFT_SESSION_ATTACH_FAILED'
		);
		expect(drafts.findById(draft.id)?.checkoutSessionId).toBeNull();
	});

	it('marks completion once without allowing completion time to regress or change', () => {
		const draft = drafts.create(draftInput());
		expect(() => drafts.markCompleted(draft.id, new Date('2026-07-16T07:59:59.999Z'))).toThrowError(
			'CHECKOUT_DRAFT_COMPLETION_INVALID'
		);
		drafts.markCompleted(draft.id, now);
		drafts.markCompleted(draft.id, new Date(now));
		expect(drafts.findById(draft.id)?.completedAt).toEqual(now);
		expect(() => drafts.markCompleted(draft.id, new Date('2026-07-16T08:31:00.000Z'))).toThrowError(
			'CHECKOUT_DRAFT_COMPLETION_CONFLICT'
		);
		expect(() => drafts.markCompleted('draft_missing', now)).toThrowError(
			'CHECKOUT_DRAFT_NOT_FOUND'
		);
	});

	it('translates an unexpected SQLite completion failure to a stable repository error', () => {
		const draft = drafts.create(draftInput());
		database.exec(`
			CREATE TRIGGER reject_draft_completion BEFORE UPDATE OF completed_at
			ON checkout_drafts
			BEGIN
				SELECT RAISE(ABORT, 'raw completion failure');
			END
		`);

		expect(() => drafts.markCompleted(draft.id, now)).toThrowError(
			'CHECKOUT_DRAFT_COMPLETION_FAILED'
		);
		expect(drafts.findById(draft.id)?.completedAt).toBeNull();
	});

	it('rejects non-canonical or malformed stored design JSON at the row boundary', () => {
		const draft = drafts.create(draftInput());
		database
			.prepare('UPDATE checkout_draft_lines SET design_json = ? WHERE draft_id = ?')
			.run('{"front":null}', draft.id);
		expect(() => drafts.findById(draft.id)).toThrowError('CHECKOUT_DRAFT_ROW_INVALID');
	});
});

describe('SqliteStripeEventRepository', () => {
	it('claims new events, recovers an immediate duplicate, retries failures, and converges completion', () => {
		expect(stripeEvents.begin('evt_one', 'checkout.session.completed', now)).toBe('new');
		expect(stripeEvents.begin('evt_one', 'checkout.session.completed', now)).toBe('retry');

		stripeEvents.fail('evt_one', 'STRIPE_RETRIEVE_FAILED');
		expect(
			stripeEvents.begin(
				'evt_one',
				'checkout.session.completed',
				new Date('2026-07-16T08:31:00.000Z')
			)
		).toBe('retry');
		stripeEvents.complete(
			'evt_one',
			{ checkoutSessionId: 'cs_paid', paymentIntentId: 'pi_paid' },
			new Date('2026-07-16T08:32:00.000Z')
		);
		expect(
			stripeEvents.begin(
				'evt_one',
				'checkout.session.completed',
				new Date('2026-07-16T08:33:00.000Z')
			)
		).toBe('completed');
		expect(
			database.prepare('SELECT * FROM stripe_events WHERE stripe_event_id = ?').get('evt_one')
		).toEqual({
			stripe_event_id: 'evt_one',
			event_type: 'checkout.session.completed',
			processing_status: 'completed',
			stripe_checkout_session_id: 'cs_paid',
			stripe_payment_intent_id: 'pi_paid',
			last_error_code: null,
			first_seen_at: '2026-07-16T08:30:00.000Z',
			completed_at: '2026-07-16T08:32:00.000Z'
		});
	});

	it('recovers an abandoned processing event after a repository reconnect', () => {
		closeDatabase();
		const directory = mkdtempSync(join(tmpdir(), 'shop-stripe-event-'));
		const path = join(directory, 'shop.sqlite');
		const firstDatabase = new Database(path);
		try {
			firstDatabase.pragma('journal_mode = WAL');
			firstDatabase.pragma('foreign_keys = ON');
			firstDatabase.pragma('busy_timeout = 5000');
			migrate(firstDatabase, migrationsDirectory);
			expect(
				new SqliteStripeEventRepository(firstDatabase).begin(
					'evt_abandoned',
					'checkout.session.completed',
					now
				)
			).toBe('new');
		} finally {
			firstDatabase.close();
		}

		const restartedDatabase = new Database(path);
		try {
			restartedDatabase.pragma('foreign_keys = ON');
			restartedDatabase.pragma('busy_timeout = 5000');
			expect(
				new SqliteStripeEventRepository(restartedDatabase).begin(
					'evt_abandoned',
					'checkout.session.completed',
					new Date('2026-07-16T08:35:00.000Z')
				)
			).toBe('retry');
			expect(
				restartedDatabase
					.prepare(
						'SELECT processing_status, first_seen_at, completed_at FROM stripe_events WHERE stripe_event_id = ?'
					)
					.get('evt_abandoned')
			).toEqual({
				processing_status: 'processing',
				first_seen_at: '2026-07-16T08:30:00.000Z',
				completed_at: null
			});
		} finally {
			restartedDatabase.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('never changes an event type or regresses a completed event', () => {
		stripeEvents.begin('evt_one', 'checkout.session.completed', now);
		expect(() => stripeEvents.begin('evt_one', 'charge.refunded', now)).toThrowError(
			'STRIPE_EVENT_TYPE_CONFLICT'
		);
		stripeEvents.complete(
			'evt_one',
			{ checkoutSessionId: 'cs_paid', paymentIntentId: 'pi_paid' },
			now
		);
		stripeEvents.complete(
			'evt_one',
			{ checkoutSessionId: 'cs_paid', paymentIntentId: 'pi_paid' },
			new Date(now)
		);
		expect(() => stripeEvents.fail('evt_one', 'LATE_FAILURE')).toThrowError(
			'STRIPE_EVENT_STATE_CONFLICT'
		);
		expect(() =>
			stripeEvents.complete(
				'evt_one',
				{ checkoutSessionId: 'cs_different', paymentIntentId: 'pi_paid' },
				now
			)
		).toThrowError('STRIPE_EVENT_REFERENCE_CONFLICT');
	});

	it('rejects a completion timestamp earlier than first sight of the event', () => {
		stripeEvents.begin('evt_one', 'checkout.session.completed', now);
		expect(() =>
			stripeEvents.complete(
				'evt_one',
				{ checkoutSessionId: 'cs_paid', paymentIntentId: 'pi_paid' },
				new Date('2026-07-16T08:29:59.999Z')
			)
		).toThrowError('STRIPE_EVENT_COMPLETION_INVALID');
		expect(
			database.prepare('SELECT processing_status, completed_at FROM stripe_events').get()
		).toEqual({
			processing_status: 'processing',
			completed_at: null
		});
	});

	it('persists only stable error codes rather than raw failure text', () => {
		stripeEvents.begin('evt_one', 'checkout.session.completed', now);
		expect(() =>
			stripeEvents.fail('evt_one', 'Stripe said customer@example.com was invalid')
		).toThrowError('STRIPE_EVENT_FAILURE_INVALID');
		expect(
			database.prepare('SELECT processing_status, last_error_code FROM stripe_events').get()
		).toEqual({
			processing_status: 'processing',
			last_error_code: null
		});
	});
});

describe('SqliteOrderRepository', () => {
	it('creates a paid order once and converges only identical provider identities', () => {
		const draft = drafts.create(draftInput());
		drafts.attachSession(draft.id, 'cs_paid');
		const input = paidOrderInput(draft.id);

		const created = orders.createPaidOrder(input);
		expect(created.amounts).toEqual({
			subtotal: 4_000,
			discount: 0,
			shipping: 0,
			shippingTax: 0,
			tax: 1_000,
			total: 5_000
		});
		expect(orders.createPaidOrder(input)).toEqual(created);
		expect(orders.findByCheckoutSession('cs_paid')).toEqual({ ...created, lines: [] });
		expect(() =>
			orders.createPaidOrder({ ...input, paymentIntentId: 'pi_different' })
		).toThrowError('ORDER_PROVIDER_CONFLICT');
		expect(() =>
			orders.createPaidOrder({
				...input,
				amounts: { ...input.amounts, tax: 500, total: 4_500 },
				lines: [{ ...input.lines[0], retailUnitAmount: 2_250 }]
			})
		).toThrowError('ORDER_DATA_CONFLICT');
	});

	it('enforces integer cents, amount arithmetic, supported countries, and draft correlation', () => {
		const draft = drafts.create(draftInput());
		drafts.attachSession(draft.id, 'cs_paid');
		const input = paidOrderInput(draft.id);

		expect(() =>
			orders.createPaidOrder({
				...input,
				amounts: { ...input.amounts, total: 5_000.5 }
			})
		).toThrowError('PAID_ORDER_INVALID');
		expect(() =>
			orders.createPaidOrder({
				...input,
				amounts: { ...input.amounts, total: 4_999 }
			})
		).toThrowError('PAID_ORDER_INVALID');
		expect(() =>
			orders.createPaidOrder({
				...input,
				amounts: { ...input.amounts, shipping: 100, shippingTax: 101, total: 5_100 }
			})
		).toThrowError('PAID_ORDER_INVALID');
		expect(() =>
			orders.createPaidOrder({
				...input,
				amounts: { ...input.amounts, shippingTax: 1_001 }
			})
		).toThrowError('PAID_ORDER_INVALID');
		expect(() =>
			orders.createPaidOrder({
				...input,
				lines: [{ ...input.lines[0], retailUnitAmount: input.lines[0].retailUnitAmount - 1 }]
			})
		).toThrowError('PAID_ORDER_INVALID');
		expect(() => orders.createPaidOrder({ ...input, destinationCountry: 'US' })).toThrowError(
			'PAID_ORDER_INVALID'
		);
		expect(() =>
			orders.createPaidOrder({ ...input, checkoutSessionId: 'cs_uncorrelated' })
		).toThrowError('ORDER_DRAFT_CORRELATION_FAILED');
		expect(() =>
			orders.createPaidOrder({
				...input,
				updatedAt: new Date('2026-07-16T07:59:59.999Z')
			})
		).toThrowError('ORDER_TIMESTAMP_REGRESSION');
	});

	it('advances payment status monotonically without mutating fulfillment status', () => {
		const draft = drafts.create(draftInput());
		drafts.attachSession(draft.id, 'cs_paid');
		orders.createPaidOrder(paidOrderInput(draft.id));
		database
			.prepare(
				"UPDATE orders SET fulfillment_status = 'in_production' WHERE stripe_payment_intent_id = ?"
			)
			.run('pi_paid');

		orders.updatePaymentStatus(
			'pi_paid',
			'partially_refunded',
			new Date('2026-07-16T09:00:00.000Z')
		);
		orders.updatePaymentStatus('pi_paid', 'refunded', new Date('2026-07-16T10:00:00.000Z'));
		orders.updatePaymentStatus('pi_paid', 'refunded', new Date('2026-07-16T11:00:00.000Z'));
		const order = orders.findByCheckoutSession('cs_paid');
		expect(order).toEqual(
			expect.objectContaining({
				paymentStatus: 'refunded',
				fulfillmentStatus: 'in_production',
				updatedAt: new Date('2026-07-16T10:00:00.000Z')
			})
		);
		expect(() => orders.updatePaymentStatus('pi_paid', 'paid', now)).toThrowError(
			'PAYMENT_STATUS_REGRESSION'
		);
		expect(() => orders.updatePaymentStatus('pi_missing', 'refunded', now)).toThrowError(
			'ORDER_NOT_FOUND'
		);
	});
});

describe('SqlitePaidOrderUnitOfWork', () => {
	it('atomically creates or converges the order, lines, draft, audit, outbox, and Stripe event', () => {
		const draft = drafts.create(draftInput());
		drafts.attachSession(draft.id, 'cs_paid');
		expect(stripeEvents.begin('evt_paid', 'checkout.session.completed', now)).toBe('new');
		expect(
			new SqliteStripeEventRepository(database).begin('evt_paid', 'checkout.session.completed', now)
		).toBe('retry');
		const unitOfWork = new SqlitePaidOrderUnitOfWork(database);
		const input = paidOrderInput(draft.id);
		const event = stripeEventInput();

		const order = unitOfWork.commitPaidOrder(input, event);
		expect(unitOfWork.commitPaidOrder(input, event)).toEqual(order);
		expect(orders.findByCheckoutSession('cs_paid')).toEqual({
			...order,
			lines: [
				expect.objectContaining({
					lineIndex: 0,
					orderId: order.id,
					stripePriceId: 'price_tee_m',
					quantity: 2,
					unitAmount: 2_000,
					retailUnitAmount: 2_500
				})
			]
		});
		expect(drafts.findById(draft.id)?.completedAt).toEqual(now);
		expect(
			database
				.prepare(
					'SELECT actor, action, prior_state, next_state, result, error_code, created_at FROM order_events'
				)
				.all()
		).toEqual([
			{
				actor: 'stripe-webhook',
				action: 'paid_order_recorded',
				prior_state: null,
				next_state: 'pending_review',
				result: 'succeeded',
				error_code: null,
				created_at: '2026-07-16T08:30:00.000Z'
			}
		]);
		expect(
			database
				.prepare(
					'SELECT kind, idempotency_key, order_id, attempt_count, next_attempt_at, completed_at, last_error_code FROM outbox_jobs'
				)
				.all()
		).toEqual([
			{
				kind: 'paid-order-alert',
				idempotency_key: `paid-order-alert:${order.id}`,
				order_id: order.id,
				attempt_count: 0,
				next_attempt_at: '2026-07-16T08:30:00.000Z',
				completed_at: null,
				last_error_code: null
			}
		]);
		expect(
			database
				.prepare(
					'SELECT processing_status, stripe_checkout_session_id, stripe_payment_intent_id, completed_at FROM stripe_events WHERE stripe_event_id = ?'
				)
				.get('evt_paid')
		).toEqual({
			processing_status: 'completed',
			stripe_checkout_session_id: 'cs_paid',
			stripe_payment_intent_id: 'pi_paid',
			completed_at: '2026-07-16T08:30:00.000Z'
		});
	});

	it('rejects a completed-event replay when its persisted paid line snapshot diverges', () => {
		const draft = drafts.create(draftInput());
		drafts.attachSession(draft.id, 'cs_paid');
		stripeEvents.begin('evt_paid', 'checkout.session.completed', now);
		const unitOfWork = new SqlitePaidOrderUnitOfWork(database);
		const input = paidOrderInput(draft.id);
		const event = stripeEventInput();
		const order = unitOfWork.commitPaidOrder(input, event);
		database
			.prepare('UPDATE order_lines SET retail_unit_amount = ? WHERE order_id = ?')
			.run(2_499, order.id);

		expect(() => unitOfWork.commitPaidOrder(input, event)).toThrowError('ORDER_LINE_CONFLICT');
	});

	it('audits each distinct paid event while converging existing order and outbox state', () => {
		const draft = drafts.create(draftInput());
		drafts.attachSession(draft.id, 'cs_paid');
		stripeEvents.begin('evt_paid', 'checkout.session.completed', now);
		const unitOfWork = new SqlitePaidOrderUnitOfWork(database);
		const input = paidOrderInput(draft.id);
		const order = unitOfWork.commitPaidOrder(input, stripeEventInput());
		const later = new Date('2026-07-16T08:35:00.000Z');
		stripeEvents.begin('evt_paid_async', 'checkout.session.async_payment_succeeded', later);

		expect(
			unitOfWork.commitPaidOrder(
				{ ...input, updatedAt: later },
				stripeEventInput({
					eventId: 'evt_paid_async',
					eventType: 'checkout.session.async_payment_succeeded',
					processedAt: later
				})
			)
		).toEqual(order);
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 1 });
		expect(database.prepare('SELECT count(*) AS count FROM order_lines').get()).toEqual({
			count: 1
		});
		expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
			count: 2
		});
		expect(database.prepare('SELECT count(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 1
		});
		expect(
			database.prepare('SELECT action, prior_state, next_state FROM order_events ORDER BY id').all()
		).toEqual([
			{ action: 'paid_order_recorded', prior_state: null, next_state: 'pending_review' },
			{
				action: 'paid_order_converged',
				prior_state: 'pending_review',
				next_state: 'pending_review'
			}
		]);
	});

	it('rolls back every commercial write when a late outbox write fails', () => {
		const draft = drafts.create(draftInput());
		drafts.attachSession(draft.id, 'cs_paid');
		stripeEvents.begin('evt_paid', 'checkout.session.completed', now);
		database.exec(`
			CREATE TRIGGER reject_paid_alert BEFORE INSERT ON outbox_jobs
			WHEN NEW.kind = 'paid-order-alert'
			BEGIN
				SELECT RAISE(ABORT, 'test late failure');
			END
		`);

		expect(() =>
			new SqlitePaidOrderUnitOfWork(database).commitPaidOrder(
				paidOrderInput(draft.id),
				stripeEventInput()
			)
		).toThrowError('PAID_ORDER_COMMIT_FAILED');
		expect(database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({ count: 0 });
		expect(database.prepare('SELECT count(*) AS count FROM order_lines').get()).toEqual({
			count: 0
		});
		expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
			count: 0
		});
		expect(database.prepare('SELECT count(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 0
		});
		expect(drafts.findById(draft.id)?.completedAt).toBeNull();
		expect(
			database
				.prepare('SELECT processing_status FROM stripe_events WHERE stripe_event_id = ?')
				.get('evt_paid')
		).toEqual({
			processing_status: 'processing'
		});
	});
});

describe('SqliteOutboxRepository', () => {
	it('enqueues an identical idempotency key once and rejects conflicting reuse', () => {
		const input = outboxInput();
		outbox.enqueue(input);
		outbox.enqueue(input);
		const [claimed] = outbox.claimDue(now, 1);
		outbox.reschedule(claimed.id, 1, new Date('2026-07-16T08:35:00.000Z'), 'PLUNK_UNAVAILABLE');
		outbox.enqueue(input);
		expect(database.prepare('SELECT count(*) AS count FROM outbox_jobs').get()).toEqual({
			count: 1
		});
		expect(() => outbox.enqueue({ ...input, kind: 'shipping' })).toThrowError(
			'OUTBOX_IDEMPOTENCY_CONFLICT'
		);
	});

	it('claims only due jobs in stable order and temporarily excludes them from another claim', () => {
		outbox.enqueue(
			outboxInput({
				idempotencyKey: 'due-later-id',
				nextAttemptAt: new Date('2026-07-16T08:29:00.000Z')
			})
		);
		outbox.enqueue(
			outboxInput({
				idempotencyKey: 'due-first-id',
				nextAttemptAt: new Date('2026-07-16T08:28:00.000Z')
			})
		);
		outbox.enqueue(
			outboxInput({
				idempotencyKey: 'future-id',
				nextAttemptAt: new Date('2026-07-16T08:31:00.000Z')
			})
		);

		const claimed = outbox.claimDue(now, 2);
		expect(claimed.map((job) => job.idempotencyKey)).toEqual(['due-first-id', 'due-later-id']);
		expect(claimed.every((job) => job.nextAttemptAt > now)).toBe(true);
		expect(outbox.claimDue(now, 2)).toEqual([]);
	});

	it('serializes overlapping claims across barrier-synchronized Node processes', async () => {
		closeDatabase();
		const directory = mkdtempSync(join(tmpdir(), 'shop-outbox-'));
		const path = join(directory, 'shop.sqlite');
		const lockDatabase = new Database(path);
		const startPath = join(directory, 'start');
		const contenderPaths = [0, 1].map((index) => ({
			ready: join(directory, `ready-${index}`),
			start: startPath,
			attempt: join(directory, `attempt-${index}`),
			result: join(directory, `result-${index}.json`)
		}));
		let contenders: ClaimContender[] = [];
		try {
			lockDatabase.pragma('journal_mode = WAL');
			lockDatabase.pragma('foreign_keys = ON');
			lockDatabase.pragma('busy_timeout = 5000');
			migrate(lockDatabase, migrationsDirectory);
			new SqliteOutboxRepository(lockDatabase).enqueue(
				outboxInput({ idempotencyKey: 'shared-due-id' })
			);
			lockDatabase.exec('BEGIN IMMEDIATE');
			contenders = contenderPaths.map((paths) => spawnClaimContender(path, paths));
			await waitForFiles(contenderPaths.map((paths) => paths.ready));
			writeFileSync(startPath, 'start', { flag: 'wx' });
			await waitForFiles(contenderPaths.map((paths) => paths.attempt));
			lockDatabase.exec('COMMIT');

			const results = await Promise.all(contenders.map((contender) => contender.completion));
			expect(results.map((result) => result.length).sort()).toEqual([0, 1]);
			expect(results.flat()).toEqual(['shared-due-id']);
		} finally {
			if (lockDatabase.inTransaction) lockDatabase.exec('ROLLBACK');
			for (const contender of contenders) contender.child.kill();
			await Promise.allSettled(contenders.map((contender) => contender.completion));
			lockDatabase.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 15_000);

	it('reschedules monotonically and completes without resurrecting a job', () => {
		outbox.enqueue(outboxInput());
		const [job] = outbox.claimDue(now, 1);
		const retryAt = new Date('2026-07-16T08:35:00.000Z');
		outbox.reschedule(job.id, 1, retryAt, 'PLUNK_UNAVAILABLE');
		expect(() => outbox.reschedule(job.id, 1, retryAt, 'PLUNK_UNAVAILABLE')).toThrowError(
			'OUTBOX_ATTEMPT_REGRESSION'
		);
		outbox.complete(job.id, new Date('2026-07-16T08:36:00.000Z'));
		outbox.complete(job.id, new Date('2026-07-16T08:37:00.000Z'));
		expect(
			database.prepare('SELECT completed_at FROM outbox_jobs WHERE id = ?').get(job.id)
		).toEqual({ completed_at: '2026-07-16T08:36:00.000Z' });
		expect(() =>
			outbox.reschedule(job.id, 2, new Date('2026-07-16T08:40:00.000Z'), 'LATE_FAILURE')
		).toThrowError('OUTBOX_JOB_COMPLETED');
		expect(outbox.claimDue(new Date('2026-07-16T09:00:00.000Z'), 10)).toEqual([]);
	});

	it('rejects raw outbox error details instead of persisting them', () => {
		outbox.enqueue(outboxInput());
		const [job] = outbox.claimDue(now, 1);
		expect(() =>
			outbox.reschedule(job.id, 1, new Date('2026-07-16T08:35:00.000Z'), 'Bearer sk_live_sensitive')
		).toThrowError('OUTBOX_RESCHEDULE_INVALID');
		expect(
			database.prepare('SELECT attempt_count, last_error_code FROM outbox_jobs').get()
		).toEqual({
			attempt_count: 0,
			last_error_code: null
		});
	});

	it('rejects invalid claim limits and missing job transitions with stable errors', () => {
		expect(() => outbox.claimDue(now, 0)).toThrowError('OUTBOX_CLAIM_LIMIT_INVALID');
		expect(() => outbox.claimDue(now, 101)).toThrowError('OUTBOX_CLAIM_LIMIT_INVALID');
		expect(() => outbox.complete(999, now)).toThrowError('OUTBOX_JOB_NOT_FOUND');
		expect(() => outbox.reschedule(999, 1, now, 'FAILED')).toThrowError('OUTBOX_JOB_NOT_FOUND');
	});
});

describe('SqliteOrderEventRepository', () => {
	it('rejects raw audit error details instead of persisting them', () => {
		const draft = drafts.create(draftInput());
		drafts.attachSession(draft.id, 'cs_paid');
		const order = orders.createPaidOrder(paidOrderInput(draft.id));
		const audit = new SqliteOrderEventRepository(database);

		expect(() =>
			audit.append({
				orderId: order.id,
				actor: 'stripe-webhook',
				action: 'refund_failed',
				priorState: 'paid',
				nextState: 'paid',
				result: 'failed',
				errorCode: 'customer@example.com rejected',
				createdAt: now
			})
		).toThrowError('ORDER_EVENT_INVALID');
		expect(database.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
			count: 0
		});
	});
});
