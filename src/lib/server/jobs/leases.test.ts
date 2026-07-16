import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

	it('renews an unexpired lease only for its current owner', () => {
		expect(leases.acquire('outbox', 'owner-a', now, 55_000)).toBe(true);
		const heartbeatAt = new Date(now.getTime() + 20_000);

		expect(leases.renew('outbox', 'owner-b', heartbeatAt, 55_000)).toBe(false);
		expect(leases.renew('outbox', 'owner-a', heartbeatAt, 55_000)).toBe(true);
		expect(database.prepare('SELECT * FROM job_leases WHERE name = ?').get('outbox')).toEqual({
			name: 'outbox',
			owner_id: 'owner-a',
			expires_at: '2026-07-16T08:31:15.000Z'
		});

		const renewedExpiry = new Date('2026-07-16T08:31:15.000Z');
		expect(leases.renew('outbox', 'owner-a', renewedExpiry, 55_000)).toBe(false);
		expect(leases.acquire('outbox', 'owner-b', renewedExpiry, 55_000)).toBe(true);
	});

	it('enforces lease ownership across two connections to a real database file', () => {
		closeDatabase();
		const directory = mkdtempSync(join(tmpdir(), 'shop-lease-contention-'));
		const path = join(directory, 'shop.sqlite');
		const firstDatabase = new Database(path);
		const secondDatabase = new Database(path);

		try {
			migrate(firstDatabase, migrationsDirectory);
			const first = new SqliteLeaseRepository(firstDatabase);
			const second = new SqliteLeaseRepository(secondDatabase);

			expect(first.acquire('outbox', 'process-a', now, 55_000)).toBe(true);
			expect(second.acquire('outbox', 'process-b', now, 55_000)).toBe(false);

			const expiry = new Date(now.getTime() + 55_000);
			expect(second.acquire('outbox', 'process-b', expiry, 55_000)).toBe(true);
			expect(first.renew('outbox', 'process-a', expiry, 55_000)).toBe(false);
			first.release('outbox', 'process-a');
			expect(secondDatabase.prepare('SELECT owner_id FROM job_leases').get()).toEqual({
				owner_id: 'process-b'
			});
		} finally {
			firstDatabase.close();
			secondDatabase.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
