import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteLeaseRepository } from './leases.server';

const migrationsDirectory = resolve('migrations');
const now = new Date('2026-07-16T08:30:00.000Z');

let database: ShopDatabase;
let leases: SqliteLeaseRepository;

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, migrationsDirectory);
	leases = new SqliteLeaseRepository(database);
});

afterEach(() => {
	closeDatabase();
});

describe('SqliteLeaseRepository', () => {
	it('allows only one owner to hold an unexpired lease', () => {
		expect(leases.acquire('outbox', 'owner-a', now, 55_000)).toBe(true);
		expect(leases.acquire('outbox', 'owner-b', now, 55_000)).toBe(false);

		expect(database.prepare('SELECT * FROM job_leases WHERE name = ?').get('outbox')).toEqual({
			name: 'outbox',
			owner_id: 'owner-a',
			expires_at: '2026-07-16T08:30:55.000Z'
		});
	});

	it('lets a new owner take over a lease at its expiry boundary', () => {
		expect(leases.acquire('outbox', 'owner-a', now, 55_000)).toBe(true);

		const expiresAt = new Date(now.getTime() + 55_000);
		expect(leases.acquire('outbox', 'owner-b', expiresAt, 55_000)).toBe(true);
		expect(database.prepare('SELECT * FROM job_leases WHERE name = ?').get('outbox')).toEqual({
			name: 'outbox',
			owner_id: 'owner-b',
			expires_at: '2026-07-16T08:31:50.000Z'
		});
	});

	it('releases a lease only for its current owner', () => {
		expect(leases.acquire('outbox', 'owner-a', now, 55_000)).toBe(true);

		leases.release('outbox', 'owner-b');
		expect(leases.acquire('outbox', 'owner-c', now, 55_000)).toBe(false);

		leases.release('outbox', 'owner-a');
		expect(leases.acquire('outbox', 'owner-c', now, 55_000)).toBe(true);
	});
});
