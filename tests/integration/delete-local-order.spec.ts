import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '$lib/server/db/migrate.server';
import {
	createConfirmedEncryptedDeletionBackup,
	deleteLocalOrder,
	parseDeleteLocalOrderArguments,
	runDeleteLocalOrderCommand
} from '../../scripts/delete-local-order.mjs';

const targetOrderId = '11111111-1111-4111-8111-111111111111';
const targetDraftId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOrderId = '22222222-2222-4222-8222-222222222222';
const otherDraftId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const migrationsDirectory = resolve('migrations');
const backupEnvironment = {
	S3_PREFIX: 'reviewed-deletions',
	BACKUP_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
};

class MemoryDeletionBackupStore {
	readonly objects = new Map<string, Buffer>();
	readonly putCalls: Array<{ key: string; contentType: string; ifNoneMatch: string | undefined }> =
		[];
	readonly deleteCalls: string[][] = [];
	collideNextPut = false;
	collision: { key: string; body: Buffer } | undefined;

	async put(
		key: string,
		body: Uint8Array,
		contentType: string,
		options?: { ifNoneMatch?: string }
	): Promise<void> {
		this.putCalls.push({ key, contentType, ifNoneMatch: options?.ifNoneMatch });
		if (this.collideNextPut) {
			this.collideNextPut = false;
			const collisionBody = Buffer.from('pre-existing successful backup');
			this.collision = { key, body: collisionBody };
			this.objects.set(key, collisionBody);
		}
		if (options?.ifNoneMatch === '*' && this.objects.has(key)) {
			throw new Error('private object-store precondition failure');
		}
		this.objects.set(key, Buffer.from(body));
	}

	async list(prefix: string): Promise<string[]> {
		return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
	}

	async delete(keys: string[]): Promise<void> {
		this.deleteCalls.push([...keys]);
		for (const key of keys) this.objects.delete(key);
	}
}

let root: string;
let databasePath: string;
let database: Database.Database;

function seedOrder(
	orderId: string,
	draftId: string,
	sessionId: string,
	paymentIntentId: string,
	suffix: string
): void {
	database
		.prepare(
			`INSERT INTO checkout_drafts (
				id, stripe_checkout_session_id, contract_version, currency, total_unit_count,
				shipping_mode, created_at, expires_at, completed_at, destination_country,
				shipping_rate_id, shipping_net_amount
			) VALUES (?, ?, 2, 'eur', 1, 'paid', ?, ?, ?, 'SE', 'shr_paid_8_eur', 800)`
		)
		.run(
			draftId,
			sessionId,
			'2026-07-17T08:00:00.000Z',
			'2026-07-17T09:00:00.000Z',
			'2026-07-17T08:05:00.000Z'
		);
	database
		.prepare(
			`INSERT INTO checkout_draft_lines (
				draft_id, line_index, stripe_product_id, stripe_price_id, product_name,
				variant_label, sku, styria_product_number, design_reference, design_json,
				quantity, unit_amount, currency
			) VALUES (?, 0, ?, ?, ?, 'M', ?, ?, ?, '{}', 1, 2000, 'eur')`
		)
		.run(
			draftId,
			`prod_${suffix}`,
			`price_${suffix}`,
			`Product ${suffix}`,
			`SKU-${suffix}`,
			`ST-${suffix}`,
			`design-${suffix}`
		);
	database
		.prepare(
			`INSERT INTO orders (
				id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
				checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
				shipping_tax_amount, tax_amount, total_amount, destination_country, payment_status,
				fulfillment_status, updated_at
			) VALUES (?, ?, ?, ?, ?, 'eur', 2000, 0, 1000, 200, 700, 3500, 'SE', 'paid', 'pending_review', ?)`
		)
		.run(
			orderId,
			sessionId,
			paymentIntentId,
			`cus_private_${suffix}`,
			draftId,
			'2026-07-17T08:05:00.000Z'
		);
	database
		.prepare(
			`INSERT INTO order_lines (
				order_id, line_index, stripe_product_id, stripe_price_id, product_name,
				variant_label, sku, styria_product_number, design_reference, design_json,
				quantity, unit_amount, currency, retail_unit_amount
			) VALUES (?, 0, ?, ?, ?, 'M', ?, ?, ?, '{}', 1, 2000, 'eur', 2500)`
		)
		.run(
			orderId,
			`prod_${suffix}`,
			`price_${suffix}`,
			`Product ${suffix}`,
			`SKU-${suffix}`,
			`ST-${suffix}`,
			`design-${suffix}`
		);
}

function seedRelatedRows(): void {
	seedOrder(targetOrderId, targetDraftId, 'cs_private_target', 'pi_private_target', 'target');
	seedOrder(otherOrderId, otherDraftId, 'cs_private_other', 'pi_private_other', 'other');
	database
		.prepare('UPDATE checkout_drafts SET stripe_checkout_session_id = ? WHERE id = ?')
		.run('cs_private_draft_target', targetDraftId);

	const insertStripeEvent = database.prepare(
		`INSERT INTO stripe_events (
			stripe_event_id, event_type, processing_status, stripe_checkout_session_id,
			stripe_payment_intent_id, first_seen_at, completed_at
		) VALUES (?, 'checkout.session.completed', 'completed', ?, ?, ?, ?)`
	);
	insertStripeEvent.run(
		'evt_private_session',
		'cs_private_target',
		null,
		'2026-07-17T08:05:00.000Z',
		'2026-07-17T08:05:01.000Z'
	);
	insertStripeEvent.run(
		'evt_private_payment',
		null,
		'pi_private_target',
		'2026-07-17T08:05:00.000Z',
		'2026-07-17T08:05:01.000Z'
	);
	insertStripeEvent.run(
		'evt_private_draft',
		'cs_private_draft_target',
		null,
		'2026-07-17T08:05:00.000Z',
		'2026-07-17T08:05:01.000Z'
	);
	insertStripeEvent.run(
		'evt_private_other',
		'cs_private_other',
		'pi_private_other',
		'2026-07-17T08:05:00.000Z',
		'2026-07-17T08:05:01.000Z'
	);

	database
		.prepare(
			`INSERT INTO order_events (order_id, actor, action, result, created_at)
			 VALUES (?, 'system', 'paid', 'success', ?), (?, 'system', 'paid', 'success', ?)`
		)
		.run(targetOrderId, '2026-07-17T08:05:00.000Z', otherOrderId, '2026-07-17T08:05:00.000Z');
	database
		.prepare(
			`INSERT INTO submission_approvals (id, order_id, payload_hash, actor, expires_at)
			 VALUES (?, ?, ?, 'codex-admin', ?), (?, ?, ?, 'codex-admin', ?)`
		)
		.run(
			'approval-private-target',
			targetOrderId,
			'a'.repeat(64),
			'2026-07-17T09:00:00.000Z',
			'approval-private-other',
			otherOrderId,
			'b'.repeat(64),
			'2026-07-17T09:00:00.000Z'
		);
	database
		.prepare(
			`INSERT INTO outbox_jobs (kind, idempotency_key, order_id, next_attempt_at)
			 VALUES ('shipping-email', ?, ?, ?), ('shipping-email', ?, ?, ?)`
		)
		.run(
			'private-outbox-target',
			targetOrderId,
			'2026-07-17T08:05:00.000Z',
			'private-outbox-other',
			otherOrderId,
			'2026-07-17T08:05:00.000Z'
		);
	database
		.prepare(
			`INSERT INTO outbox_jobs (
				kind, idempotency_key, order_id, next_attempt_at, alert_code,
				alert_subject_id, alert_observed_at
			) VALUES ('operational-alert', ?, NULL, ?, 'ORDER_PENDING_REVIEW', ?, ?),
				('operational-alert', ?, NULL, ?, 'ORDER_PENDING_REVIEW', ?, ?)`
		)
		.run(
			'private-alert-target',
			'2026-07-17T08:05:00.000Z',
			targetOrderId,
			'2026-07-17T08:05:00.000Z',
			'private-alert-other',
			'2026-07-17T08:05:00.000Z',
			otherOrderId,
			'2026-07-17T08:05:00.000Z'
		);
	database
		.prepare(
			`INSERT INTO email_deliveries (order_id, kind, idempotency_key, provider_delivery_id)
			 VALUES (?, 'shipping', ?, ?), (?, 'shipping', ?, ?)`
		)
		.run(
			targetOrderId,
			'private-email-target',
			'plunk_private_target',
			otherOrderId,
			'private-email-other',
			'plunk_private_other'
		);
	database
		.prepare(
			`INSERT INTO support_notes (order_id, outcome, external_reference, actor, created_at, note)
			 VALUES (?, 'resolved', ?, 'codex-admin', ?, ?), (?, 'resolved', ?, 'codex-admin', ?, ?)`
		)
		.run(
			targetOrderId,
			'private-support-target',
			'2026-07-17T08:05:00.000Z',
			'customer name and address must never be logged',
			otherOrderId,
			'private-support-other',
			'2026-07-17T08:05:00.000Z',
			'unrelated customer note'
		);
}

function counts(): Record<string, number> {
	return Object.fromEntries(
		[
			'stripe_events',
			'support_notes',
			'email_deliveries',
			'outbox_jobs',
			'submission_approvals',
			'order_events',
			'order_lines',
			'orders',
			'checkout_draft_lines',
			'checkout_drafts'
		].map((table) => [
			table,
			(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
		])
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'shop-reviewed-deletion-'));
	databasePath = join(root, 'shop.sqlite');
	database = new Database(databasePath);
	database.pragma('foreign_keys = ON');
	migrate(database, migrationsDirectory);
	seedRelatedRows();
});

afterEach(() => {
	if (database.open) database.close();
	rmSync(root, { recursive: true, force: true });
});

describe('reviewed local-order deletion', () => {
	it('creates distinct immutable object and checksum keys for backups at the same timestamp', async () => {
		const store = new MemoryDeletionBackupStore();
		const now = new Date('2026-07-17T08:05:00.000Z');

		await createConfirmedEncryptedDeletionBackup({
			database,
			environment: backupEnvironment,
			store,
			now,
			temporaryDirectory: root
		});
		await createConfirmedEncryptedDeletionBackup({
			database,
			environment: backupEnvironment,
			store,
			now,
			temporaryDirectory: root
		});

		const objectKeys = store.putCalls
			.map(({ key }) => key)
			.filter((key) => !key.endsWith('.sha256'));
		const checksumKeys = store.putCalls
			.map(({ key }) => key)
			.filter((key) => key.endsWith('.sha256'));
		expect(objectKeys).toHaveLength(2);
		expect(new Set(objectKeys).size).toBe(2);
		expect(checksumKeys).toEqual(objectKeys.map((key) => `${key}.sha256`));
		expect(new Set(checksumKeys).size).toBe(2);
		expect(store.objects.size).toBe(4);
		for (const objectKey of objectKeys) {
			expect(objectKey).toMatch(
				/^reviewed-deletions\/2026\/07\/17\/shop-20260717T080500Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite\.ssbk$/
			);
			expect(store.objects.has(`${objectKey}.sha256`)).toBe(true);
		}
	});

	it('requests conditional non-overwrite creation for backup and checksum uploads', async () => {
		const store = new MemoryDeletionBackupStore();

		await createConfirmedEncryptedDeletionBackup({
			database,
			environment: backupEnvironment,
			store,
			now: new Date('2026-07-17T08:05:00.000Z'),
			temporaryDirectory: root
		});

		expect(store.putCalls).toHaveLength(2);
		expect(store.putCalls.map(({ ifNoneMatch }) => ifNoneMatch)).toEqual(['*', '*']);
	});

	it('fails closed on a forced key collision without deleting the successful backup', async () => {
		const store = new MemoryDeletionBackupStore();
		const now = new Date('2026-07-17T08:05:00.000Z');
		const options = {
			database,
			environment: backupEnvironment,
			store,
			now,
			temporaryDirectory: root
		};

		await createConfirmedEncryptedDeletionBackup(options);
		const successfulBackup = new Map(store.objects);
		store.collideNextPut = true;

		await expect(createConfirmedEncryptedDeletionBackup(options)).rejects.toThrowError(
			/^LOCAL_ORDER_DELETE_BACKUP_FAILED$/
		);

		for (const [key, body] of successfulBackup) {
			expect(store.objects.get(key)).toEqual(body);
		}
		expect(store.collision).toBeDefined();
		expect(store.objects.get(store.collision?.key ?? '')).toEqual(store.collision?.body);
		expect(store.deleteCalls).toEqual([]);
	});

	it('requires the exact confirmation and internal order ID', () => {
		expect(() => parseDeleteLocalOrderArguments([])).toThrowError(
			/^LOCAL_ORDER_DELETE_ARGUMENTS_INVALID$/
		);
		expect(() => parseDeleteLocalOrderArguments(['--order-id', targetOrderId])).toThrowError(
			/^LOCAL_ORDER_DELETE_CONFIRMATION_REQUIRED$/
		);
		expect(
			parseDeleteLocalOrderArguments(['--order-id', targetOrderId, '--confirm-reviewed-deletion'])
		).toEqual({ orderId: targetOrderId });
	});

	it.each([
		['true', 'false'],
		['false', 'true'],
		['true', 'true']
	])(
		'refuses while checkout=%s or scheduler=%s is active before opening the database',
		async (checkout, scheduler) => {
			const openDatabase = vi.fn();
			const output = { log: vi.fn(), error: vi.fn() };

			await expect(
				runDeleteLocalOrderCommand({
					args: ['--order-id', targetOrderId, '--confirm-reviewed-deletion'],
					environment: {
						CHECKOUT_ENABLED: checkout,
						SCHEDULER_ENABLED: scheduler,
						DATABASE_PATH: databasePath
					},
					openDatabase,
					output
				})
			).resolves.toBe(1);

			expect(openDatabase).not.toHaveBeenCalled();
			expect(output.log).not.toHaveBeenCalled();
			expect(output.error).toHaveBeenCalledWith(
				JSON.stringify({ error_code: 'LOCAL_ORDER_DELETE_MAINTENANCE_REQUIRED' })
			);
		}
	);

	it('does not delete anything when the confirmed encrypted off-host backup fails', async () => {
		const before = counts();
		const createBackup = vi.fn().mockRejectedValue(new Error('private provider failure'));

		await expect(
			deleteLocalOrder({ database, orderId: targetOrderId, createBackup })
		).rejects.toThrowError(/^LOCAL_ORDER_DELETE_BACKUP_FAILED$/);

		expect(createBackup).toHaveBeenCalledOnce();
		expect(counts()).toEqual(before);
	});

	it('rolls back every table when any delete fails', async () => {
		const before = counts();
		database.exec(`
			CREATE TRIGGER reject_reviewed_delete BEFORE DELETE ON order_events
			WHEN OLD.order_id = '${targetOrderId}'
			BEGIN
				SELECT RAISE(ABORT, 'private trigger payload');
			END
		`);

		await expect(
			deleteLocalOrder({
				database,
				orderId: targetOrderId,
				createBackup: vi.fn().mockResolvedValue(undefined)
			})
		).rejects.toThrowError(/^LOCAL_ORDER_DELETE_FAILED$/);

		expect(counts()).toEqual(before);
	});

	it('deletes every related row atomically, preserves unrelated rows, and runs quick_check', async () => {
		const pragma = vi.spyOn(database, 'pragma');
		const createBackup = vi.fn().mockResolvedValue(undefined);

		await expect(
			deleteLocalOrder({ database, orderId: targetOrderId, createBackup })
		).resolves.toEqual({
			stripe_events: 3,
			support_notes: 1,
			email_deliveries: 1,
			outbox_jobs: 2,
			submission_approvals: 1,
			order_events: 1,
			order_lines: 1,
			orders: 1,
			checkout_draft_lines: 1,
			checkout_drafts: 1
		});

		expect(createBackup).toHaveBeenCalledOnce();
		expect(pragma).toHaveBeenCalledWith('quick_check');
		expect(database.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
		expect(counts()).toEqual({
			stripe_events: 1,
			support_notes: 1,
			email_deliveries: 1,
			outbox_jobs: 2,
			submission_approvals: 1,
			order_events: 1,
			order_lines: 1,
			orders: 1,
			checkout_draft_lines: 1,
			checkout_drafts: 1
		});
		expect(database.prepare('SELECT id FROM orders WHERE id = ?').get(otherOrderId)).toEqual({
			id: otherOrderId
		});
	});

	it('prints only the internal ID and per-table counts without private values or paths', async () => {
		const output = { log: vi.fn(), error: vi.fn() };

		await expect(
			runDeleteLocalOrderCommand({
				args: ['--order-id', targetOrderId, '--confirm-reviewed-deletion'],
				environment: {
					CHECKOUT_ENABLED: 'false',
					SCHEDULER_ENABLED: 'false',
					DATABASE_PATH: databasePath,
					S3_SECRET_ACCESS_KEY: 'private-backup-secret'
				},
				openDatabase: () => database,
				closeDatabase: () => undefined,
				createBackup: vi.fn().mockResolvedValue(undefined),
				output
			})
		).resolves.toBe(0);

		expect(output.error).not.toHaveBeenCalled();
		expect(output.log).toHaveBeenCalledOnce();
		const serialized = output.log.mock.calls[0][0] as string;
		expect(JSON.parse(serialized)).toEqual({
			order_id: targetOrderId,
			deleted: {
				stripe_events: 3,
				support_notes: 1,
				email_deliveries: 1,
				outbox_jobs: 2,
				submission_approvals: 1,
				order_events: 1,
				order_lines: 1,
				orders: 1,
				checkout_draft_lines: 1,
				checkout_drafts: 1
			}
		});
		for (const privateValue of [
			'private-backup-secret',
			'delete-local-order',
			databasePath,
			'cs_private_target',
			'pi_private_target',
			'cus_private_target',
			'plunk_private_target',
			'customer name and address'
		]) {
			expect(serialized).not.toContain(privateValue);
		}
	});
});
