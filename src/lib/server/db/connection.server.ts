import Database from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ShopDatabase } from './types';

let activeDatabase: ShopDatabase | undefined;
let activeDatabasePath: string | undefined;

function normalizeDatabasePath(path: string): string {
	if (path === ':memory:') return path;

	const absolutePath = resolve(path);
	try {
		return realpathSync.native(absolutePath);
	} catch {
		return absolutePath;
	}
}

export function openDatabase(path: string): ShopDatabase {
	const requestedPath = normalizeDatabasePath(path);
	if (activeDatabase?.open) {
		if (activeDatabasePath !== requestedPath) throw new Error('DATABASE_PATH_MISMATCH');
		return activeDatabase;
	}

	const database = new Database(path);
	try {
		database.pragma('journal_mode = WAL');
		database.pragma('foreign_keys = ON');
		database.pragma('busy_timeout = 5000');
		database.pragma('synchronous = FULL');
	} catch (error) {
		database.close();
		throw error;
	}

	activeDatabase = database;
	activeDatabasePath = normalizeDatabasePath(path);
	return database;
}

export function closeDatabase(): void {
	if (activeDatabase?.open) activeDatabase.close();
	activeDatabase = undefined;
	activeDatabasePath = undefined;
}
