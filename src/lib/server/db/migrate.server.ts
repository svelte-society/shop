import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ShopDatabase } from './types';

type MigrationFile = {
	name: string;
	sql: string;
};

function migrationFiles(migrationsDirectory: string): MigrationFile[] {
	return readdirSync(migrationsDirectory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
		.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
		.map((entry) => ({
			name: entry.name,
			sql: readFileSync(join(migrationsDirectory, entry.name), 'utf8')
		}));
}

export function migrate(database: ShopDatabase, migrationsDirectory: string): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			name TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL
		)
	`);

	const findMigration = database.prepare('SELECT name FROM _migrations WHERE name = ?');
	const recordMigration = database.prepare(
		'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)'
	);
	const applyMigration = database.transaction((migration: MigrationFile) => {
		if (findMigration.get(migration.name)) return;
		database.exec(migration.sql);
		recordMigration.run(migration.name, new Date().toISOString());
	});

	for (const migration of migrationFiles(migrationsDirectory)) {
		applyMigration.immediate(migration);
	}
}
