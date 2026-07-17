import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { mkdtemp, readdir, rm, stat, statfs, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createReadinessChecker, type ReadinessDependencies } from './readiness.server';

const migrationsDirectory = resolve('migrations');
const MINIMUM_FREE_BYTES = 256 * 1024 * 1024;

let directory: string;
let databasePath: string;
let database: ShopDatabase;
let environment: Record<string, string | undefined>;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'svelte-shop-readiness-'));
	databasePath = join(directory, 'shop.sqlite');
	database = openDatabase(databasePath);
	migrate(database, migrationsDirectory);
	environment = {
		STOREFRONT_ENABLED: 'false',
		CHECKOUT_ENABLED: 'false',
		MCP_ENABLED: 'false',
		SCHEDULER_ENABLED: 'false',
		PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
		SUPPORT_EMAIL: 'merch@sveltesociety.dev',
		STRIPE_WEBHOOK_SECRET: 'whsec_readiness',
		DATABASE_PATH: databasePath
	};
});

afterEach(async () => {
	vi.restoreAllMocks();
	closeDatabase();
	await rm(directory, { recursive: true, force: true });
});

function checker(overrides: Partial<ReadinessDependencies> = {}) {
	return createReadinessChecker({
		getRuntime: () => ({ database, databasePath, environment, migrationsDirectory }),
		...overrides
	});
}

const allOkay = {
	configuration: 'ok',
	database: 'ok',
	migrations: 'ok',
	volume: 'ok',
	disk: 'ok'
} as const;

describe('local readiness', () => {
	it('reports a healthy migrated writable database with sufficient disk', async () => {
		await expect(checker()()).resolves.toEqual({ ready: true, checks: allOkay });

		const entries = await readdir(directory);
		expect(entries.filter((name) => name.includes('readiness'))).toEqual([]);
	});

	it('fails the database check when the configured SQLite file is missing', async () => {
		database.pragma('wal_checkpoint(TRUNCATE)');
		await unlink(databasePath);

		const result = await checker()();

		expect(result.ready).toBe(false);
		expect(result.checks.database).toBe('failed');
	});

	it('fails migration readiness when the current committed ledger is incomplete', async () => {
		database.prepare("DELETE FROM _migrations WHERE name = '0003_styria_sync_cursor.sql'").run();

		const result = await checker()();

		expect(result.ready).toBe(false);
		expect(result.checks.migrations).toBe('failed');
		expect(result.checks.database).toBe('ok');
	});

	it('fails database readiness when PRAGMA quick_check reports corruption', async () => {
		const quickCheck = vi.fn(() => false);

		const result = await checker({ quickCheck })();

		expect(quickCheck).toHaveBeenCalledWith(database);
		expect(result.ready).toBe(false);
		expect(result.checks.database).toBe('failed');
	});

	it('fails volume readiness when the data directory cannot create its sentinel', async () => {
		const openFile = vi.fn(async () => {
			throw Object.assign(new Error('private read-only path'), { code: 'EACCES' });
		});

		const result = await checker({ openFile })();

		expect(openFile).toHaveBeenCalledOnce();
		expect(result.ready).toBe(false);
		expect(result.checks.volume).toBe('failed');
		expect(JSON.stringify(result)).not.toContain(directory);
		expect(JSON.stringify(result)).not.toContain('private read-only path');
	});

	it('closes and removes a created sentinel when fsync fails', async () => {
		const close = vi.fn(async () => undefined);
		const sync = vi.fn(async () => {
			throw new Error('fsync failed at a private path');
		});
		const openFile = vi.fn(async () => ({ close, sync }));
		const unlinkFile = vi.fn(async () => undefined);

		const result = await checker({
			openFile,
			unlinkFile
		})();

		expect(result.checks.volume).toBe('failed');
		expect(sync).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
		expect(unlinkFile).toHaveBeenCalledOnce();
	});

	it('fails configuration readiness without a required production value', async () => {
		environment.STRIPE_WEBHOOK_SECRET = undefined;
		environment.MCP_BEARER_TOKEN = 'never return this token';

		const result = await checker()();
		const serialized = JSON.stringify(result);

		expect(result.ready).toBe(false);
		expect(result.checks.configuration).toBe('failed');
		expect(serialized).not.toContain('STRIPE_WEBHOOK_SECRET');
		expect(serialized).not.toContain('never return this token');
		expect(serialized).not.toContain(databasePath);
	});

	it('reports low disk below the strict 256 MiB threshold', async () => {
		const statFileSystem = vi.fn(async () => ({
			bavail: MINIMUM_FREE_BYTES - 1,
			bsize: 1
		}));

		const result = await checker({
			statFileSystem
		})();

		expect(result.ready).toBe(false);
		expect(result.checks.disk).toBe('low');
	});

	it('reports failed disk without exposing a statfs error', async () => {
		const statFileSystem = vi.fn(async () => {
			throw new Error(`statfs failed for ${directory}`);
		});

		const result = await checker({
			statFileSystem
		})();

		expect(result.ready).toBe(false);
		expect(result.checks.disk).toBe('failed');
		expect(JSON.stringify(result)).not.toContain(directory);
	});

	it('does not call Stripe, Styria, or Plunk during transient provider outages', async () => {
		environment = {
			...environment,
			STOREFRONT_ENABLED: 'true',
			CHECKOUT_ENABLED: 'true',
			MCP_ENABLED: 'true',
			SCHEDULER_ENABLED: 'true',
			STRIPE_SECRET_KEY: 'sk_test_readiness',
			STRIPE_PAID_SHIPPING_RATE_ID: 'shr_paid',
			STRIPE_FREE_SHIPPING_RATE_ID: 'shr_free',
			MCP_BEARER_TOKEN: 'readiness-token',
			STYRIA_APP_ID: 'readiness-app',
			STYRIA_SECRET_KEY: 'readiness-secret',
			STYRIA_BRAND_NAME: 'Svelte Society',
			PLUNK_SECRET_KEY: 'plunk-readiness',
			PLUNK_FROM_NAME: 'Svelte Society Shop',
			PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
			ADMIN_EMAIL: 'shop-ops@sveltesociety.dev'
		};
		const providerFetch = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValue(new Error('all providers unavailable'));

		await expect(checker()()).resolves.toEqual({ ready: true, checks: allOkay });
		expect(providerFetch).not.toHaveBeenCalled();
	});

	it('uses the production filesystem path for stat, statfs, and migration discovery', async () => {
		const inspectPath = vi.fn(async (path: string) => stat(path));
		const inspectDirectory = vi.fn(async (path: string) => readdir(path, { withFileTypes: true }));
		const inspectFileSystem = vi.fn(async (path: string) => statfs(path));

		await checker({
			statPath: inspectPath,
			readDirectory: inspectDirectory,
			statFileSystem: inspectFileSystem
		})();

		expect(inspectPath).toHaveBeenCalledWith(databasePath);
		expect(inspectDirectory).toHaveBeenCalledWith(migrationsDirectory);
		expect(inspectFileSystem).toHaveBeenCalledWith(directory);
	});
});
