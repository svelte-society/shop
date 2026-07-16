import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '$lib/server/db/migrate.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteFulfillmentRepository } from './repository.server';

const migrationsDirectory = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const now = new Date('2026-07-16T08:30:00.000Z');

type OrderSeed = {
	id: string;
	status:
		| 'pending_review'
		| 'submitting'
		| 'submitted'
		| 'awaiting_vendor_payment'
		| 'in_production'
		| 'shipped'
		| 'review_required'
		| 'cancelled';
	paymentStatus: 'paid' | 'partially_refunded' | 'refunded';
	updatedAt: Date;
	styriaOrderId: string | null;
	styriaStatus: string | null;
	trackingNumber: string | null;
	submittedAt: Date | null;
	shippedAt: Date | null;
	lastErrorCode: string | null;
};

function configure(database: ShopDatabase): void {
	database.pragma('journal_mode = WAL');
	database.pragma('foreign_keys = ON');
	database.pragma('busy_timeout = 5000');
	database.pragma('synchronous = FULL');
}

function seedOrder(database: ShopDatabase, overrides: Partial<OrderSeed> = {}): OrderSeed {
	const seed: OrderSeed = {
		id: 'order_one',
		status: 'pending_review',
		paymentStatus: 'paid',
		updatedAt: new Date('2026-07-16T08:00:00.000Z'),
		styriaOrderId: null,
		styriaStatus: null,
		trackingNumber: null,
		submittedAt: null,
		shippedAt: null,
		lastErrorCode: null,
		...overrides
	};
	const suffix = seed.id.replace(/[^A-Za-z0-9_]/g, '_');
	database
		.prepare(
			`INSERT INTO checkout_drafts (
				id, stripe_checkout_session_id, contract_version, currency, total_unit_count,
				shipping_mode, created_at, expires_at, completed_at
			) VALUES (?, ?, 1, 'eur', 2, 'free', ?, ?, ?)`
		)
		.run(
			`draft_${suffix}`,
			`cs_${suffix}`,
			'2026-07-16T07:30:00.000Z',
			'2026-07-16T08:30:00.000Z',
			'2026-07-16T08:00:00.000Z'
		);
	database
		.prepare(
			`INSERT INTO orders (
				id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
				checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
				tax_amount, total_amount, destination_country, payment_status, fulfillment_status,
				styria_order_id, styria_status, tracking_number, submitted_at, shipped_at,
				updated_at, last_error_code
			) VALUES (?, ?, ?, ?, ?, 'eur', 4000, 0, 0, 1000, 5000, 'SE', ?, ?, ?, ?, ?,
				?, ?, ?, ?)`
		)
		.run(
			seed.id,
			`cs_${suffix}`,
			`pi_${suffix}`,
			`cus_${suffix}`,
			`draft_${suffix}`,
			seed.paymentStatus,
			seed.status,
			seed.styriaOrderId,
			seed.styriaStatus,
			seed.trackingNumber,
			seed.submittedAt?.toISOString() ?? null,
			seed.shippedAt?.toISOString() ?? null,
			seed.updatedAt.toISOString(),
			seed.lastErrorCode
		);
	database
		.prepare(
			`INSERT INTO order_lines (
				order_id, line_index, stripe_product_id, stripe_price_id, product_name,
				variant_label, sku, styria_product_number, design_reference, design_json,
				quantity, unit_amount, currency
			) VALUES (?, 0, ?, ?, 'Community Tee', 'M', 'SS-TEE-M', 'STYRIA-TEE-M',
				'society-community-v1', '{"front":"https://cdn.example.com/front.svg"}',
				2, 2000, 'eur')`
		)
		.run(seed.id, `prod_${suffix}`, `price_${suffix}`);
	return seed;
}

function seedApproval(
	database: ShopDatabase,
	input: {
		id?: string;
		orderId?: string;
		payloadHash?: string;
		actor?: string;
		expiresAt?: Date;
		usedAt?: Date | null;
	} = {}
): void {
	const actor = input.actor ?? 'codex-admin';
	if (actor !== 'codex-admin') database.pragma('ignore_check_constraints = ON');
	try {
		database
			.prepare(
				`INSERT INTO submission_approvals (
					id, order_id, payload_hash, actor, expires_at, used_at
				) VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(
				input.id ?? 'approval_one',
				input.orderId ?? 'order_one',
				input.payloadHash ?? 'payload-hash-one',
				actor,
				(input.expiresAt ?? new Date('2026-07-16T08:40:00.000Z')).toISOString(),
				input.usedAt?.toISOString() ?? null
			);
	} finally {
		if (actor !== 'codex-admin') database.pragma('ignore_check_constraints = OFF');
	}
}

function orderState(database: ShopDatabase, orderId = 'order_one'): Record<string, unknown> {
	return database
		.prepare(
			`SELECT payment_status, fulfillment_status, styria_order_id, styria_status,
				tracking_number, submitted_at, shipped_at, updated_at, last_error_code
			FROM orders WHERE id = ?`
		)
		.get(orderId) as Record<string, unknown>;
}

function events(database: ShopDatabase, orderId = 'order_one'): Record<string, unknown>[] {
	return database
		.prepare(
			`SELECT actor, action, prior_state, next_state, result, error_code, created_at
			FROM order_events WHERE order_id = ? ORDER BY id`
		)
		.all(orderId) as Record<string, unknown>[];
}

let database: ShopDatabase;
let repository: SqliteFulfillmentRepository;

beforeEach(() => {
	database = new Database(':memory:');
	configure(database);
	migrate(database, migrationsDirectory);
	repository = new SqliteFulfillmentRepository(database);
});

afterEach(() => {
	if (database.open) database.close();
});

describe('fulfillment reads', () => {
	it('lists only pending and review-required orders oldest first without customer data', () => {
		seedOrder(database, {
			id: 'order_newer',
			updatedAt: new Date('2026-07-16T08:20:00.000Z')
		});
		seedOrder(database, {
			id: 'order_oldest',
			status: 'review_required',
			updatedAt: new Date('2026-07-16T08:00:00.000Z'),
			lastErrorCode: 'STYRIA_STATUS_REVIEW_REQUIRED'
		});
		seedOrder(database, {
			id: 'order_production',
			status: 'in_production',
			updatedAt: new Date('2026-07-16T07:00:00.000Z'),
			styriaOrderId: 'styria-production',
			styriaStatus: 'printing'
		});

		const pending = repository.listPending(2);

		expect(pending.map((order) => order.id)).toEqual(['order_oldest', 'order_newer']);
		expect(pending[0]).toEqual(
			expect.objectContaining({
				paymentStatus: 'paid',
				fulfillmentStatus: 'review_required',
				totalAmount: 5000,
				destinationCountry: 'SE',
				lastErrorCode: 'STYRIA_STATUS_REVIEW_REQUIRED'
			})
		);
		expect(pending[0]).not.toHaveProperty('customerId');
		expect(() => repository.listPending(0)).toThrowError('FULFILLMENT_LIST_LIMIT_INVALID');
	});

	it('inspects an order with immutable lines, audits, and support outcomes', () => {
		seedOrder(database);
		repository.recordSupportNote({
			orderId: 'order_one',
			outcome: 'return_approved',
			externalReference: 'case-123',
			createdAt: now
		});

		expect(repository.inspect('order_one')).toEqual(
			expect.objectContaining({
				id: 'order_one',
				lines: [
					expect.objectContaining({
						productName: 'Community Tee',
						styriaProductNumber: 'STYRIA-TEE-M',
						designPlacements: { front: 'https://cdn.example.com/front.svg' }
					})
				],
				events: [
					expect.objectContaining({ actor: 'codex-admin', action: 'support_note_recorded' })
				],
				supportNotes: [
					expect.objectContaining({ outcome: 'return_approved', externalReference: 'case-123' })
				]
			})
		);
		expect(repository.inspect('order_missing')).toBeNull();
	});
});

describe('beginSubmission', () => {
	it('atomically consumes a matching current approval, enters submitting, and audits', () => {
		seedOrder(database);
		seedApproval(database);

		repository.beginSubmission('order_one', 'approval_one', 'payload-hash-one', now);

		expect(orderState(database)).toEqual({
			payment_status: 'paid',
			fulfillment_status: 'submitting',
			styria_order_id: null,
			styria_status: null,
			tracking_number: null,
			submitted_at: null,
			shipped_at: null,
			updated_at: now.toISOString(),
			last_error_code: null
		});
		expect(
			database.prepare('SELECT used_at FROM submission_approvals WHERE id = ?').get('approval_one')
		).toEqual({ used_at: now.toISOString() });
		expect(events(database)).toEqual([
			{
				actor: 'codex-admin',
				action: 'fulfillment_submission_started',
				prior_state: 'pending_review',
				next_state: 'submitting',
				result: 'succeeded',
				error_code: null,
				created_at: now.toISOString()
			}
		]);
	});

	it('rejects an expired approval without consuming it or changing order state', () => {
		seedOrder(database);
		seedApproval(database, { expiresAt: now });

		expect(() =>
			repository.beginSubmission('order_one', 'approval_one', 'payload-hash-one', now)
		).toThrowError('SUBMISSION_APPROVAL_EXPIRED');

		expect(orderState(database).fulfillment_status).toBe('pending_review');
		expect(
			database.prepare('SELECT used_at FROM submission_approvals WHERE id = ?').get('approval_one')
		).toEqual({ used_at: null });
		expect(events(database)).toEqual([]);
	});

	it('rejects replay, wrong order, wrong hash, and wrong actor with stable errors', () => {
		seedOrder(database);
		seedOrder(database, { id: 'order_two' });
		seedApproval(database, { id: 'used', usedAt: new Date('2026-07-16T08:20:00.000Z') });
		seedApproval(database, { id: 'wrong-order', orderId: 'order_two' });
		seedApproval(database, { id: 'wrong-hash', payloadHash: 'other-hash' });
		seedApproval(database, { id: 'wrong-actor', actor: 'operator' });

		expect(() =>
			repository.beginSubmission('order_one', 'used', 'payload-hash-one', now)
		).toThrowError('SUBMISSION_APPROVAL_USED');
		expect(() =>
			repository.beginSubmission('order_one', 'wrong-order', 'payload-hash-one', now)
		).toThrowError('SUBMISSION_APPROVAL_ORDER_MISMATCH');
		expect(() =>
			repository.beginSubmission('order_one', 'wrong-hash', 'payload-hash-one', now)
		).toThrowError('SUBMISSION_APPROVAL_HASH_MISMATCH');
		expect(() =>
			repository.beginSubmission('order_one', 'wrong-actor', 'payload-hash-one', now)
		).toThrowError('SUBMISSION_APPROVAL_ACTOR_INVALID');
		expect(orderState(database).fulfillment_status).toBe('pending_review');
		expect(events(database)).toEqual([]);
	});

	it('rejects an approval when the order is no longer pending review', () => {
		seedOrder(database, {
			status: 'review_required',
			lastErrorCode: 'STYRIA_CREATE_AMBIGUOUS'
		});
		seedApproval(database);

		expect(() =>
			repository.beginSubmission('order_one', 'approval_one', 'payload-hash-one', now)
		).toThrowError('FULFILLMENT_TRANSITION_INVALID');

		expect(orderState(database).fulfillment_status).toBe('review_required');
		expect(
			database.prepare('SELECT used_at FROM submission_approvals WHERE id = ?').get('approval_one')
		).toEqual({ used_at: null });
		expect(events(database)).toEqual([]);
	});

	it('rolls back approval use and state when the audit append fails', () => {
		seedOrder(database);
		seedApproval(database);
		database.exec(`
			CREATE TRIGGER reject_fulfillment_audit BEFORE INSERT ON order_events
			BEGIN SELECT RAISE(ABORT, 'raw audit failure'); END
		`);

		expect(() =>
			repository.beginSubmission('order_one', 'approval_one', 'payload-hash-one', now)
		).toThrowError('ORDER_EVENT_APPEND_FAILED');

		expect(orderState(database).fulfillment_status).toBe('pending_review');
		expect(
			database.prepare('SELECT used_at FROM submission_approvals WHERE id = ?').get('approval_one')
		).toEqual({ used_at: null });
	});

	it('allows only one of two file-backed connection contenders to use an approval', () => {
		if (database.open) database.close();
		const directory = mkdtempSync(join(tmpdir(), 'shop-fulfillment-approval-'));
		const path = join(directory, 'shop.sqlite');
		const first = new Database(path);
		const second = new Database(path);
		try {
			configure(first);
			configure(second);
			migrate(first, migrationsDirectory);
			seedOrder(first);
			seedApproval(first);

			new SqliteFulfillmentRepository(first).beginSubmission(
				'order_one',
				'approval_one',
				'payload-hash-one',
				now
			);
			expect(() =>
				new SqliteFulfillmentRepository(second).beginSubmission(
					'order_one',
					'approval_one',
					'payload-hash-one',
					now
				)
			).toThrowError('SUBMISSION_APPROVAL_USED');
			expect(first.prepare('SELECT count(*) AS count FROM order_events').get()).toEqual({
				count: 1
			});
		} finally {
			first.close();
			second.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe('provider-result mutations', () => {
	it('records confirmed submission directly from submitting to manual-payment wait', () => {
		seedOrder(database, { status: 'submitting' });

		repository.recordSubmitted('order_one', 'styria-123', 'received', now);

		expect(orderState(database)).toEqual({
			payment_status: 'paid',
			fulfillment_status: 'awaiting_vendor_payment',
			styria_order_id: 'styria-123',
			styria_status: 'received',
			tracking_number: null,
			submitted_at: now.toISOString(),
			shipped_at: null,
			updated_at: now.toISOString(),
			last_error_code: null
		});
		expect(events(database)).toEqual([
			{
				actor: 'codex-admin',
				action: 'styria_submission_recorded',
				prior_state: 'submitting',
				next_state: 'awaiting_vendor_payment',
				result: 'succeeded',
				error_code: null,
				created_at: now.toISOString()
			}
		]);
		expect(JSON.stringify(events(database))).not.toContain('styria-123');
		expect(JSON.stringify(events(database))).not.toContain('received');
	});

	it('supports legacy submitted and review-repair outgoing transitions without creating submitted', () => {
		seedOrder(database, { id: 'order_legacy', status: 'submitted' });
		seedOrder(database, {
			id: 'order_repair',
			status: 'review_required',
			lastErrorCode: 'STYRIA_CREATE_AMBIGUOUS'
		});

		repository.recordSubmitted('order_legacy', 'styria-legacy', 'received', now);
		repository.recordSubmitted('order_repair', 'styria-repair', 'received', now);

		expect(orderState(database, 'order_legacy').fulfillment_status).toBe('awaiting_vendor_payment');
		expect(orderState(database, 'order_repair').fulfillment_status).toBe('awaiting_vendor_payment');
	});

	it('requires review with the supplied stable error while retaining payment state', () => {
		seedOrder(database, { status: 'submitting', paymentStatus: 'refunded' });

		repository.requireReview('order_one', 'STYRIA_CREATE_AMBIGUOUS', now);

		expect(orderState(database)).toEqual(
			expect.objectContaining({
				payment_status: 'refunded',
				fulfillment_status: 'review_required',
				last_error_code: 'STYRIA_CREATE_AMBIGUOUS',
				updated_at: now.toISOString()
			})
		);
		expect(events(database)).toEqual([
			expect.objectContaining({
				actor: 'codex-admin',
				action: 'fulfillment_review_required',
				prior_state: 'submitting',
				next_state: 'review_required',
				result: 'failed',
				error_code: 'STYRIA_CREATE_AMBIGUOUS'
			})
		]);
	});

	it('applies production and tracking results without changing refund status', () => {
		seedOrder(database, {
			status: 'awaiting_vendor_payment',
			paymentStatus: 'partially_refunded',
			styriaOrderId: 'styria-123',
			styriaStatus: 'received'
		});

		repository.applyStyriaStatus(
			'order_one',
			{ status: 'printing', deleted: false, trackingNumber: null },
			now
		);
		repository.applyStyriaStatus(
			'order_one',
			{ status: 'quality control', deleted: false, trackingNumber: 'TRACK-123' },
			new Date('2026-07-16T09:00:00.000Z')
		);

		expect(orderState(database)).toEqual(
			expect.objectContaining({
				payment_status: 'partially_refunded',
				fulfillment_status: 'shipped',
				styria_status: 'quality control',
				tracking_number: 'TRACK-123',
				shipped_at: '2026-07-16T09:00:00.000Z',
				last_error_code: null
			})
		);
		expect(events(database).map((event) => event.next_state)).toEqual(['in_production', 'shipped']);
	});

	it.each([
		{ status: 'refunded', deleted: false, trackingNumber: null },
		{ status: 'internal order query', deleted: false, trackingNumber: null },
		{ status: 'received', deleted: true, trackingNumber: null },
		{ status: 'provider surprise', deleted: false, trackingNumber: null }
	])(
		'routes exceptional Styria result %# to review without auditing raw provider data',
		(update) => {
			seedOrder(database, {
				status: 'awaiting_vendor_payment',
				styriaOrderId: 'styria-123',
				styriaStatus: 'received'
			});

			repository.applyStyriaStatus('order_one', update, now);

			expect(orderState(database)).toEqual(
				expect.objectContaining({
					fulfillment_status: 'review_required',
					styria_status: update.status,
					last_error_code: 'STYRIA_STATUS_REVIEW_REQUIRED'
				})
			);
			expect(events(database)).toEqual([
				expect.objectContaining({
					result: 'failed',
					error_code: 'STYRIA_STATUS_REVIEW_REQUIRED'
				})
			]);
			expect(JSON.stringify(events(database))).not.toContain(update.status);
		}
	);

	it('preserves shipment history when a shipped order later requires review', () => {
		const shippedAt = new Date('2026-07-16T08:10:00.000Z');
		seedOrder(database, {
			status: 'shipped',
			styriaOrderId: 'styria-123',
			styriaStatus: 'quality control',
			trackingNumber: 'TRACK-123',
			submittedAt: new Date('2026-07-16T08:00:00.000Z'),
			shippedAt
		});

		repository.applyStyriaStatus(
			'order_one',
			{ status: 'internal order query', deleted: false, trackingNumber: 'TRACK-123' },
			now
		);

		expect(orderState(database)).toEqual(
			expect.objectContaining({
				fulfillment_status: 'review_required',
				tracking_number: 'TRACK-123',
				shipped_at: shippedAt.toISOString()
			})
		);
	});

	it('rolls back provider state when its audit append fails', () => {
		seedOrder(database, { status: 'submitting' });
		database.exec(`
			CREATE TRIGGER reject_provider_audit BEFORE INSERT ON order_events
			BEGIN SELECT RAISE(ABORT, 'raw audit failure'); END
		`);

		expect(() =>
			repository.recordSubmitted('order_one', 'styria-123', 'received', now)
		).toThrowError('ORDER_EVENT_APPEND_FAILED');

		expect(orderState(database)).toEqual(
			expect.objectContaining({
				fulfillment_status: 'submitting',
				styria_order_id: null,
				styria_status: null,
				submitted_at: null
			})
		);
	});
});

describe('support-note mutation', () => {
	it('stores the operational outcome and audits without copying arguments into the event', () => {
		seedOrder(database, { status: 'shipped' });

		repository.recordSupportNote({
			orderId: 'order_one',
			outcome: 'replacement_ordered',
			externalReference: 'support-case-456',
			createdAt: now
		});

		expect(
			database
				.prepare(
					'SELECT order_id, outcome, external_reference, actor, created_at FROM support_notes'
				)
				.get()
		).toEqual({
			order_id: 'order_one',
			outcome: 'replacement_ordered',
			external_reference: 'support-case-456',
			actor: 'codex-admin',
			created_at: now.toISOString()
		});
		expect(events(database)).toEqual([
			expect.objectContaining({
				actor: 'codex-admin',
				action: 'support_note_recorded',
				prior_state: 'shipped',
				next_state: 'shipped',
				result: 'succeeded',
				error_code: null
			})
		]);
		expect(JSON.stringify(events(database))).not.toContain('support-case-456');
		expect(JSON.stringify(events(database))).not.toContain('replacement_ordered');
	});
});
