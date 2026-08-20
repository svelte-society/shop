import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase } from './connection.server';
import { migrate } from './migrate.server';

const initialMigrationsDirectory = fileURLToPath(
	new URL('../../../../migrations', import.meta.url)
);
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'svelte-shop-db-'));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	closeDatabase();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('openDatabase', () => {
	it('does not create a missing production database when fileMustExist is true', () => {
		const databasePath = join(temporaryDirectory(), 'missing.sqlite');

		expect(() => openDatabase(databasePath, { fileMustExist: true })).toThrow();
		expect(existsSync(databasePath)).toBe(false);
	});

	it('opens an existing production database when fileMustExist is true', () => {
		const databasePath = join(temporaryDirectory(), 'existing.sqlite');
		const created = openDatabase(databasePath);
		created.exec('CREATE TABLE persisted (id INTEGER PRIMARY KEY)');
		closeDatabase();

		const reopened = openDatabase(databasePath, { fileMustExist: true });

		expect(
			reopened.prepare("SELECT name FROM sqlite_schema WHERE name = 'persisted'").get()
		).toEqual({ name: 'persisted' });
	});

	it('enables WAL and durable connection pragmas for file databases', () => {
		const databasePath = join(temporaryDirectory(), 'shop.sqlite');
		const database = openDatabase(databasePath);

		expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
		expect(database.pragma('busy_timeout', { simple: true })).toBe(5_000);
		expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(database.pragma('synchronous', { simple: true })).toBe(2);
	});

	it('returns the active connection for the same normalized filesystem path', () => {
		const databasePath = join(temporaryDirectory(), 'shop.sqlite');
		const database = openDatabase(databasePath);

		expect(openDatabase(databasePath)).toBe(database);
		expect(openDatabase(relative(process.cwd(), databasePath))).toBe(database);
	});

	it('rejects a different path without exposing either filesystem location', () => {
		const firstPath = join(temporaryDirectory(), 'first.sqlite');
		const secondPath = join(temporaryDirectory(), 'second.sqlite');
		openDatabase(firstPath);

		expect(() => openDatabase(secondPath)).toThrowError(/^DATABASE_PATH_MISMATCH$/);
	});

	it('owns the in-memory sentinel explicitly', () => {
		const database = openDatabase(':memory:');

		expect(openDatabase(':memory:')).toBe(database);
		expect(() => openDatabase(join(temporaryDirectory(), 'shop.sqlite'))).toThrowError(
			/^DATABASE_PATH_MISMATCH$/
		);
	});

	it('allows a different path after closeDatabase releases ownership', () => {
		const firstPath = join(temporaryDirectory(), 'first.sqlite');
		const secondPath = join(temporaryDirectory(), 'second.sqlite');
		const first = openDatabase(firstPath);
		closeDatabase();

		const second = openDatabase(secondPath);

		expect(first.open).toBe(false);
		expect(second.open).toBe(true);
		expect(second).not.toBe(first);
	});
});

describe('migrate', () => {
	it('applies ordered SQL migrations once and records each committed file', () => {
		const directory = temporaryDirectory();
		writeFileSync(
			join(directory, '0002_insert.sql'),
			"INSERT INTO migration_order (position) VALUES ('second');"
		);
		writeFileSync(
			join(directory, '0001_create.sql'),
			"CREATE TABLE migration_order (position TEXT NOT NULL); INSERT INTO migration_order VALUES ('first');"
		);
		writeFileSync(join(directory, 'README.md'), 'not a migration');
		const database = openDatabase(':memory:');

		migrate(database, directory);
		migrate(database, directory);

		expect(database.prepare('SELECT position FROM migration_order ORDER BY rowid').all()).toEqual([
			{ position: 'first' },
			{ position: 'second' }
		]);
		expect(database.prepare('SELECT name FROM _migrations ORDER BY name').all()).toEqual([
			{ name: '0001_create.sql' },
			{ name: '0002_insert.sql' }
		]);
	});

	it('rolls back both migration SQL and its ledger row when a migration fails', () => {
		const directory = temporaryDirectory();
		writeFileSync(
			join(directory, '0001_broken.sql'),
			'CREATE TABLE partial_table (id INTEGER PRIMARY KEY); INVALID SQL;'
		);
		const database = openDatabase(':memory:');

		expect(() => migrate(database, directory)).toThrow();

		expect(
			database
				.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'partial_table'")
				.get()
		).toBeUndefined();
		expect(database.prepare('SELECT name FROM _migrations').all()).toEqual([]);
	});

	it.each(['checkout_drafts', 'orders', 'order_lines'] as const)(
		'transactionally clears pre-launch %s rows during the greenfield pricing cutover',
		(table) => {
			const directory = temporaryDirectory();
			const pricingMigrationPath = join(
				initialMigrationsDirectory,
				'0007_dynamic_destination_pricing.sql'
			);
			expect(existsSync(pricingMigrationPath)).toBe(true);
			writeFileSync(
				join(directory, '0001_initial.sql'),
				`CREATE TABLE checkout_drafts (id TEXT PRIMARY KEY);
				 CREATE TABLE checkout_draft_lines (id TEXT PRIMARY KEY);
				 CREATE TABLE orders (id TEXT PRIMARY KEY);
				 CREATE TABLE order_lines (id TEXT PRIMARY KEY);
				 CREATE TABLE order_events (id TEXT PRIMARY KEY);
				 CREATE TABLE submission_approvals (id TEXT PRIMARY KEY);
				 CREATE TABLE outbox_jobs (id TEXT PRIMARY KEY);
				 CREATE TABLE email_deliveries (id TEXT PRIMARY KEY);
				 CREATE TABLE support_notes (id TEXT PRIMARY KEY);
				 CREATE TABLE stripe_events (id TEXT PRIMARY KEY);`
			);
			const database = openDatabase(':memory:');
			migrate(database, directory);
			database.prepare(`INSERT INTO ${table} (id) VALUES (?)`).run(`${table}_existing`);
			writeFileSync(
				join(directory, '0007_dynamic_destination_pricing.sql'),
				readFileSync(pricingMigrationPath, 'utf8')
			);

			migrate(database, directory);
			expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
				count: 0
			});
			expect(database.prepare('SELECT name FROM _migrations ORDER BY name').all()).toEqual([
				{ name: '0001_initial.sql' },
				{ name: '0007_dynamic_destination_pricing.sql' }
			]);
			expect(
				database
					.prepare(
						"SELECT name FROM pragma_table_info('checkout_drafts') WHERE name = 'destination_country'"
					)
					.get()
			).toEqual({ name: 'destination_country' });
			expect(
				database
					.prepare("SELECT name FROM sqlite_schema WHERE name = '_pricing_migration_guard'")
					.get()
			).toBeUndefined();
		}
	);

	it('creates the exact initial schema with enforced foreign keys', () => {
		const database = openDatabase(':memory:');

		migrate(database, initialMigrationsDirectory);

		expect(() =>
			database
				.prepare(
					`INSERT INTO checkout_draft_lines (
						draft_id, line_index, stripe_product_id, stripe_price_id, product_name,
						variant_label, sku, styria_product_number, design_reference, design_json,
						quantity, unit_amount, currency
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					'missing-draft',
					0,
					'prod_test',
					'price_test',
					'Test product',
					'M',
					'SKU-TEST',
					'STYRIA-TEST',
					'design-test',
					'{}',
					1,
					2_000,
					'eur'
				)
		).toThrow();
		expect(
			database
				.prepare("SELECT name, [notnull] FROM pragma_table_info('support_notes') ORDER BY cid")
				.all()
		).toContainEqual({ name: 'note', notnull: 0 });
		expect(
			database
				.prepare(
					`SELECT name FROM sqlite_schema
					 WHERE type = 'table' AND name IN (
						'withdrawal_cases', 'withdrawal_case_events', 'withdrawal_messages'
					 ) ORDER BY name`
				)
				.all()
		).toEqual([
			{ name: 'withdrawal_case_events' },
			{ name: 'withdrawal_cases' },
			{ name: 'withdrawal_messages' }
		]);
	});

	it('upgrades a migration-0004 database without changing existing rows', () => {
		const directory = temporaryDirectory();
		for (const name of [
			'0001_initial.sql',
			'0002_support_note_text.sql',
			'0003_styria_sync_cursor.sql',
			'0004_operational_alert_metadata.sql'
		]) {
			writeFileSync(
				join(directory, name),
				readFileSync(join(initialMigrationsDirectory, name), 'utf8')
			);
		}
		const database = openDatabase(':memory:');
		migrate(database, directory);
		database
			.prepare(
				`INSERT INTO outbox_jobs (
					kind, idempotency_key, order_id, attempt_count, next_attempt_at,
					alert_code, alert_subject_id, alert_observed_at
				) VALUES ('operational-alert', 'alert:DISK_LOW:data-volume:2026-07-17T08', NULL, 0,
					'2026-07-17T08:00:00.000Z', 'DISK_LOW', 'data-volume',
					'2026-07-17T08:00:00.000Z')`
			)
			.run();
		writeFileSync(
			join(directory, '0005_withdrawal_cases.sql'),
			readFileSync(join(initialMigrationsDirectory, '0005_withdrawal_cases.sql'), 'utf8')
		);

		migrate(database, directory);

		expect(database.prepare('SELECT idempotency_key FROM outbox_jobs').get()).toEqual({
			idempotency_key: 'alert:DISK_LOW:data-volume:2026-07-17T08'
		});
		expect(
			database
				.prepare('SELECT name FROM _migrations ORDER BY name')
				.all()
				.map((row) => (row as { name: string }).name)
		).toEqual([
			'0001_initial.sql',
			'0002_support_note_text.sql',
			'0003_styria_sync_cursor.sql',
			'0004_operational_alert_metadata.sql',
			'0005_withdrawal_cases.sql'
		]);
		expect(
			database.prepare("SELECT name FROM sqlite_schema WHERE name = 'withdrawal_cases'").get()
		).toEqual({ name: 'withdrawal_cases' });
	});

	it('adds nullable support note text to an existing database without losing rows', () => {
		const directory = temporaryDirectory();
		writeFileSync(
			join(directory, '0001_initial.sql'),
			`CREATE TABLE support_notes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				order_id TEXT NOT NULL,
				outcome TEXT NOT NULL,
				external_reference TEXT,
				actor TEXT NOT NULL,
				created_at TEXT NOT NULL
			);`
		);
		const database = openDatabase(':memory:');
		migrate(database, directory);
		database
			.prepare(
				`INSERT INTO support_notes (order_id, outcome, external_reference, actor, created_at)
				VALUES ('order_existing', 'return_approved', 'case-existing', 'codex-admin',
					'2026-07-17T09:00:00.000Z')`
			)
			.run();
		writeFileSync(
			join(directory, '0002_support_note_text.sql'),
			readFileSync(join(initialMigrationsDirectory, '0002_support_note_text.sql'), 'utf8')
		);

		migrate(database, directory);

		expect(
			database
				.prepare('SELECT order_id, outcome, note, external_reference FROM support_notes')
				.get()
		).toEqual({
			order_id: 'order_existing',
			outcome: 'return_approved',
			note: null,
			external_reference: 'case-existing'
		});
		expect(database.prepare('SELECT name FROM _migrations ORDER BY name').all()).toEqual([
			{ name: '0001_initial.sql' },
			{ name: '0002_support_note_text.sql' }
		]);
	});

	it('adds the nullable Styria sync cursor to existing orders without changing order state', () => {
		const directory = temporaryDirectory();
		writeFileSync(
			join(directory, '0001_initial.sql'),
			`CREATE TABLE orders (
				id TEXT PRIMARY KEY,
				fulfillment_status TEXT NOT NULL,
				styria_status TEXT,
				updated_at TEXT NOT NULL
			);`
		);
		const database = openDatabase(':memory:');
		migrate(database, directory);
		database
			.prepare(
				`INSERT INTO orders (id, fulfillment_status, styria_status, updated_at)
				VALUES ('order_existing', 'awaiting_vendor_payment', 'received',
					'2026-07-17T09:00:00.000Z')`
			)
			.run();
		writeFileSync(
			join(directory, '0003_styria_sync_cursor.sql'),
			readFileSync(join(initialMigrationsDirectory, '0003_styria_sync_cursor.sql'), 'utf8')
		);

		migrate(database, directory);

		expect(
			database
				.prepare(
					`SELECT id, fulfillment_status, styria_status, updated_at, styria_last_checked_at
					FROM orders`
				)
				.get()
		).toEqual({
			id: 'order_existing',
			fulfillment_status: 'awaiting_vendor_payment',
			styria_status: 'received',
			updated_at: '2026-07-17T09:00:00.000Z',
			styria_last_checked_at: null
		});
		expect(database.prepare('SELECT name FROM _migrations ORDER BY name').all()).toEqual([
			{ name: '0001_initial.sql' },
			{ name: '0003_styria_sync_cursor.sql' }
		]);
	});

	it('adds automatic submission approvals and queues existing paid orders without losing approvals', () => {
		const directory = temporaryDirectory();
		for (const name of [
			'0001_initial.sql',
			'0002_support_note_text.sql',
			'0003_styria_sync_cursor.sql',
			'0004_operational_alert_metadata.sql',
			'0005_withdrawal_cases.sql',
			'0006_production_details.sql',
			'0007_dynamic_destination_pricing.sql',
			'0008_inclusive_shipping.sql'
		]) {
			writeFileSync(
				join(directory, name),
				readFileSync(join(initialMigrationsDirectory, name), 'utf8')
			);
		}
		const database = openDatabase(':memory:');
		migrate(database, directory);
		database.exec(`
			INSERT INTO checkout_drafts (
				id, stripe_checkout_session_id, contract_version, currency, total_unit_count,
				shipping_mode, destination_country, shipping_rate_id, shipping_gross_amount,
				created_at, expires_at, completed_at
			) VALUES (
				'draft_auto', 'cs_auto', 4, 'eur', 1, 'paid', 'SE', 'shr_auto', 500,
				'2026-08-19T09:00:00.000Z', '2026-08-19T10:00:00.000Z',
				'2026-08-19T09:05:00.000Z'
			);
			INSERT INTO orders (
				id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
				checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
				shipping_tax_amount, tax_amount, total_amount, destination_country,
				payment_status, fulfillment_status, updated_at
			) VALUES (
				'order_auto', 'cs_auto', 'pi_auto', 'cus_auto', 'draft_auto', 'eur',
				2000, 0, 500, 100, 400, 3000, 'SE', 'paid', 'pending_review',
				'2026-08-19T09:05:00.000Z'
			);
			INSERT INTO submission_approvals (
				id, order_id, payload_hash, actor, expires_at, used_at
			) VALUES (
				'approval_manual', 'order_auto', 'hash', 'codex-admin',
				'2026-08-19T09:15:00.000Z', '2026-08-19T09:10:00.000Z'
			);
		`);
		writeFileSync(
			join(directory, '0009_automatic_styria_submission.sql'),
			readFileSync(join(initialMigrationsDirectory, '0009_automatic_styria_submission.sql'), 'utf8')
		);

		migrate(database, directory);

		expect(database.prepare('SELECT * FROM submission_approvals').get()).toMatchObject({
			id: 'approval_manual',
			order_id: 'order_auto',
			actor: 'codex-admin',
			used_at: '2026-08-19T09:10:00.000Z'
		});
		database
			.prepare(
				`INSERT INTO submission_approvals (id, order_id, payload_hash, actor, expires_at)
				 VALUES ('approval_auto', 'order_auto', 'hash-auto', 'system-auto',
				 '2026-08-19T09:20:00.000Z')`
			)
			.run();
		expect(() =>
			database
				.prepare(
					`INSERT INTO submission_approvals (id, order_id, payload_hash, actor, expires_at)
					 VALUES ('approval_bad', 'order_auto', 'hash-bad', 'operator',
					 '2026-08-19T09:20:00.000Z')`
				)
				.run()
		).toThrow(/CHECK constraint failed/);
		expect(
			database
				.prepare(
					`SELECT kind, idempotency_key, order_id, next_attempt_at
					 FROM outbox_jobs WHERE idempotency_key = 'styria-create:order_auto'`
				)
				.get()
		).toEqual({
			kind: 'styria-create',
			idempotency_key: 'styria-create:order_auto',
			order_id: 'order_auto',
			next_attempt_at: '2026-08-19T09:05:00.000Z'
		});
		expect(database.pragma('foreign_key_check')).toEqual([]);
		migrate(database, directory);
		expect(
			database
				.prepare("SELECT COUNT(*) AS count FROM outbox_jobs WHERE kind = 'styria-create'")
				.get()
		).toEqual({ count: 1 });
	});

	it('rolls back automatic-submission migration on a conflicting queue key', () => {
		const directory = temporaryDirectory();
		writeFileSync(
			join(directory, '0001_initial.sql'),
			`CREATE TABLE orders (id TEXT PRIMARY KEY, payment_status TEXT NOT NULL,
				fulfillment_status TEXT NOT NULL, styria_order_id TEXT, updated_at TEXT NOT NULL);
			 CREATE TABLE submission_approvals (
				id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), payload_hash TEXT NOT NULL,
				actor TEXT NOT NULL CHECK (actor = 'codex-admin'), expires_at TEXT NOT NULL, used_at TEXT
			 );
			 CREATE TABLE outbox_jobs (
				id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
				order_id TEXT REFERENCES orders(id), attempt_count INTEGER NOT NULL DEFAULT 0,
				next_attempt_at TEXT NOT NULL, completed_at TEXT, last_error_code TEXT
			 );`
		);
		const database = openDatabase(':memory:');
		migrate(database, directory);
		database.exec(`
			INSERT INTO orders VALUES (
				'order_conflict', 'paid', 'pending_review', NULL, '2026-08-19T09:05:00.000Z'
			);
			INSERT INTO outbox_jobs (kind, idempotency_key, order_id, next_attempt_at) VALUES (
				'wrong-kind', 'styria-create:order_conflict', 'order_conflict',
				'2026-08-19T09:05:00.000Z'
			);
		`);
		writeFileSync(
			join(directory, '0009_automatic_styria_submission.sql'),
			readFileSync(join(initialMigrationsDirectory, '0009_automatic_styria_submission.sql'), 'utf8')
		);

		expect(() => migrate(database, directory)).toThrow();
		expect(
			database.prepare("SELECT name FROM _migrations WHERE name LIKE '0009_%'").get()
		).toBeUndefined();
		expect(() =>
			database
				.prepare(
					`INSERT INTO submission_approvals (id, order_id, payload_hash, actor, expires_at)
					 VALUES ('auto_after_rollback', 'order_conflict', 'hash', 'system-auto',
					 '2026-08-19T09:20:00.000Z')`
				)
				.run()
		).toThrow(/CHECK constraint failed/);
	});
});
