import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '$lib/server/db/migrate.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteApprovalRepository } from './approvals.server';

const migrationsDirectory = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const approvalId = 'A'.repeat(43);
const payloadHash = 'b'.repeat(64);
const expiresAt = new Date('2026-07-17T10:10:00.000Z');

function seedOrder(database: ShopDatabase): void {
	database
		.prepare(
			`INSERT INTO checkout_drafts (
				id, stripe_checkout_session_id, contract_version, currency, total_unit_count,
				shipping_mode, created_at, expires_at, completed_at, destination_country,
				shipping_rate_id, shipping_net_amount
			) VALUES ('draft_approval', 'cs_test_approval', 2, 'eur', 1, 'paid', ?, ?, ?, 'SE',
				'shr_paid_8_eur', 800)`
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
				'order_approval', 'cs_test_approval', 'pi_test_approval', 'cus_test_approval',
				'draft_approval', 'eur', 2000, 0, 1000, 200, 700, 3500, 'SE', 'paid',
				'pending_review', '2026-07-17T09:30:00.000Z'
			)`
		)
		.run();
}

let database: ShopDatabase;
let approvals: SqliteApprovalRepository;

beforeEach(() => {
	database = new Database(':memory:');
	database.pragma('foreign_keys = ON');
	migrate(database, migrationsDirectory);
	seedOrder(database);
	approvals = new SqliteApprovalRepository(database);
});

afterEach(() => {
	database.close();
});

describe('submission approval persistence', () => {
	it('inserts an unused approval tied to order, payload hash, fixed actor, and expiry', () => {
		approvals.create({ approvalId, orderId: 'order_approval', payloadHash, expiresAt });

		expect(database.prepare('SELECT * FROM submission_approvals').get()).toEqual({
			id: approvalId,
			order_id: 'order_approval',
			payload_hash: payloadHash,
			actor: 'codex-admin',
			expires_at: '2026-07-17T10:10:00.000Z',
			used_at: null
		});
	});

	it.each([
		['approval ID', { approvalId: 'guessable' }],
		['order ID', { orderId: '' }],
		['payload hash', { payloadHash: 'not-sha-256' }],
		['expiry', { expiresAt: new Date(Number.NaN) }]
	])('rejects an invalid %s without writing a row', (_label, override) => {
		expect(() =>
			approvals.create({
				approvalId,
				orderId: 'order_approval',
				payloadHash,
				expiresAt,
				...override
			})
		).toThrowError(
			expect.objectContaining({
				name: 'ApprovalRepositoryError',
				code: 'SUBMISSION_APPROVAL_INVALID',
				message: 'SUBMISSION_APPROVAL_INVALID'
			})
		);
		expect(database.prepare('SELECT count(*) AS count FROM submission_approvals').get()).toEqual({
			count: 0
		});
	});

	it('returns a stable redacted error for constraint failures', () => {
		approvals.create({ approvalId, orderId: 'order_approval', payloadHash, expiresAt });

		expect(() =>
			approvals.create({ approvalId, orderId: 'order_approval', payloadHash, expiresAt })
		).toThrowError(
			expect.objectContaining({
				name: 'ApprovalRepositoryError',
				code: 'SUBMISSION_APPROVAL_CREATE_FAILED',
				message: 'SUBMISSION_APPROVAL_CREATE_FAILED'
			})
		);
	});

	it('has no columns capable of persisting payload or customer fulfillment details', () => {
		const columns = database
			.prepare('PRAGMA table_info(submission_approvals)')
			.all()
			.map((column) => (column as { name: string }).name);

		expect(columns).toEqual(['id', 'order_id', 'payload_hash', 'actor', 'expires_at', 'used_at']);
		expect(columns).not.toEqual(
			expect.arrayContaining(['payload', 'email', 'name', 'phone', 'address'])
		);
	});
});
