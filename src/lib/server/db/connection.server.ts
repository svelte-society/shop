import Database from 'better-sqlite3';
import type { ShopDatabase } from './types';

let activeDatabase: ShopDatabase | undefined;

export function openDatabase(path: string): ShopDatabase {
	if (activeDatabase?.open) return activeDatabase;

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
	return database;
}

export function closeDatabase(): void {
	if (activeDatabase?.open) activeDatabase.close();
	activeDatabase = undefined;
}
