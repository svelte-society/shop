import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import type { ShopDatabase } from '$lib/server/db/types';
import type { Scheduler } from '$lib/server/jobs/scheduler.server';
import { chmod, mkdtemp, open, readdir, rm, stat, statfs, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createReadinessChecker, type ReadinessDependencies } from './readiness.server';

const migrationsDirectory = resolve('migrations');
const MINIMUM_FREE_BYTES = 256 * 1024 * 1024;

let directory: string;
let databasePath: string;
let database: ShopDatabase;
let detachedDatabase: ShopDatabase | undefined;
let environment: Record<string, string | undefined>;
let scheduler: Scheduler | null;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'svelte-shop-readiness-'));
	databasePath = join(directory, 'shop.sqlite');
	database = openDatabase(databasePath);
	migrate(database, migrationsDirectory);
	scheduler = null;
	environment = {
		STOREFRONT_ENABLED: 'false',
		CHECKOUT_ENABLED: 'false',
		MCP_ENABLED: 'false',
		SCHEDULER_ENABLED: 'false',
		DATABASE_BOOTSTRAP: 'false',
		PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
		SUPPORT_EMAIL: 'merch@sveltesociety.dev',
		STRIPE_WEBHOOK_SECRET: 'whsec_readiness',
		DATABASE_PATH: databasePath
	};
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (detachedDatabase?.open) detachedDatabase.close();
	detachedDatabase = undefined;
	closeDatabase();
	await chmod(databasePath, 0o600).catch(() => undefined);
	await rm(directory, { recursive: true, force: true });
});

function checker(
	overrides: Partial<ReadinessDependencies> = {},
	options: { ignoreSchedulerLatch?: boolean } = {}
) {
	return createReadinessChecker(
		{
			getRuntime: () => ({ database, databasePath, environment, migrationsDirectory, scheduler }),
			...overrides
		},
		options
	);
}

const allOkay = {
	configuration: 'ok',
	database: 'ok',
	migrations: 'ok',
	volume: 'ok',
	disk: 'ok'
} as const;

function enableFulfillment(options: { mcp?: boolean; scheduler?: boolean } = {}): void {
	environment = {
		...environment,
		MCP_ENABLED: options.mcp ? 'true' : 'false',
		SCHEDULER_ENABLED: options.scheduler ? 'true' : 'false',
		STRIPE_SECRET_KEY: 'sk_test_readiness',
		MCP_BEARER_TOKEN: 'a'.repeat(64),
		STYRIA_APP_ID: 'readiness-app',
		STYRIA_SECRET_KEY: 'readiness-secret',
		STYRIA_BRAND_NAME: 'Svelte Society',
		PLUNK_SECRET_KEY: 'plunk-readiness',
		PLUNK_FROM_NAME: 'Svelte Society Shop',
		PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
		ADMIN_EMAIL: 'shop-ops@sveltesociety.dev'
	};
}

function runningScheduler(): Scheduler {
	return {
		start() {},
		async stop() {},
		async runOutboxOnce() {},
		async runStyriaSyncOnce() {}
	};
}

describe('local readiness', () => {
	it('reports a healthy migrated writable database with sufficient disk', async () => {
		await expect(checker()()).resolves.toEqual({ ready: true, checks: allOkay });

		const entries = await readdir(directory);
		expect(entries.filter((name) => name.includes('readiness'))).toEqual([]);
		expect(
			database
				.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '_readiness_write_probe_%'")
				.all()
		).toEqual([]);
		expect(database.inTransaction).toBe(false);
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

	it('fails migration readiness when the ledger contains an unknown migration', async () => {
		database
			.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
			.run('9999_unknown.sql', '2026-07-17T00:00:00.000Z');

		const result = await checker()();

		expect(result.ready).toBe(false);
		expect(result.checks.migrations).toBe('failed');
	});

	it('fails database readiness when PRAGMA quick_check reports corruption', async () => {
		const quickCheck = vi.fn(() => false);

		const result = await checker({ quickCheck })();

		expect(quickCheck).toHaveBeenCalledWith(database);
		expect(result.ready).toBe(false);
		expect(result.checks.database).toBe('failed');
	});

	it('fails database readiness for a genuinely corrupt SQLite page', async () => {
		closeDatabase();
		const file = await open(databasePath, 'r+');
		try {
			await file.write(Buffer.from([0]), 0, 1, 4096);
		} finally {
			await file.close();
		}
		detachedDatabase = new Database(databasePath, { fileMustExist: true });
		database = detachedDatabase;

		const result = await checker()();

		expect(result.ready).toBe(false);
		expect(result.checks.database).toBe('failed');
	});

	it('fails database readiness for a real chmod read-only WAL database', async () => {
		closeDatabase();
		await chmod(databasePath, 0o444);
		detachedDatabase = new Database(databasePath, { fileMustExist: true, readonly: true });
		database = detachedDatabase;

		const result = await checker()();

		expect(result.ready).toBe(false);
		expect(result.checks.database).toBe('failed');
		expect(result.checks.volume).toBe('ok');
		expect(database.inTransaction).toBe(false);
	});

	it('rolls back a failed write probe without poisoning the connection', async () => {
		database.pragma('query_only = ON');

		const failed = await checker()();

		expect(failed.checks.database).toBe('failed');
		expect(database.inTransaction).toBe(false);
		database.pragma('query_only = OFF');
		await expect(checker()()).resolves.toEqual({ ready: true, checks: allOkay });
	});

	it('fails a busy write probe and recovers after the competing writer releases', async () => {
		database.pragma('busy_timeout = 1');
		const contender = new Database(databasePath, { fileMustExist: true });
		contender.exec('BEGIN IMMEDIATE');

		try {
			const blocked = await checker()();
			expect(blocked.checks.database).toBe('failed');
			expect(database.inTransaction).toBe(false);
		} finally {
			contender.exec('ROLLBACK');
			contender.close();
		}

		await expect(checker()()).resolves.toEqual({ ready: true, checks: allOkay });
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

	it('keeps bootstrap mode explicitly not ready until a false-mode restart', async () => {
		environment.DATABASE_BOOTSTRAP = 'true';

		const result = await checker()();

		expect(result.ready).toBe(false);
		expect(result.checks.configuration).toBe('failed');
	});

	it('keeps public readiness red while the required scheduler has not started', async () => {
		enableFulfillment({ scheduler: true });

		const result = await checker()();

		expect(result).toEqual({ ready: false, checks: allOkay });
	});

	it('allows only the internal activation probe to ignore the scheduler-running latch', async () => {
		enableFulfillment({ scheduler: true });

		const result = await checker({}, { ignoreSchedulerLatch: true })();

		expect(result).toEqual({ ready: true, checks: allOkay });
	});

	it.each(['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)])(
		'rejects an enabled MCP bearer that is not 64 lowercase hex characters',
		async (token) => {
			enableFulfillment({ mcp: true });
			environment.MCP_BEARER_TOKEN = token;

			const result = await checker()();

			expect(result.checks.configuration).toBe('failed');
		}
	);

	it.each([
		['SUPPORT_EMAIL', 'not-an-email'],
		['PLUNK_FROM_EMAIL', 'sender-at-example.test'],
		['ADMIN_EMAIL', 'ops-at-example.test']
	])('rejects invalid bounded operational email %s', async (name, value) => {
		enableFulfillment({ scheduler: true });
		environment[name] = value;

		const result = await checker()();

		expect(result.checks.configuration).toBe('failed');
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

	it('reports disk okay at exactly the 256 MiB threshold', async () => {
		const statFileSystem = vi.fn(async () => ({
			bavail: MINIMUM_FREE_BYTES,
			bsize: 1
		}));

		const result = await checker({ statFileSystem })();

		expect(result.ready).toBe(true);
		expect(result.checks.disk).toBe('ok');
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
		enableFulfillment({ mcp: true, scheduler: true });
		scheduler = runningScheduler();
		environment = {
			...environment,
			STOREFRONT_ENABLED: 'true',
			CHECKOUT_ENABLED: 'true',
			STRIPE_PAID_SHIPPING_RATE_ID: 'shr_paid',
			STRIPE_FREE_SHIPPING_RATE_ID: 'shr_free'
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
