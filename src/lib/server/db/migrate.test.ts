import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
});
