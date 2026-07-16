import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
	});
});
