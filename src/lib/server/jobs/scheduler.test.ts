import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createApplicationLifecycle,
	type ApplicationRuntimeDependencies
} from '$lib/server/app.server';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import type { ShopDatabase } from '$lib/server/db/types';
import type { BackupService } from '$lib/server/backups/service.server';
import type { BackupStore } from '$lib/server/backups/s3.server';
import { PLUNK_DEFAULT_TIMEOUT_MS } from '$lib/server/plunk/client.server';
import type { LeaseRepository } from './leases.server';
import type { OutboxWorker } from './outbox-worker.server';
import type { StyriaSyncJob } from './styria-sync.server';
import {
	SqliteWithdrawalRetentionJob,
	type WithdrawalRetentionJob
} from './withdrawal-retention.server';
import { SqliteOperationalChecksJob, type OperationalChecksJob } from './stale-orders.server';
import { SqliteAlertService } from '$lib/server/monitoring/alerts.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import { SqliteWithdrawalRepository } from '$lib/server/withdrawals/repository.server';
import { SqliteLeaseRepository } from './leases.server';
import {
	BACKUP_JOB_NAME,
	OPERATIONAL_CHECKS_JOB_NAME,
	OUTBOX_JOB_NAME,
	OutboxScheduler,
	STYRIA_SYNC_JOB_NAME,
	WITHDRAWAL_DELIVERY_GUARD_NAME,
	WITHDRAWAL_RETENTION_JOB_NAME,
	type SchedulerTimer,
	type SchedulerTimerHandle
} from './scheduler.server';

const migrationsDirectory = resolve('migrations');
const initialNow = new Date('2026-07-16T08:30:00.000Z');
const withdrawalRuntimeEnvironment = {
	PRODUCTION_ORIGIN: 'https://merch.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	PLUNK_SECRET_KEY: 'sk_test_scheduler',
	PLUNK_FROM_NAME: 'Svelte Society Shop',
	PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
	WITHDRAWAL_DATA_KEY: Buffer.alloc(32, 9).toString('base64'),
	SELLER_LEGAL_NAME: 'Svelte Society Merch AB',
	SELLER_REGISTRATION_NUMBER: '559999-0000',
	SELLER_VAT_NUMBER: 'SE559999000001',
	SELLER_ADDRESS_LINE1: 'Registered Street 1',
	SELLER_POSTAL_CODE: '111 11',
	SELLER_CITY: 'Stockholm',
	SELLER_COUNTRY: 'Sweden',
	SELLER_EMAIL: 'merch@sveltesociety.dev',
	DELIVERY_ESTIMATE_EU: '3–7 business days',
	DELIVERY_ESTIMATE_ASIA: '7–15 business days',
	POLICY_EFFECTIVE_DATE: '2026-07-17'
};
const schedulerRuntimeEnvironment = {
	...withdrawalRuntimeEnvironment,
	DATABASE_PATH: ':memory:',
	DATABASE_BOOTSTRAP: 'false',
	SCHEDULER_ENABLED: 'true',
	ADMIN_EMAIL: 'shop-ops@sveltesociety.dev',
	STRIPE_SECRET_KEY: 'sk_test_scheduler_stripe',
	STYRIA_APP_ID: 'scheduler-app',
	STYRIA_SECRET_KEY: 'scheduler-secret',
	STYRIA_BASE_URL: 'https://styria.scheduler.test',
	S3_ENDPOINT: 'https://s3.scheduler.test',
	S3_BUCKET: 'scheduler-backups',
	S3_REGION: 'eu-north-1',
	S3_ACCESS_KEY_ID: 'scheduler-access',
	S3_SECRET_ACCESS_KEY: 'scheduler-private',
	S3_PREFIX: 'shop-backups',
	S3_FORCE_PATH_STYLE: 'true',
	BACKUP_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
};
const runtimeTemporaryDirectories: string[] = [];

function runtimeTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'svelte-shop-runtime-'));
	runtimeTemporaryDirectories.push(directory);
	return directory;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function settleAsyncWork(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function timerHarness() {
	type TimerEntry = {
		callback: () => void;
		intervalMs: number;
		handle: SchedulerTimerHandle;
		cancelled: boolean;
	};
	const entries: TimerEntry[] = [];
	const schedule: SchedulerTimer = vi.fn((scheduledCallback, intervalMs) => {
		const handle: SchedulerTimerHandle = { unref: vi.fn() };
		entries.push({ callback: scheduledCallback, intervalMs, handle, cancelled: false });
		return handle;
	});
	const cancel = vi.fn((handle: SchedulerTimerHandle) => {
		const entry = entries.find((candidate) => candidate.handle === handle);
		if (entry) entry.cancelled = true;
	});
	const latestActive = (intervalMs: number): TimerEntry | undefined => {
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry.intervalMs === intervalMs && !entry.cancelled) return entry;
		}
	};
	return {
		schedule,
		cancel,
		handles(intervalMs: number) {
			return entries
				.filter((entry) => entry.intervalMs === intervalMs)
				.map((entry) => entry.handle);
		},
		isCancelled(handle: SchedulerTimerHandle) {
			return entries.find((entry) => entry.handle === handle)?.cancelled ?? false;
		},
		fire(intervalMs = 60_000) {
			const entry = latestActive(intervalMs);
			if (!entry) throw new Error('TEST_TIMER_NOT_SCHEDULED');
			entry.callback();
		},
		fireCaptured(intervalMs = 60_000) {
			const entry = [...entries].reverse().find((candidate) => candidate.intervalMs === intervalMs);
			if (!entry) throw new Error('TEST_TIMER_NOT_SCHEDULED');
			entry.callback();
		}
	};
}

function seedDueWithdrawalCases(databaseToSeed: ShopDatabase, dueAt: Date, count: number): void {
	const timestamp = dueAt.toISOString();
	const insert = databaseToSeed.prepare(`
		INSERT INTO withdrawal_cases (
			id, public_reference, status, revision, scope, eligibility, outcome_code,
			schema_version, encryption_key_version, encrypted_payload, payload_nonce,
			payload_tag, dedupe_fingerprint, created_at, updated_at,
			reconciled_at, closed_at, pii_purge_due_at, purged_at
		) VALUES (?, ?, 'closed', 1, 'entire_order', 'eligible_eu', 'WITHDRAWAL_COMPLETED',
			1, 1, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
	`);
	const seed = databaseToSeed.transaction(() => {
		for (let index = 0; index < count; index += 1) {
			insert.run(
				`retention_scheduler_case_${index}`,
				`WDR-${String(index).padStart(22, '0')}`,
				Buffer.from([index + 1]),
				Buffer.alloc(12, index),
				Buffer.alloc(16, index),
				index.toString(16).padStart(64, '0'),
				timestamp,
				timestamp,
				timestamp,
				timestamp
			);
		}
	});
	seed();
}

let database: ShopDatabase;

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, migrationsDirectory);
});

describe('application runtime', () => {
	it('opens and migrates SQLite before starting one scheduler singleton', async () => {
		closeDatabase();
		const sequence: string[] = [];
		const scheduler = {
			start: vi.fn(() => sequence.push('scheduler-started')),
			stop: vi.fn(async () => undefined),
			runOutboxOnce: vi.fn(async () => undefined),
			runStyriaSyncOnce: vi.fn(async () => undefined),
			runBackupOnce: vi.fn(async () => undefined)
		};
		const dependencies: ApplicationRuntimeDependencies = {
			migrationsDirectory,
			async checkReadiness(runtime) {
				sequence.push('readiness-checked');
				expect(runtime.scheduler).toBeNull();
				return { ready: true };
			},
			migrate(databaseToMigrate, directory) {
				sequence.push('migration-started');
				migrate(databaseToMigrate, directory);
				sequence.push('migration-finished');
			},
			createScheduler(databaseForScheduler) {
				sequence.push('scheduler-created');
				expect(
					databaseForScheduler
						.prepare("SELECT name FROM _migrations WHERE name = '0001_initial.sql'")
						.get()
				).toEqual({ name: '0001_initial.sql' });
				return scheduler;
			}
		};
		const application = createApplicationLifecycle(dependencies);
		const options = {
			environment: {
				...withdrawalRuntimeEnvironment,
				DATABASE_PATH: ':memory:',
				SCHEDULER_ENABLED: 'true'
			},
			building: false,
			test: false
		};

		const firstStart = application.start(options);
		const secondStart = application.start(options);

		expect(secondStart).toBe(firstStart);
		const first = await firstStart;
		expect(sequence).toEqual([
			'migration-started',
			'migration-finished',
			'readiness-checked',
			'scheduler-created',
			'scheduler-started'
		]);
		expect(scheduler.start).toHaveBeenCalledOnce();
		await application.stop();
		expect(scheduler.stop).toHaveBeenCalledOnce();
		expect(first?.database.open).toBe(false);
	});

	it('retries red local readiness and activates the scheduler exactly once after it turns green', async () => {
		closeDatabase();
		const timers = timerHarness();
		let ready = false;
		const scheduler = {
			start: vi.fn(),
			stop: vi.fn(async () => undefined),
			runOutboxOnce: vi.fn(async () => undefined),
			runStyriaSyncOnce: vi.fn(async () => undefined),
			runBackupOnce: vi.fn(async () => undefined)
		};
		const createScheduler = vi.fn(() => scheduler);
		const checkReadiness = vi.fn(async (runtime) => {
			expect(application.current()).toBe(runtime);
			expect(runtime.scheduler).toBeNull();
			return { ready };
		});
		const application = createApplicationLifecycle({
			migrationsDirectory,
			checkReadiness,
			createScheduler,
			scheduleSchedulerActivation: timers.schedule,
			cancelSchedulerActivation: timers.cancel,
			schedulerActivationRetryMs: 250
		});

		const runtime = await application.start({
			environment: schedulerRuntimeEnvironment,
			building: false,
			test: false
		});

		expect(checkReadiness).toHaveBeenCalledOnce();
		expect(createScheduler).not.toHaveBeenCalled();
		expect(runtime?.scheduler).toBeNull();
		expect(application.current()).toBe(runtime);
		expect(timers.schedule).toHaveBeenCalledOnce();

		ready = true;
		timers.fire(250);
		await settleAsyncWork();

		expect(checkReadiness).toHaveBeenCalledTimes(2);
		expect(createScheduler).toHaveBeenCalledOnce();
		expect(scheduler.start).toHaveBeenCalledOnce();
		expect(runtime?.scheduler).toBe(scheduler);
		timers.fireCaptured(250);
		await settleAsyncWork();
		expect(checkReadiness).toHaveBeenCalledTimes(2);
		await application.stop();
		expect(scheduler.stop).toHaveBeenCalledOnce();
	});

	it('coalesces concurrent retry callbacks behind one activation probe', async () => {
		closeDatabase();
		const timers = timerHarness();
		const retry = deferred<{ ready: boolean }>();
		const scheduler = {
			start: vi.fn(),
			stop: vi.fn(async () => undefined),
			runOutboxOnce: vi.fn(async () => undefined),
			runStyriaSyncOnce: vi.fn(async () => undefined),
			runBackupOnce: vi.fn(async () => undefined)
		};
		const checkReadiness = vi
			.fn()
			.mockRejectedValueOnce(new Error('temporary local readiness failure'))
			.mockImplementationOnce(() => retry.promise);
		const createScheduler = vi.fn(() => scheduler);
		const application = createApplicationLifecycle({
			migrationsDirectory,
			checkReadiness,
			createScheduler,
			scheduleSchedulerActivation: timers.schedule,
			cancelSchedulerActivation: timers.cancel,
			schedulerActivationRetryMs: 250
		});

		const runtime = await application.start({
			environment: schedulerRuntimeEnvironment,
			building: false,
			test: false
		});
		timers.fireCaptured(250);
		timers.fireCaptured(250);
		await settleAsyncWork();
		expect(checkReadiness).toHaveBeenCalledTimes(2);
		expect(createScheduler).not.toHaveBeenCalled();

		retry.resolve({ ready: true });
		await settleAsyncWork();
		expect(createScheduler).toHaveBeenCalledOnce();
		expect(scheduler.start).toHaveBeenCalledOnce();
		expect(runtime?.scheduler).toBe(scheduler);
		await application.stop();
	});

	it('cancels a pending retry when stopped before readiness turns green', async () => {
		closeDatabase();
		const timers = timerHarness();
		const checkReadiness = vi.fn(async () => ({ ready: false }));
		const createScheduler = vi.fn();
		const application = createApplicationLifecycle({
			migrationsDirectory,
			checkReadiness,
			createScheduler,
			scheduleSchedulerActivation: timers.schedule,
			cancelSchedulerActivation: timers.cancel,
			schedulerActivationRetryMs: 250
		});

		await application.start({
			environment: schedulerRuntimeEnvironment,
			building: false,
			test: false
		});
		const [handle] = timers.handles(250);
		expect(handle).toBeDefined();

		await application.stop();
		expect(handle && timers.isCancelled(handle)).toBe(true);
		timers.fireCaptured(250);
		await settleAsyncWork();
		expect(checkReadiness).toHaveBeenCalledOnce();
		expect(createScheduler).not.toHaveBeenCalled();
	});

	it('waits for an in-flight red probe before closing', async () => {
		closeDatabase();
		const timers = timerHarness();
		const retry = deferred<{ ready: boolean }>();
		const checkReadiness = vi
			.fn()
			.mockResolvedValueOnce({ ready: false })
			.mockImplementationOnce(() => retry.promise);
		const createScheduler = vi.fn();
		const application = createApplicationLifecycle({
			migrationsDirectory,
			checkReadiness,
			createScheduler,
			scheduleSchedulerActivation: timers.schedule,
			cancelSchedulerActivation: timers.cancel,
			schedulerActivationRetryMs: 250
		});

		await application.start({
			environment: schedulerRuntimeEnvironment,
			building: false,
			test: false
		});
		timers.fireCaptured(250);
		await settleAsyncWork();
		let stopped = false;
		const stopping = application.stop().then(() => {
			stopped = true;
		});
		await settleAsyncWork();
		expect(stopped).toBe(false);

		retry.resolve({ ready: true });
		await stopping;
		expect(createScheduler).not.toHaveBeenCalled();
		timers.fireCaptured(250);
		await settleAsyncWork();
		expect(checkReadiness).toHaveBeenCalledTimes(2);
		expect(application.current()).toBeNull();
	});

	it('never starts the scheduler while one-time database bootstrap mode is active', async () => {
		closeDatabase();
		const createScheduler = vi.fn();
		const checkReadiness = vi.fn(async () => ({ ready: true }));
		const application = createApplicationLifecycle({
			migrationsDirectory,
			checkReadiness,
			createScheduler
		});

		const runtime = await application.start({
			environment: { ...schedulerRuntimeEnvironment, DATABASE_BOOTSTRAP: 'true' },
			building: false,
			test: false
		});

		expect(runtime?.scheduler).toBeNull();
		expect(checkReadiness).not.toHaveBeenCalled();
		expect(createScheduler).not.toHaveBeenCalled();
		await application.stop();
	});

	it.each([undefined, 'false'])(
		'does not create a missing database with bootstrap %j',
		async (mode) => {
			closeDatabase();
			const databasePath = join(runtimeTemporaryDirectory(), 'missing.sqlite');
			const application = createApplicationLifecycle({ migrationsDirectory });

			await expect(
				application.start({
					environment: {
						DATABASE_PATH: databasePath,
						DATABASE_BOOTSTRAP: mode,
						SCHEDULER_ENABLED: 'false'
					},
					building: false,
					test: false
				})
			).rejects.toThrow();
			expect(existsSync(databasePath)).toBe(false);
		}
	);

	it('rejects an invalid bootstrap literal without creating the database', async () => {
		closeDatabase();
		const databasePath = join(runtimeTemporaryDirectory(), 'invalid.sqlite');
		const application = createApplicationLifecycle({ migrationsDirectory });

		await expect(
			application.start({
				environment: {
					DATABASE_PATH: databasePath,
					DATABASE_BOOTSTRAP: 'yes',
					SCHEDULER_ENABLED: 'false'
				},
				building: false,
				test: false
			})
		).rejects.toThrowError('APPLICATION_CONFIG_INVALID');
		expect(existsSync(databasePath)).toBe(false);
	});

	it('creates and migrates once in bootstrap mode, then opens only after a false-mode restart', async () => {
		closeDatabase();
		const databasePath = join(runtimeTemporaryDirectory(), 'shop.sqlite');
		const bootstrap = createApplicationLifecycle({ migrationsDirectory });
		const bootstrapRuntime = await bootstrap.start({
			environment: {
				...withdrawalRuntimeEnvironment,
				DATABASE_PATH: databasePath,
				DATABASE_BOOTSTRAP: 'true',
				SCHEDULER_ENABLED: 'false'
			},
			building: false,
			test: false
		});

		expect(existsSync(databasePath)).toBe(true);
		expect(bootstrapRuntime?.scheduler).toBeNull();
		expect(
			bootstrapRuntime?.database.prepare('SELECT name FROM _migrations ORDER BY name').all()
		).toHaveLength(7);
		await bootstrap.stop();

		const production = createApplicationLifecycle({ migrationsDirectory });
		const productionRuntime = await production.start({
			environment: {
				...withdrawalRuntimeEnvironment,
				DATABASE_PATH: databasePath,
				DATABASE_BOOTSTRAP: 'false',
				SCHEDULER_ENABLED: 'false'
			},
			building: false,
			test: false
		});

		expect(productionRuntime?.database.open).toBe(true);
		expect(
			productionRuntime?.database.prepare('SELECT name FROM _migrations ORDER BY name').all()
		).toHaveLength(7);
		await production.stop();
	});

	it('opens and migrates SQLite without constructing a scheduler when disabled', async () => {
		closeDatabase();
		const createScheduler = vi.fn();
		const application = createApplicationLifecycle({ migrationsDirectory, createScheduler });
		expect(application.current()).toBeNull();

		const runtime = await application.start({
			environment: {
				...withdrawalRuntimeEnvironment,
				DATABASE_PATH: ':memory:',
				SCHEDULER_ENABLED: 'false'
			},
			building: false,
			test: false
		});

		expect(runtime?.scheduler).toBeNull();
		expect(application.current()).toBe(runtime);
		expect(createScheduler).not.toHaveBeenCalled();
		expect(runtime?.database.prepare('SELECT name FROM _migrations ORDER BY name').all()).toEqual([
			{ name: '0001_initial.sql' },
			{ name: '0002_support_note_text.sql' },
			{ name: '0003_styria_sync_cursor.sql' },
			{ name: '0004_operational_alert_metadata.sql' },
			{ name: '0005_withdrawal_cases.sql' },
			{ name: '0006_production_details.sql' },
			{ name: '0007_dynamic_destination_pricing.sql' }
		]);
		await application.stop();
		expect(application.current()).toBeNull();
	});

	it('defaults an absent scheduler flag to disabled after database readiness', async () => {
		closeDatabase();
		const createScheduler = vi.fn();
		const application = createApplicationLifecycle({ migrationsDirectory, createScheduler });

		const runtime = await application.start({
			environment: { ...withdrawalRuntimeEnvironment, DATABASE_PATH: ':memory:' },
			building: false,
			test: false
		});

		expect(runtime?.scheduler).toBeNull();
		expect(createScheduler).not.toHaveBeenCalled();
		expect(runtime?.database.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({
			count: 7
		});
		await application.stop();
	});

	it('fails closed on an invalid scheduler flag and closes the ready database', async () => {
		closeDatabase();
		let openedDatabase: ShopDatabase | undefined;
		const createScheduler = vi.fn();
		const application = createApplicationLifecycle({
			migrationsDirectory,
			openDatabase(path) {
				openedDatabase = openDatabase(path);
				return openedDatabase;
			},
			createScheduler
		});

		await expect(
			application.start({
				environment: { DATABASE_PATH: ':memory:', SCHEDULER_ENABLED: 'yes' },
				building: false,
				test: false
			})
		).rejects.toThrowError('APPLICATION_CONFIG_INVALID');
		expect(createScheduler).not.toHaveBeenCalled();
		expect(openedDatabase).toBeUndefined();
	});

	it.each(['ADMIN_EMAIL', 'STRIPE_SECRET_KEY', 'STYRIA_APP_ID', 'STYRIA_SECRET_KEY'])(
		'keeps scheduler off when readiness rejects missing %s',
		async (missingName) => {
			closeDatabase();
			let openedDatabase: ShopDatabase | undefined;
			const application = createApplicationLifecycle({
				migrationsDirectory,
				openDatabase(path) {
					openedDatabase = openDatabase(path);
					return openedDatabase;
				}
			});

			const runtime = await application.start({
				environment: { ...schedulerRuntimeEnvironment, [missingName]: undefined },
				building: false,
				test: false
			});
			expect(runtime?.scheduler).toBeNull();
			expect(openedDatabase?.open).toBe(true);
			await application.stop();
		}
	);

	it.each(['PLUNK_SECRET_KEY', 'PLUNK_FROM_NAME', 'PLUNK_FROM_EMAIL', 'SUPPORT_EMAIL'])(
		'fails withdrawal runtime startup when required sender config %s is missing',
		async (missingName) => {
			closeDatabase();
			let openedDatabase: ShopDatabase | undefined;
			const application = createApplicationLifecycle({
				migrationsDirectory,
				openDatabase(path) {
					openedDatabase = openDatabase(path);
					return openedDatabase;
				}
			});

			await expect(
				application.start({
					environment: { ...schedulerRuntimeEnvironment, [missingName]: undefined },
					building: false,
					test: false
				})
			).rejects.toThrow();
			expect(openedDatabase?.open).toBe(false);
		}
	);

	it('rejects a Styria timeout that would violate the bounded 55-minute sync lease', async () => {
		closeDatabase();
		let openedDatabase: ShopDatabase | undefined;
		const application = createApplicationLifecycle({
			migrationsDirectory,
			openDatabase(path) {
				openedDatabase = openDatabase(path);
				return openedDatabase;
			}
		});

		const runtime = await application.start({
			environment: { ...schedulerRuntimeEnvironment, STYRIA_TIMEOUT_MS: '10001' },
			building: false,
			test: false
		});
		expect(runtime?.scheduler).toBeNull();
		expect(openedDatabase?.open).toBe(true);
		await application.stop();
	});

	it('wires the enabled production scheduler to migrated SQLite and records its immediate run', async () => {
		closeDatabase();
		const objects = new Map<string, { body: Uint8Array; lastModified: Date }>();
		const backupStore: BackupStore = {
			async put(key, body) {
				objects.set(key, { body: Uint8Array.from(body), lastModified: initialNow });
			},
			async get(key) {
				const object = objects.get(key);
				if (!object) throw new Error('missing test object');
				return object.body;
			},
			async list(prefix) {
				return [...objects.entries()]
					.filter(([key]) => key.startsWith(prefix))
					.map(([key, object]) => ({ key, lastModified: object.lastModified }));
			},
			async delete(keys) {
				for (const key of keys) objects.delete(key);
			}
		};
		const createBackupStore = vi.fn(() => backupStore);
		const temporaryDirectory = runtimeTemporaryDirectory();
		const application = createApplicationLifecycle({
			migrationsDirectory,
			checkReadiness: async () => ({ ready: true }),
			createBackupStore
		});

		const runtime = await application.start({
			environment: { ...schedulerRuntimeEnvironment, TMPDIR: temporaryDirectory },
			building: false,
			test: false
		});

		expect(runtime?.scheduler).toBeInstanceOf(OutboxScheduler);
		await runtime?.scheduler?.runBackupOnce(new Date('2026-07-17T02:30:45.000Z'));
		expect(createBackupStore).toHaveBeenCalledOnce();
		expect([...objects.keys()].sort()).toEqual([
			'shop-backups/2026/07/17/shop-20260717T023045Z.sqlite.ssbk',
			'shop-backups/2026/07/17/shop-20260717T023045Z.sqlite.ssbk.sha256'
		]);
		await runtime?.scheduler?.stop();
		expect(
			runtime?.database.prepare('SELECT name, result, error_code FROM job_runs ORDER BY id').all()
		).toEqual(
			expect.arrayContaining([
				{ name: OUTBOX_JOB_NAME, result: 'completed', error_code: null },
				{ name: STYRIA_SYNC_JOB_NAME, result: 'completed', error_code: null },
				{ name: BACKUP_JOB_NAME, result: 'completed', error_code: null }
			])
		);
		await application.stop();
		expect(runtime?.database.open).toBe(false);
	});

	it.each([
		{ building: true, test: false },
		{ building: false, test: true }
	])('has no startup side effects in build, prerender, or test runtimes: %j', async (mode) => {
		const open = vi.fn();
		const application = createApplicationLifecycle({
			migrationsDirectory,
			openDatabase: open as ApplicationRuntimeDependencies['openDatabase']
		});

		await expect(
			application.start({ environment: {}, building: mode.building, test: mode.test })
		).resolves.toBeNull();
		expect(open).not.toHaveBeenCalled();
		await application.stop();
	});

	it('does not construct or start the scheduler when migration readiness fails', async () => {
		closeDatabase();
		const createScheduler = vi.fn();
		let openedDatabase: ShopDatabase | undefined;
		const application = createApplicationLifecycle({
			migrationsDirectory,
			openDatabase(path) {
				openedDatabase = openDatabase(path);
				return openedDatabase;
			},
			migrate() {
				throw new Error('MIGRATION_FAILED');
			},
			createScheduler
		});

		await expect(
			application.start({
				environment: { DATABASE_PATH: ':memory:', SCHEDULER_ENABLED: 'true' },
				building: false,
				test: false
			})
		).rejects.toThrowError('MIGRATION_FAILED');
		expect(createScheduler).not.toHaveBeenCalled();
		expect(openedDatabase?.open).toBe(false);
		await application.stop();
	});

	it.each(['construction', 'start'] as const)(
		'retries scheduler %s failure without tearing down the ready runtime',
		async (failure) => {
			closeDatabase();
			const timers = timerHarness();
			const failedScheduler = {
				start: vi.fn(() => {
					throw new Error('SCHEDULER_START_FAILED');
				}),
				stop: vi.fn(async () => undefined),
				runOutboxOnce: vi.fn(async () => undefined),
				runStyriaSyncOnce: vi.fn(async () => undefined),
				runBackupOnce: vi.fn(async () => undefined)
			};
			const runningScheduler = {
				start: vi.fn(),
				stop: vi.fn(async () => undefined),
				runOutboxOnce: vi.fn(async () => undefined),
				runStyriaSyncOnce: vi.fn(async () => undefined),
				runBackupOnce: vi.fn(async () => undefined)
			};
			const createScheduler = vi
				.fn()
				.mockImplementationOnce(() => {
					if (failure === 'construction') throw new Error('SCHEDULER_CONSTRUCTION_FAILED');
					return failedScheduler;
				})
				.mockReturnValueOnce(runningScheduler);
			const application = createApplicationLifecycle({
				migrationsDirectory,
				createScheduler,
				checkReadiness: async () => ({ ready: true }),
				scheduleSchedulerActivation: timers.schedule,
				cancelSchedulerActivation: timers.cancel,
				schedulerActivationRetryMs: 250
			});

			const runtime = await application.start({
				environment: schedulerRuntimeEnvironment,
				building: false,
				test: false
			});

			expect(runtime?.database.open).toBe(true);
			expect(runtime?.scheduler).toBeNull();
			expect(timers.schedule).toHaveBeenCalledOnce();
			if (failure === 'start') expect(failedScheduler.stop).toHaveBeenCalledOnce();

			timers.fire(250);
			await settleAsyncWork();
			expect(createScheduler).toHaveBeenCalledTimes(2);
			expect(runningScheduler.start).toHaveBeenCalledOnce();
			expect(runtime?.scheduler).toBe(runningScheduler);
			await application.stop();
			expect(runningScheduler.stop).toHaveBeenCalledOnce();
		}
	);
});

afterEach(() => {
	closeDatabase();
	for (const directory of runtimeTemporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('OutboxScheduler', () => {
	it('does not drain or schedule when disabled', async () => {
		const timers = timerHarness();
		const worker: OutboxWorker = { drain: vi.fn() };
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker,
			enabled: false,
			ownerId: 'scheduler-disabled',
			clock: () => initialNow,
			schedule: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		scheduler.start();
		await scheduler.stop();

		expect(worker.drain).not.toHaveBeenCalled();
		expect(timers.schedule).not.toHaveBeenCalled();
		expect(timers.cancel).not.toHaveBeenCalled();
		expect(database.prepare('SELECT * FROM job_runs').all()).toEqual([]);
	});

	it('drains immediately, schedules one unrefed minute timer, and records successful runs', async () => {
		const timers = timerHarness();
		let current = initialNow;
		const worker: OutboxWorker = {
			drain: vi.fn(async (runAt) => {
				expect(runAt).toEqual(current);
				expect(
					database
						.prepare('SELECT owner_id, expires_at FROM job_leases WHERE name = ?')
						.get(OUTBOX_JOB_NAME)
				).toEqual({
					owner_id: 'scheduler-owner',
					expires_at: new Date(current.getTime() + 55_000).toISOString()
				});
				return { completed: 0, rescheduled: 0 };
			})
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker,
			enabled: true,
			ownerId: 'scheduler-owner',
			clock: () => current,
			schedule: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		scheduler.start();
		await scheduler.runOutboxOnce();

		expect(worker.drain).toHaveBeenCalledOnce();
		expect(worker.drain).toHaveBeenCalledWith(initialNow, 3, expect.any(AbortSignal));
		expect(timers.handles(60_000)).toHaveLength(1);
		expect(timers.handles(60_000)[0].unref).toHaveBeenCalledOnce();
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		expect(database.prepare('SELECT * FROM job_runs').all()).toEqual([
			{
				id: 1,
				name: OUTBOX_JOB_NAME,
				owner_id: 'scheduler-owner',
				started_at: initialNow.toISOString(),
				finished_at: initialNow.toISOString(),
				result: 'completed',
				error_code: null
			}
		]);

		current = new Date(initialNow.getTime() + 60_000);
		timers.fire();
		await scheduler.runOutboxOnce();
		expect(worker.drain).toHaveBeenCalledTimes(2);
		expect(
			database.prepare('SELECT started_at, finished_at, result FROM job_runs ORDER BY id').all()
		).toEqual([
			{
				started_at: initialNow.toISOString(),
				finished_at: initialNow.toISOString(),
				result: 'completed'
			},
			{
				started_at: current.toISOString(),
				finished_at: current.toISOString(),
				result: 'completed'
			}
		]);

		await scheduler.stop();
		expect(timers.cancel).toHaveBeenCalledWith(timers.handles(60_000)[0]);
	});

	it('drains commerce then withdrawal messages under the outbox and delivery-guard leases', async () => {
		const sequence: string[] = [];
		let commerceSignal: AbortSignal | undefined;
		const worker: OutboxWorker = {
			drain: vi.fn(async (_now, limit, signal) => {
				sequence.push('commerce');
				expect(limit).toBe(3);
				commerceSignal = signal;
				expect(database.prepare('SELECT COUNT(*) AS count FROM job_leases').get()).toEqual({
					count: 2
				});
				return { completed: 0, rescheduled: 0 };
			})
		};
		const withdrawalWorker = {
			drain: vi.fn(async (_now: Date, limit: number, signal?: AbortSignal) => {
				sequence.push('withdrawal');
				expect(limit).toBe(3);
				expect(signal).toBe(commerceSignal);
				expect(database.prepare('SELECT COUNT(*) AS count FROM job_leases').get()).toEqual({
					count: 2
				});
			})
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker,
			withdrawalWorker,
			enabled: true,
			ownerId: 'scheduler-two-workers',
			clock: () => initialNow
		});

		await scheduler.runOutboxOnce();

		expect(sequence).toEqual(['commerce', 'withdrawal']);
		expect(database.prepare('SELECT result, error_code FROM job_runs').all()).toEqual([
			{ result: 'completed', error_code: null }
		]);
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		await scheduler.stop();
	});

	it('records one failed outbox run when the withdrawal drain fails', async () => {
		const worker: OutboxWorker = {
			drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 }))
		};
		const withdrawalWorker = {
			drain: vi.fn(async () => {
				throw new Error('private withdrawal provider detail');
			})
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker,
			withdrawalWorker,
			enabled: true,
			ownerId: 'scheduler-withdrawal-fails',
			clock: () => initialNow
		});

		await expect(scheduler.runOutboxOnce()).rejects.toThrow('private withdrawal provider detail');
		expect(worker.drain).toHaveBeenCalledOnce();
		expect(withdrawalWorker.drain).toHaveBeenCalledOnce();
		expect(database.prepare('SELECT result, error_code FROM job_runs').all()).toEqual([
			{ result: 'failed', error_code: 'OUTBOX_DRAIN_FAILED' }
		]);
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		await scheduler.stop();
	});

	it('renews its owner lease so a long drain cannot be taken over after 55 seconds', async () => {
		const timers = timerHarness();
		let current = initialNow;
		const longDrain = deferred<{ completed: number; rescheduled: number }>();
		const worker: OutboxWorker = { drain: vi.fn(() => longDrain.promise) };
		const leases = new SqliteLeaseRepository(database);
		const scheduler = new OutboxScheduler({
			database,
			leases,
			worker,
			enabled: true,
			ownerId: 'scheduler-long-drain',
			clock: () => current,
			schedule: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		const activeRun = scheduler.runOutboxOnce();
		await Promise.resolve();
		expect(worker.drain).toHaveBeenCalledOnce();
		expect(timers.handles(20_000)).toHaveLength(1);
		expect(timers.handles(20_000)[0].unref).toHaveBeenCalledOnce();

		current = new Date(initialNow.getTime() + 20_000);
		timers.fire(20_000);
		expect(database.prepare('SELECT expires_at FROM job_leases').get()).toEqual({
			expires_at: '2026-07-16T08:31:15.000Z'
		});

		current = new Date(initialNow.getTime() + 55_000);
		expect(leases.acquire(OUTBOX_JOB_NAME, 'scheduler-contender', current, 55_000)).toBe(false);

		current = new Date(initialNow.getTime() + 60_000);
		timers.fire(20_000);
		expect(database.prepare('SELECT expires_at FROM job_leases').get()).toEqual({
			expires_at: '2026-07-16T08:31:55.000Z'
		});
		expect(leases.acquire(OUTBOX_JOB_NAME, 'scheduler-contender', current, 55_000)).toBe(false);

		longDrain.resolve({ completed: 0, rescheduled: 0 });
		await activeRun;
		expect(timers.isCancelled(timers.handles(20_000)[0])).toBe(true);
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		expect(leases.acquire(OUTBOX_JOB_NAME, 'scheduler-contender', current, 55_000)).toBe(true);
		await scheduler.stop();
	});

	it('retries a transient heartbeat failure before the still-valid lease expires', async () => {
		const timers = timerHarness();
		let current = initialNow;
		const longDrain = deferred<{ completed: number; rescheduled: number }>();
		const worker: OutboxWorker = { drain: vi.fn(() => longDrain.promise) };
		const sqliteLeases = new SqliteLeaseRepository(database);
		const renew = vi
			.fn<LeaseRepository['renew']>()
			.mockImplementationOnce(() => {
				throw new Error('SQLITE_BUSY');
			})
			.mockImplementation((...input) => sqliteLeases.renew(...input));
		const leases: LeaseRepository = {
			acquire: (...input) => sqliteLeases.acquire(...input),
			renew,
			release: (...input) => sqliteLeases.release(...input)
		};
		const scheduler = new OutboxScheduler({
			database,
			leases,
			worker,
			enabled: true,
			ownerId: 'scheduler-transient-renewal',
			clock: () => current,
			schedule: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		const activeRun = scheduler.runOutboxOnce();
		await Promise.resolve();

		current = new Date(initialNow.getTime() + 20_000);
		timers.fire(20_000);
		current = new Date(initialNow.getTime() + 40_000);
		timers.fire(20_000);

		expect(renew).toHaveBeenCalledTimes(2);
		expect(database.prepare('SELECT expires_at FROM job_leases').get()).toEqual({
			expires_at: '2026-07-16T08:31:35.000Z'
		});
		current = new Date(initialNow.getTime() + 55_000);
		expect(leases.acquire(OUTBOX_JOB_NAME, 'scheduler-contender', current, 55_000)).toBe(false);

		longDrain.resolve({ completed: 0, rescheduled: 0 });
		await expect(activeRun).resolves.toBeUndefined();
		await scheduler.stop();
	});

	it('keeps three concurrent shipping jobs with Stripe retries plus Plunk inside the 55-second lease', async () => {
		const timers = timerHarness();
		let current = initialNow;
		const boundedDrain = deferred<{ completed: number; rescheduled: number }>();
		const worker: OutboxWorker = {
			drain: vi.fn((_runAt, limit) => {
				expect(limit).toBe(3);
				return boundedDrain.promise;
			})
		};
		const leases = new SqliteLeaseRepository(database);
		const scheduler = new OutboxScheduler({
			database,
			leases,
			worker,
			enabled: true,
			ownerId: 'scheduler-bounded-owner',
			clock: () => current,
			schedule: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		const activeRun = scheduler.runOutboxOnce();
		await Promise.resolve();
		expect(worker.drain).toHaveBeenCalledOnce();

		current = new Date(initialNow.getTime() + 4 * PLUNK_DEFAULT_TIMEOUT_MS);
		boundedDrain.resolve({ completed: 0, rescheduled: 0 });
		await expect(activeRun).resolves.toBeUndefined();
		expect(current.getTime() - initialNow.getTime()).toBe(40_000);
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);

		current = new Date(initialNow.getTime() + 55_000);
		expect(leases.acquire(OUTBOX_JOB_NAME, 'scheduler-contender', current, 55_000)).toBe(true);
		expect(database.prepare('SELECT owner_id FROM job_leases').get()).toEqual({
			owner_id: 'scheduler-contender'
		});
		expect(database.prepare('SELECT result, error_code FROM job_runs').get()).toEqual({
			result: 'completed',
			error_code: null
		});
		await scheduler.stop();
	});

	it('does not overlap a drain when the minute timer fires during an active run', async () => {
		const timers = timerHarness();
		const firstDrain = deferred<{ completed: number; rescheduled: number }>();
		const worker: OutboxWorker = {
			drain: vi
				.fn<OutboxWorker['drain']>()
				.mockImplementationOnce(() => firstDrain.promise)
				.mockResolvedValue({ completed: 0, rescheduled: 0 })
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker,
			enabled: true,
			ownerId: 'scheduler-no-overlap',
			clock: () => initialNow,
			schedule: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		const activeRun = scheduler.runOutboxOnce();
		await Promise.resolve();
		expect(worker.drain).toHaveBeenCalledOnce();

		timers.fire();
		const overlappingCall = scheduler.runOutboxOnce();
		await Promise.resolve();
		expect(worker.drain).toHaveBeenCalledOnce();

		firstDrain.resolve({ completed: 0, rescheduled: 0 });
		await expect(Promise.all([activeRun, overlappingCall])).resolves.toEqual([
			undefined,
			undefined
		]);

		timers.fire();
		await scheduler.runOutboxOnce();
		expect(worker.drain).toHaveBeenCalledTimes(2);
		await scheduler.stop();
	});

	it('records a worker failure, releases its lease, and recovers on the next minute', async () => {
		const timers = timerHarness();
		const failure = new Error('sensitive provider detail');
		const reportError = vi.fn();
		const worker: OutboxWorker = {
			drain: vi
				.fn<OutboxWorker['drain']>()
				.mockRejectedValueOnce(failure)
				.mockResolvedValue({ completed: 1, rescheduled: 0 })
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker,
			enabled: true,
			ownerId: 'scheduler-recovers',
			clock: () => initialNow,
			schedule: timers.schedule,
			cancel: timers.cancel,
			reportError
		});

		scheduler.start();
		await expect(scheduler.runOutboxOnce()).rejects.toBe(failure);
		expect(reportError).toHaveBeenCalledWith('OUTBOX_DRAIN_FAILED');
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		expect(database.prepare('SELECT result, error_code FROM job_runs ORDER BY id').all()).toEqual([
			{ result: 'failed', error_code: 'OUTBOX_DRAIN_FAILED' }
		]);

		timers.fire();
		await expect(scheduler.runOutboxOnce()).resolves.toBeUndefined();
		expect(worker.drain).toHaveBeenCalledTimes(2);
		expect(database.prepare('SELECT result, error_code FROM job_runs ORDER BY id').all()).toEqual([
			{ result: 'failed', error_code: 'OUTBOX_DRAIN_FAILED' },
			{ result: 'completed', error_code: null }
		]);
		await scheduler.stop();
	});

	it('waits for an active drain during clean shutdown without starting another run', async () => {
		const timers = timerHarness();
		const drain = deferred<{ completed: number; rescheduled: number }>();
		const worker: OutboxWorker = { drain: vi.fn(() => drain.promise) };
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker,
			enabled: true,
			ownerId: 'scheduler-stops',
			clock: () => initialNow,
			schedule: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		await Promise.resolve();
		let stopped = false;
		const stopping = scheduler.stop().then(() => {
			stopped = true;
		});

		expect(stopped).toBe(false);
		expect(timers.cancel).toHaveBeenCalledWith(timers.handles(60_000)[0]);
		expect(worker.drain).toHaveBeenCalledOnce();
		drain.resolve({ completed: 0, rescheduled: 0 });
		await stopping;
		expect(stopped).toBe(true);
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);

		timers.fireCaptured();
		await Promise.resolve();
		expect(worker.drain).toHaveBeenCalledOnce();
	});

	it('atomically rejects new runs, aborts active provider work, and waits for settlement', async () => {
		const timers = timerHarness();
		let receivedSignal: AbortSignal | undefined;
		let providerSettled = false;
		const worker: OutboxWorker = {
			drain: vi.fn(
				(_now: Date, _limit?: number, signal?: AbortSignal) =>
					new Promise<{ completed: number; rescheduled: number }>((resolve) => {
						receivedSignal = signal;
						signal?.addEventListener(
							'abort',
							() => {
								providerSettled = true;
								resolve({ completed: 0, rescheduled: 1 });
							},
							{ once: true }
						);
					})
			)
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker,
			enabled: true,
			ownerId: 'scheduler-aborts',
			clock: () => initialNow,
			schedule: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		await vi.waitFor(() => expect(receivedSignal).toBeInstanceOf(AbortSignal));
		const stopping = scheduler.stop();
		await expect(scheduler.runOutboxOnce()).resolves.toBeUndefined();

		expect(receivedSignal?.aborted).toBe(true);
		await stopping;
		expect(providerSettled).toBe(true);
		expect(worker.drain).toHaveBeenCalledOnce();
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		expect(database.prepare('SELECT result FROM job_runs').all()).toEqual([
			{ result: 'completed' }
		]);
	});

	it('does not start the withdrawal drain after shutdown aborts the commerce drain', async () => {
		let receivedSignal: AbortSignal | undefined;
		const worker: OutboxWorker = {
			drain: vi.fn(
				(_now: Date, _limit?: number, signal?: AbortSignal) =>
					new Promise<{ completed: number; rescheduled: number }>((resolve) => {
						receivedSignal = signal;
						signal?.addEventListener('abort', () => resolve({ completed: 0, rescheduled: 1 }), {
							once: true
						});
					})
			)
		};
		const withdrawalWorker = { drain: vi.fn(async () => undefined) };
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker,
			withdrawalWorker,
			enabled: true,
			ownerId: 'scheduler-aborts-between-drains',
			clock: () => initialNow
		});

		const active = scheduler.runOutboxOnce();
		await vi.waitFor(() => expect(receivedSignal).toBeInstanceOf(AbortSignal));
		const stopping = scheduler.stop();

		await active;
		await stopping;
		expect(withdrawalWorker.drain).not.toHaveBeenCalled();
		expect(database.prepare('SELECT result, error_code FROM job_runs').all()).toEqual([
			{ result: 'completed', error_code: null }
		]);
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
	});

	it('aborts and waits for the withdrawal drain before shutdown releases the shared run', async () => {
		let withdrawalSignal: AbortSignal | undefined;
		let withdrawalSettled = false;
		const worker: OutboxWorker = {
			drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 }))
		};
		const withdrawalWorker = {
			drain: vi.fn(
				(_now: Date, _limit: number, signal?: AbortSignal) =>
					new Promise<void>((resolve) => {
						withdrawalSignal = signal;
						signal?.addEventListener(
							'abort',
							() => {
								withdrawalSettled = true;
								resolve();
							},
							{ once: true }
						);
					})
			)
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker,
			withdrawalWorker,
			enabled: true,
			ownerId: 'scheduler-withdrawal-shutdown',
			clock: () => initialNow
		});

		const active = scheduler.runOutboxOnce();
		await vi.waitFor(() => expect(withdrawalSignal).toBeInstanceOf(AbortSignal));
		const stopping = scheduler.stop();

		expect(withdrawalSignal?.aborted).toBe(true);
		await stopping;
		await active;
		expect(withdrawalSettled).toBe(true);
		expect(worker.drain).toHaveBeenCalledOnce();
		expect(withdrawalWorker.drain).toHaveBeenCalledOnce();
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
	});

	it('runs Styria sync immediately and hourly under a separate 55-minute lease', async () => {
		const timers = timerHarness();
		let current = initialNow;
		const sync: StyriaSyncJob = {
			run: vi.fn(async (runAt) => {
				expect(runAt).toEqual(current);
				expect(
					database
						.prepare('SELECT owner_id, expires_at FROM job_leases WHERE name = ?')
						.get(STYRIA_SYNC_JOB_NAME)
				).toEqual({
					owner_id: 'scheduler-sync-owner',
					expires_at: new Date(current.getTime() + 55 * 60_000).toISOString()
				});
				return { checked: 1, updated: 1, shippingQueued: 1 };
			})
		};
		const worker: OutboxWorker = {
			drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 }))
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker,
			styriaSync: sync,
			enabled: true,
			ownerId: 'scheduler-sync-owner',
			clock: () => current,
			schedule: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		await scheduler.runStyriaSyncOnce();

		expect(sync.run).toHaveBeenCalledOnce();
		expect(timers.handles(60 * 60_000)).toHaveLength(1);
		expect(timers.handles(60 * 60_000)[0].unref).toHaveBeenCalledOnce();
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		expect(
			database.prepare('SELECT name, result, error_code FROM job_runs ORDER BY id').all()
		).toEqual([
			{ name: OUTBOX_JOB_NAME, result: 'completed', error_code: null },
			{ name: STYRIA_SYNC_JOB_NAME, result: 'completed', error_code: null }
		]);

		current = new Date(initialNow.getTime() + 60 * 60_000);
		timers.fire(60 * 60_000);
		await scheduler.runStyriaSyncOnce();
		expect(sync.run).toHaveBeenCalledTimes(2);
		await scheduler.stop();
		expect(timers.cancel).toHaveBeenCalledWith(timers.handles(60 * 60_000)[0]);
	});

	it('does not overlap hourly Styria runs and recovers after a failed run', async () => {
		const timers = timerHarness();
		const first = deferred<{ checked: number; updated: number; shippingQueued: number }>();
		const reportError = vi.fn();
		const sync: StyriaSyncJob = {
			run: vi
				.fn<StyriaSyncJob['run']>()
				.mockImplementationOnce(() => first.promise)
				.mockRejectedValueOnce(new Error('private provider failure'))
				.mockResolvedValue({ checked: 0, updated: 0, shippingQueued: 0 })
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			styriaSync: sync,
			enabled: true,
			ownerId: 'scheduler-sync-recovery',
			clock: () => initialNow,
			schedule: timers.schedule,
			cancel: timers.cancel,
			reportError
		});

		scheduler.start();
		const active = scheduler.runStyriaSyncOnce();
		await Promise.resolve();
		timers.fire(60 * 60_000);
		const overlapping = scheduler.runStyriaSyncOnce();
		expect(sync.run).toHaveBeenCalledOnce();
		first.resolve({ checked: 0, updated: 0, shippingQueued: 0 });
		await Promise.all([active, overlapping]);

		timers.fire(60 * 60_000);
		await expect(scheduler.runStyriaSyncOnce()).rejects.toThrow('private provider failure');
		expect(reportError).toHaveBeenCalledWith('STYRIA_SYNC_FAILED');
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);

		timers.fire(60 * 60_000);
		await expect(scheduler.runStyriaSyncOnce()).resolves.toBeUndefined();
		expect(sync.run).toHaveBeenCalledTimes(3);
		await scheduler.stop();
	});

	it('runs backup at the next 02:30 UTC under a 120-minute lease and schedules the next UTC day', async () => {
		const timers = timerHarness();
		let current = new Date('2026-07-17T01:00:00.000Z');
		const backup: BackupService = {
			run: vi.fn(async (runAt) => {
				expect(runAt).toEqual(current);
				expect(
					database
						.prepare('SELECT owner_id, expires_at FROM job_leases WHERE name = ?')
						.get(BACKUP_JOB_NAME)
				).toEqual({
					owner_id: 'scheduler-backup-owner',
					expires_at: new Date(current.getTime() + 120 * 60_000).toISOString()
				});
				return { objectKey: 'backup/object.ssbk', checksum: 'a'.repeat(64), deleted: 0 };
			})
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			backup,
			enabled: true,
			ownerId: 'scheduler-backup-owner',
			clock: () => current,
			schedule: timers.schedule,
			scheduleBackup: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		await scheduler.runOutboxOnce();
		expect(backup.run).not.toHaveBeenCalled();
		expect(timers.handles(90 * 60_000)).toHaveLength(1);
		expect(timers.handles(90 * 60_000)[0].unref).toHaveBeenCalledOnce();

		current = new Date('2026-07-17T02:30:00.000Z');
		timers.fire(90 * 60_000);
		await scheduler.runBackupOnce();

		expect(backup.run).toHaveBeenCalledOnce();
		expect(backup.run).toHaveBeenCalledWith(current, expect.any(AbortSignal));
		expect(timers.handles(24 * 60 * 60_000)).toHaveLength(1);
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		expect(
			database
				.prepare('SELECT name, result, error_code FROM job_runs WHERE name = ?')
				.all(BACKUP_JOB_NAME)
		).toEqual([{ name: BACKUP_JOB_NAME, result: 'completed', error_code: null }]);
		await scheduler.stop();
	});

	it('recomputes 02:30 UTC across year rollover instead of drifting by a local-day interval', async () => {
		const timers = timerHarness();
		let current = new Date('2026-12-31T23:00:00.000Z');
		const backup: BackupService = {
			run: vi.fn(async () => ({ objectKey: 'key', checksum: 'a'.repeat(64), deleted: 0 }))
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			backup,
			enabled: true,
			ownerId: 'scheduler-backup-rollover',
			clock: () => current,
			schedule: timers.schedule,
			scheduleBackup: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		expect(timers.handles(3.5 * 60 * 60_000)).toHaveLength(1);
		current = new Date('2027-01-01T02:30:00.000Z');
		timers.fire(3.5 * 60 * 60_000);
		await scheduler.runBackupOnce();
		expect(timers.handles(24 * 60 * 60_000)).toHaveLength(1);
		await scheduler.stop();
	});

	it('reports a redacted failure and retries only at the next daily cadence', async () => {
		const timers = timerHarness();
		let current = new Date('2026-07-17T02:29:00.000Z');
		const reportError = vi.fn();
		const backup: BackupService = {
			run: vi
				.fn<BackupService['run']>()
				.mockRejectedValueOnce(new Error('private key credential object-body'))
				.mockResolvedValue({ objectKey: 'key', checksum: 'a'.repeat(64), deleted: 0 })
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			backup,
			enabled: true,
			ownerId: 'scheduler-backup-recovery',
			clock: () => current,
			schedule: timers.schedule,
			scheduleBackup: timers.schedule,
			cancel: timers.cancel,
			reportError
		});

		scheduler.start();
		current = new Date('2026-07-17T02:30:00.000Z');
		timers.fire(60_000);
		await expect(scheduler.runBackupOnce()).rejects.toThrow('private key credential object-body');
		await settleAsyncWork();
		expect(reportError).toHaveBeenCalledWith('BACKUP_FAILED');
		expect(backup.run).toHaveBeenCalledOnce();
		expect(timers.handles(24 * 60 * 60_000)).toHaveLength(1);

		current = new Date('2026-07-18T02:30:00.000Z');
		timers.fire(24 * 60 * 60_000);
		await expect(scheduler.runBackupOnce()).resolves.toBeUndefined();
		expect(backup.run).toHaveBeenCalledTimes(2);
		expect(
			database
				.prepare('SELECT result, error_code FROM job_runs WHERE name = ? ORDER BY id')
				.all(BACKUP_JOB_NAME)
		).toEqual([
			{ result: 'failed', error_code: 'BACKUP_FAILED' },
			{ result: 'completed', error_code: null }
		]);
		await scheduler.stop();
	});

	it('aborts active backup storage work and awaits settlement before shutdown returns', async () => {
		const timers = timerHarness();
		let receivedSignal: AbortSignal | undefined;
		let networkActive = false;
		const backup: BackupService = {
			run: vi.fn(
				async (_runAt, signal) =>
					new Promise<{ objectKey: string; checksum: string; deleted: number }>(
						(_resolve, reject) => {
							receivedSignal = signal;
							networkActive = true;
							signal?.addEventListener(
								'abort',
								() => {
									networkActive = false;
									reject(new Error('provider aborted'));
								},
								{ once: true }
							);
						}
					)
			)
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			backup,
			enabled: true,
			ownerId: 'scheduler-backup-shutdown',
			clock: () => initialNow,
			schedule: timers.schedule,
			scheduleBackup: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		const active = scheduler.runBackupOnce();
		const overlapping = scheduler.runBackupOnce();
		await vi.waitFor(() => expect(receivedSignal).toBeInstanceOf(AbortSignal));
		expect(networkActive).toBe(true);

		const stopping = scheduler.stop();
		expect(receivedSignal?.aborted).toBe(true);
		await expect(active).rejects.toThrow('provider aborted');
		await expect(overlapping).rejects.toThrow('provider aborted');
		await stopping;

		expect(networkActive).toBe(false);
		expect(backup.run).toHaveBeenCalledOnce();
		await expect(scheduler.runBackupOnce()).resolves.toBeUndefined();
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		expect(
			database
				.prepare('SELECT result, error_code FROM job_runs WHERE name = ?')
				.all(BACKUP_JOB_NAME)
		).toEqual([{ result: 'failed', error_code: 'BACKUP_FAILED' }]);
	});

	it('keeps shutdown pending until a non-abortable SQLite snapshot boundary returns', async () => {
		const timers = timerHarness();
		let releaseSnapshot!: () => void;
		const snapshotBoundary = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		let receivedSignal: AbortSignal | undefined;
		const backup: BackupService = {
			run: vi.fn(async (_runAt, signal) => {
				receivedSignal = signal;
				await snapshotBoundary;
				if (signal?.aborted) throw new Error('snapshot returned after shutdown');
				return { objectKey: 'key', checksum: 'a'.repeat(64), deleted: 0 };
			})
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			backup,
			enabled: true,
			ownerId: 'scheduler-backup-snapshot-shutdown',
			clock: () => initialNow,
			schedule: timers.schedule,
			scheduleBackup: timers.schedule,
			cancel: timers.cancel
		});
		scheduler.start();
		const active = scheduler.runBackupOnce();
		await vi.waitFor(() => expect(receivedSignal).toBeInstanceOf(AbortSignal));
		let stopped = false;
		const stopping = scheduler.stop().finally(() => {
			stopped = true;
		});

		expect(receivedSignal?.aborted).toBe(true);
		await Promise.resolve();
		expect(stopped).toBe(false);
		releaseSnapshot();
		await expect(active).rejects.toThrow('snapshot returned after shutdown');
		await stopping;
		expect(stopped).toBe(true);
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
	});

	it('catches up a missed 03:00 operational check after a cold restart only once', async () => {
		const current = new Date('2026-07-17T05:00:00.000Z');
		const firstTimers = timerHarness();
		const firstChecks: OperationalChecksJob = {
			run: vi.fn(async () => ({
				pendingReview: 0,
				reviewRequired: 0,
				shippingUnsent: 0,
				backupMissed: false,
				diskLow: false,
				sqliteNotReady: false
			}))
		};
		const first = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			operationalChecks: firstChecks,
			enabled: true,
			ownerId: 'scheduler-cold-catchup-first',
			clock: () => current,
			schedule: firstTimers.schedule,
			scheduleOperationalChecks: firstTimers.schedule,
			cancel: firstTimers.cancel
		});

		first.start();
		await vi.waitFor(() => expect(firstChecks.run).toHaveBeenCalledOnce());
		await settleAsyncWork();
		expect(firstTimers.handles(22 * 60 * 60_000)).toHaveLength(1);
		await first.stop();
		expect(
			database
				.prepare(
					`SELECT result FROM job_runs
					 WHERE name = 'operational-checks' AND started_at >= ?`
				)
				.all('2026-07-17T03:00:00.000Z')
		).toEqual([{ result: 'completed' }]);

		const secondTimers = timerHarness();
		const secondChecks: OperationalChecksJob = {
			run: vi.fn(async () => ({
				pendingReview: 0,
				reviewRequired: 0,
				shippingUnsent: 0,
				backupMissed: false,
				diskLow: false,
				sqliteNotReady: false
			}))
		};
		const second = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			operationalChecks: secondChecks,
			enabled: true,
			ownerId: 'scheduler-cold-catchup-second',
			clock: () => current,
			schedule: secondTimers.schedule,
			scheduleOperationalChecks: secondTimers.schedule,
			cancel: secondTimers.cancel
		});

		second.start();
		await settleAsyncWork();
		expect(secondChecks.run).not.toHaveBeenCalled();
		expect(secondTimers.handles(22 * 60 * 60_000)).toHaveLength(1);
		await second.stop();
	});

	it.each(['orphan-lease', 'active-run'] as const)(
		'retries a cold operational catch-up at durable lease expiry for an %s',
		async (state) => {
			let current = new Date('2026-07-17T05:00:00.000Z');
			const expiresAt = new Date('2026-07-17T05:15:00.000Z');
			if (state === 'active-run') {
				database
					.prepare(
						`INSERT INTO job_runs (name, owner_id, started_at)
						 VALUES ('operational-checks', 'prior-owner', ?)`
					)
					.run('2026-07-17T04:55:00.000Z');
			}
			database
				.prepare(
					`INSERT INTO job_leases (name, owner_id, expires_at)
					 VALUES ('operational-checks', 'prior-owner', ?)`
				)
				.run(expiresAt.toISOString());
			const timers = timerHarness();
			const checks: OperationalChecksJob = {
				run: vi.fn(async () => ({
					pendingReview: 0,
					reviewRequired: 0,
					shippingUnsent: 0,
					backupMissed: false,
					diskLow: false,
					sqliteNotReady: false
				}))
			};
			const scheduler = new OutboxScheduler({
				database,
				leases: new SqliteLeaseRepository(database),
				worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
				operationalChecks: checks,
				enabled: true,
				ownerId: `scheduler-retry-${state}`,
				clock: () => current,
				schedule: timers.schedule,
				scheduleOperationalChecks: timers.schedule,
				cancel: timers.cancel
			});

			scheduler.start();
			await settleAsyncWork();
			expect(checks.run).not.toHaveBeenCalled();
			expect(timers.handles(15 * 60_000)).toHaveLength(1);

			current = expiresAt;
			timers.fire(15 * 60_000);
			await vi.waitFor(() => expect(checks.run).toHaveBeenCalledOnce());
			await settleAsyncWork();
			expect(
				database
					.prepare(
						`SELECT result FROM job_runs
						 WHERE name = 'operational-checks' AND result = 'completed'`
					)
					.all()
			).toEqual([{ result: 'completed' }]);
			await scheduler.stop();
		}
	);

	it('records an active backup check as deferred and completes without alert after backup recovery', async () => {
		let current = new Date('2026-07-17T03:00:00.000Z');
		const backupExpiresAt = new Date('2026-07-17T04:30:00.000Z');
		database
			.prepare(
				`INSERT INTO job_runs (name, owner_id, started_at)
				 VALUES ('backup', 'backup-owner', ?)`
			)
			.run('2026-07-17T02:30:00.000Z');
		database
			.prepare(
				`INSERT INTO job_leases (name, owner_id, expires_at)
				 VALUES ('backup', 'backup-owner', ?)`
			)
			.run(backupExpiresAt.toISOString());
		const timers = timerHarness();
		const checks = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			readiness: async () => ({
				ready: true,
				checks: { configuration: 'ok', database: 'ok', migrations: 'ok', volume: 'ok', disk: 'ok' }
			})
		});
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			operationalChecks: checks,
			enabled: true,
			ownerId: 'scheduler-backup-recovers',
			clock: () => current,
			schedule: timers.schedule,
			scheduleOperationalChecks: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		await vi.waitFor(() =>
			expect(
				database.prepare("SELECT result FROM job_runs WHERE name = 'operational-checks'").all()
			).toEqual([{ result: 'deferred' }])
		);
		expect(timers.handles(90 * 60_000)).toHaveLength(1);
		database
			.prepare(
				`UPDATE job_runs SET finished_at = ?, result = 'completed'
				 WHERE name = 'backup' AND owner_id = 'backup-owner'`
			)
			.run('2026-07-17T03:30:00.000Z');
		database.prepare("DELETE FROM job_leases WHERE name = 'backup'").run();

		current = backupExpiresAt;
		timers.fire(90 * 60_000);
		await vi.waitFor(() =>
			expect(
				database.prepare("SELECT result FROM job_runs WHERE name = 'operational-checks'").all()
			).toEqual([{ result: 'deferred' }, { result: 'completed' }])
		);
		expect(
			database
				.prepare(
					"SELECT * FROM outbox_jobs WHERE kind = 'operational-alert' AND alert_code = 'BACKUP_MISSED'"
				)
				.all()
		).toEqual([]);
		await scheduler.stop();
	});

	it('alerts when a deferred active backup lease expires', async () => {
		let current = new Date('2026-07-17T03:00:00.000Z');
		const backupExpiresAt = new Date('2026-07-17T04:30:00.000Z');
		database
			.prepare(
				`INSERT INTO job_runs (name, owner_id, started_at)
				 VALUES ('backup', 'abandoned-owner', ?)`
			)
			.run('2026-07-17T02:30:00.000Z');
		database
			.prepare(
				`INSERT INTO job_leases (name, owner_id, expires_at)
				 VALUES ('backup', 'abandoned-owner', ?)`
			)
			.run(backupExpiresAt.toISOString());
		const timers = timerHarness();
		const checks = new SqliteOperationalChecksJob({
			database,
			alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
			readiness: async () => ({
				ready: true,
				checks: { configuration: 'ok', database: 'ok', migrations: 'ok', volume: 'ok', disk: 'ok' }
			})
		});
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			operationalChecks: checks,
			enabled: true,
			ownerId: 'scheduler-backup-abandoned',
			clock: () => current,
			schedule: timers.schedule,
			scheduleOperationalChecks: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		await vi.waitFor(() => expect(timers.handles(90 * 60_000)).toHaveLength(1));
		current = backupExpiresAt;
		timers.fire(90 * 60_000);
		await vi.waitFor(() =>
			expect(
				database
					.prepare(
						"SELECT alert_code FROM outbox_jobs WHERE kind = 'operational-alert' AND alert_code = 'BACKUP_MISSED'"
					)
					.all()
			).toEqual([{ alert_code: 'BACKUP_MISSED' }])
		);
		await scheduler.stop();
	});

	it('recreates a deferred backup retry after process restart and cancels it on stop', async () => {
		let current = new Date('2026-07-17T03:00:00.000Z');
		const backupExpiresAt = new Date('2026-07-17T04:30:00.000Z');
		database
			.prepare(
				`INSERT INTO job_runs (name, owner_id, started_at)
				 VALUES ('backup', 'restart-owner', ?)`
			)
			.run('2026-07-17T02:30:00.000Z');
		database
			.prepare(
				`INSERT INTO job_leases (name, owner_id, expires_at)
				 VALUES ('backup', 'restart-owner', ?)`
			)
			.run(backupExpiresAt.toISOString());
		const createChecks = () =>
			new SqliteOperationalChecksJob({
				database,
				alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
				readiness: async () => ({
					ready: true,
					checks: {
						configuration: 'ok',
						database: 'ok',
						migrations: 'ok',
						volume: 'ok',
						disk: 'ok'
					}
				})
			});
		const firstTimers = timerHarness();
		const first = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			operationalChecks: createChecks(),
			enabled: true,
			ownerId: 'scheduler-deferred-first',
			clock: () => current,
			schedule: firstTimers.schedule,
			scheduleOperationalChecks: firstTimers.schedule,
			cancel: firstTimers.cancel
		});

		first.start();
		await vi.waitFor(() => expect(firstTimers.handles(90 * 60_000)).toHaveLength(1));
		const firstRetry = firstTimers.handles(90 * 60_000)[0];
		await first.stop();
		expect(firstTimers.isCancelled(firstRetry)).toBe(true);

		current = new Date('2026-07-17T03:15:00.000Z');
		const secondTimers = timerHarness();
		const second = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			operationalChecks: createChecks(),
			enabled: true,
			ownerId: 'scheduler-deferred-second',
			clock: () => current,
			schedule: secondTimers.schedule,
			scheduleOperationalChecks: secondTimers.schedule,
			cancel: secondTimers.cancel
		});

		second.start();
		await vi.waitFor(() =>
			expect(
				database.prepare("SELECT result FROM job_runs WHERE name = 'operational-checks'").all()
			).toEqual([{ result: 'deferred' }, { result: 'deferred' }])
		);
		expect(secondTimers.handles(75 * 60_000)).toHaveLength(1);
		const secondRetry = secondTimers.handles(75 * 60_000)[0];
		await second.stop();
		expect(secondTimers.isCancelled(secondRetry)).toBe(true);
	});

	it('runs daily operational checks at 03:00 UTC under one lease and recalculates across rollover', async () => {
		const timers = timerHarness();
		let current = new Date('2026-12-31T02:00:00.000Z');
		const operationalChecks: OperationalChecksJob = {
			run: vi.fn(async (_runAt, signal) => {
				expect(signal).toBeInstanceOf(AbortSignal);
				expect(
					database
						.prepare('SELECT owner_id FROM job_leases WHERE name = ?')
						.get(OPERATIONAL_CHECKS_JOB_NAME)
				).toEqual({ owner_id: 'scheduler-operations-owner' });
				return {
					pendingReview: 0,
					reviewRequired: 0,
					shippingUnsent: 0,
					backupMissed: false,
					diskLow: false,
					sqliteNotReady: false
				};
			})
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			operationalChecks,
			enabled: true,
			ownerId: 'scheduler-operations-owner',
			clock: () => current,
			schedule: timers.schedule,
			scheduleBackup: timers.schedule,
			scheduleOperationalChecks: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		expect(timers.handles(60 * 60_000)).toHaveLength(1);
		current = new Date('2026-12-31T03:00:00.000Z');
		timers.fire(60 * 60_000);
		await scheduler.runOperationalChecksOnce();

		expect(operationalChecks.run).toHaveBeenCalledOnce();
		expect(timers.handles(24 * 60 * 60_000)).toHaveLength(1);
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		expect(
			database
				.prepare('SELECT name, result, error_code FROM job_runs WHERE name = ?')
				.all(OPERATIONAL_CHECKS_JOB_NAME)
		).toEqual([{ name: OPERATIONAL_CHECKS_JOB_NAME, result: 'completed', error_code: null }]);
		await scheduler.stop();
	});

	it('coalesces operational checks, aborts and settles them on shutdown', async () => {
		const timers = timerHarness();
		let receivedSignal: AbortSignal | undefined;
		const operationalChecks: OperationalChecksJob = {
			run: vi.fn(
				(_runAt, signal): ReturnType<OperationalChecksJob['run']> =>
					new Promise((_, reject) => {
						receivedSignal = signal;
						signal?.addEventListener('abort', () => reject(new Error('checks aborted')), {
							once: true
						});
					})
			)
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			operationalChecks,
			enabled: true,
			ownerId: 'scheduler-operations-shutdown',
			clock: () => initialNow,
			schedule: timers.schedule,
			scheduleOperationalChecks: timers.schedule,
			cancel: timers.cancel
		});

		scheduler.start();
		const active = scheduler.runOperationalChecksOnce();
		const overlapping = scheduler.runOperationalChecksOnce();
		await vi.waitFor(() => expect(receivedSignal).toBeInstanceOf(AbortSignal));
		const stopping = scheduler.stop();

		expect(receivedSignal?.aborted).toBe(true);
		await expect(active).rejects.toThrow('checks aborted');
		await expect(overlapping).rejects.toThrow('checks aborted');
		await stopping;
		expect(operationalChecks.run).toHaveBeenCalledOnce();
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
	});

	it.each(['outbox', 'styria-sync', 'backup', 'operational-checks'] as const)(
		'does not alert when shutdown intentionally aborts an active %s run',
		async (kind) => {
			let receivedSignal: AbortSignal | undefined;
			const abortingRun = vi.fn(
				(_now: Date, _limitOrSignal?: number | AbortSignal, maybeSignal?: AbortSignal) =>
					new Promise((_, reject) => {
						const signal = _limitOrSignal instanceof AbortSignal ? _limitOrSignal : maybeSignal;
						receivedSignal = signal;
						signal?.addEventListener('abort', () => reject(new Error('provider aborted')), {
							once: true
						});
					})
			);
			const scheduler = new OutboxScheduler({
				database,
				leases: new SqliteLeaseRepository(database),
				worker:
					kind === 'outbox'
						? ({ drain: abortingRun } as unknown as OutboxWorker)
						: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
				styriaSync:
					kind === 'styria-sync' ? ({ run: abortingRun } as unknown as StyriaSyncJob) : undefined,
				backup: kind === 'backup' ? ({ run: abortingRun } as unknown as BackupService) : undefined,
				operationalChecks:
					kind === 'operational-checks'
						? ({ run: abortingRun } as unknown as OperationalChecksJob)
						: undefined,
				alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
				enabled: true,
				ownerId: `scheduler-shutdown-${kind}`,
				clock: () => initialNow
			});
			const active =
				kind === 'outbox'
					? scheduler.runOutboxOnce()
					: kind === 'styria-sync'
						? scheduler.runStyriaSyncOnce()
						: kind === 'backup'
							? scheduler.runBackupOnce()
							: scheduler.runOperationalChecksOnce();

			await vi.waitFor(() => expect(receivedSignal).toBeInstanceOf(AbortSignal));
			const stopping = scheduler.stop();
			await expect(active).rejects.toThrow('provider aborted');
			await stopping;

			expect(
				database
					.prepare("SELECT idempotency_key FROM outbox_jobs WHERE kind = 'operational-alert'")
					.all()
			).toEqual([]);
			expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		}
	);

	it.each(['outbox', 'styria-sync', 'backup', 'operational-checks'] as const)(
		'alerts a genuine %s failure before shutdown',
		async (kind) => {
			const genuineFailure = vi.fn(async () => {
				throw new Error('genuine provider failure');
			});
			const scheduler = new OutboxScheduler({
				database,
				leases: new SqliteLeaseRepository(database),
				worker:
					kind === 'outbox'
						? ({ drain: genuineFailure } as unknown as OutboxWorker)
						: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
				styriaSync:
					kind === 'styria-sync'
						? ({ run: genuineFailure } as unknown as StyriaSyncJob)
						: undefined,
				backup:
					kind === 'backup' ? ({ run: genuineFailure } as unknown as BackupService) : undefined,
				operationalChecks:
					kind === 'operational-checks'
						? ({ run: genuineFailure } as unknown as OperationalChecksJob)
						: undefined,
				alerts: new SqliteAlertService(new SqliteOutboxRepository(database)),
				enabled: true,
				ownerId: `scheduler-genuine-${kind}`,
				clock: () => initialNow
			});
			const active =
				kind === 'outbox'
					? scheduler.runOutboxOnce()
					: kind === 'styria-sync'
						? scheduler.runStyriaSyncOnce()
						: kind === 'backup'
							? scheduler.runBackupOnce()
							: scheduler.runOperationalChecksOnce();

			await expect(active).rejects.toThrow('genuine provider failure');
			const keys = (
				database
					.prepare(
						"SELECT idempotency_key FROM outbox_jobs WHERE kind = 'operational-alert' ORDER BY id"
					)
					.all() as Array<{ idempotency_key: string }>
			).map((row) => row.idempotency_key);
			expect(keys).toEqual(
				kind === 'backup'
					? [
							'alert:BACKUP_FAILED:daily-backup:2026-07-16T08',
							'alert:SCHEDULER_FAILED:backup:2026-07-16T08'
						]
					: [`alert:SCHEDULER_FAILED:${kind}:2026-07-16T08`]
			);
			await scheduler.stop();
		}
	);

	it('durably alerts backup and scheduler failures without recursive failure storms', async () => {
		const alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
		const backup: BackupService = {
			run: vi.fn(async () => {
				throw new Error('private storage credential and stack');
			})
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			backup,
			alerts,
			enabled: true,
			ownerId: 'scheduler-alert-failure',
			clock: () => initialNow
		});

		await expect(scheduler.runBackupOnce()).rejects.toThrow('private storage credential and stack');
		expect(
			database
				.prepare(
					"SELECT idempotency_key FROM outbox_jobs WHERE kind = 'operational-alert' ORDER BY id"
				)
				.all()
		).toEqual([
			{ idempotency_key: 'alert:BACKUP_FAILED:daily-backup:2026-07-16T08' },
			{ idempotency_key: 'alert:SCHEDULER_FAILED:backup:2026-07-16T08' }
		]);
		expect(JSON.stringify(database.prepare('SELECT * FROM outbox_jobs').all())).not.toContain(
			'private storage credential'
		);

		const failingAlerts = {
			enqueueAlert: vi.fn(() => {
				throw new Error('alert db failure');
			})
		};
		const stormSafe = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: {
				drain: vi.fn(async () => {
					throw new Error('worker failure');
				})
			},
			alerts: failingAlerts,
			enabled: true,
			ownerId: 'scheduler-alert-storm-safe',
			clock: () => initialNow
		});
		await expect(stormSafe.runOutboxOnce()).rejects.toThrow('worker failure');
		expect(failingAlerts.enqueueAlert).toHaveBeenCalledOnce();
	});
});

describe('withdrawal retention scheduling', () => {
	it.each([
		{ priorCompleted: false, expectedRuns: 1 },
		{ priorCompleted: true, expectedRuns: 0 }
	])(
		"checks the latest 03:15 UTC cadence before today's window (prior completed: $priorCompleted)",
		async ({ priorCompleted, expectedRuns }) => {
			const current = new Date('2026-07-17T02:00:00.000Z');
			if (priorCompleted) {
				database
					.prepare(
						`INSERT INTO job_runs (
							name, owner_id, started_at, finished_at, result, error_code
						) VALUES (?, 'retention-prior', ?, ?, 'completed', NULL)`
					)
					.run(
						WITHDRAWAL_RETENTION_JOB_NAME,
						'2026-07-16T03:15:00.000Z',
						'2026-07-16T03:16:00.000Z'
					);
			}
			const timers = timerHarness();
			const retention: WithdrawalRetentionJob = {
				run: vi.fn(async () => ({ purged: 0 }))
			};
			const scheduler = new OutboxScheduler({
				database,
				leases: new SqliteLeaseRepository(database),
				worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
				withdrawalRetention: retention,
				enabled: true,
				ownerId: `retention-before-cadence-${priorCompleted}`,
				clock: () => current,
				schedule: timers.schedule,
				scheduleWithdrawalRetention: timers.schedule,
				cancel: timers.cancel
			});

			scheduler.start();
			await settleAsyncWork();

			expect(retention.run).toHaveBeenCalledTimes(expectedRuns);
			expect(timers.handles(75 * 60_000)).toHaveLength(1);
			await scheduler.stop();
		}
	);

	it('catches up one missed 03:15 UTC run, records completion, and schedules the next day', async () => {
		const current = new Date('2026-07-17T05:00:00.000Z');
		const firstTimers = timerHarness();
		const firstRetention: WithdrawalRetentionJob = {
			run: vi.fn(async () => ({ purged: 0 }))
		};
		const first = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalRetention: firstRetention,
			enabled: true,
			ownerId: 'retention-catchup-first',
			clock: () => current,
			schedule: firstTimers.schedule,
			scheduleWithdrawalRetention: firstTimers.schedule,
			cancel: firstTimers.cancel
		});

		first.start();
		await vi.waitFor(() => expect(firstRetention.run).toHaveBeenCalledOnce());
		await settleAsyncWork();
		expect(firstTimers.handles(22 * 60 * 60_000 + 15 * 60_000)).toHaveLength(1);
		expect(
			database
				.prepare('SELECT name, result, error_code FROM job_runs WHERE name = ?')
				.all(WITHDRAWAL_RETENTION_JOB_NAME)
		).toEqual([{ name: WITHDRAWAL_RETENTION_JOB_NAME, result: 'completed', error_code: null }]);
		await first.stop();

		const secondTimers = timerHarness();
		const secondRetention: WithdrawalRetentionJob = {
			run: vi.fn(async () => ({ purged: 0 }))
		};
		const second = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalRetention: secondRetention,
			enabled: true,
			ownerId: 'retention-catchup-second',
			clock: () => current,
			schedule: secondTimers.schedule,
			scheduleWithdrawalRetention: secondTimers.schedule,
			cancel: secondTimers.cancel
		});

		second.start();
		await settleAsyncWork();
		expect(secondRetention.run).not.toHaveBeenCalled();
		expect(secondTimers.handles(22 * 60 * 60_000 + 15 * 60_000)).toHaveLength(1);
		await second.stop();
	});

	it('records a stable failed run, emits a PII-free alert, and permits a safe retry', async () => {
		const alerts = { enqueueAlert: vi.fn() };
		const retention: WithdrawalRetentionJob = {
			run: vi
				.fn<WithdrawalRetentionJob['run']>()
				.mockRejectedValueOnce(new Error('WITHDRAWAL_RETENTION_FAILED'))
				.mockResolvedValueOnce({ purged: 2 })
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalRetention: retention,
			alerts,
			enabled: true,
			ownerId: 'retention-retry',
			clock: () => initialNow
		});

		await expect(scheduler.runWithdrawalRetentionOnce()).rejects.toThrowError(
			'WITHDRAWAL_RETENTION_FAILED'
		);
		expect(alerts.enqueueAlert).toHaveBeenCalledWith(
			'SCHEDULER_FAILED',
			WITHDRAWAL_RETENTION_JOB_NAME,
			initialNow
		);
		expect(database.prepare('SELECT result, error_code FROM job_runs').all()).toEqual([
			{ result: 'failed', error_code: 'WITHDRAWAL_RETENTION_FAILED' }
		]);

		await expect(scheduler.runWithdrawalRetentionOnce()).resolves.toBeUndefined();
		expect(database.prepare('SELECT result, error_code FROM job_runs ORDER BY id').all()).toEqual([
			{ result: 'failed', error_code: 'WITHDRAWAL_RETENTION_FAILED' },
			{ result: 'completed', error_code: null }
		]);
		await scheduler.stop();
	});

	it('uses the shared guard so withdrawal delivery and purge never overlap', async () => {
		const delivery = deferred<void>();
		const withdrawalWorker = {
			drain: vi.fn(() => delivery.promise)
		};
		const retention: WithdrawalRetentionJob = {
			run: vi.fn(async () => ({ purged: 1 }))
		};
		const sending = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalWorker,
			enabled: true,
			ownerId: 'withdrawal-sender',
			clock: () => initialNow
		});
		const purging = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalRetention: retention,
			enabled: true,
			ownerId: 'withdrawal-purger',
			clock: () => initialNow
		});

		const activeDelivery = sending.runOutboxOnce();
		await vi.waitFor(() => expect(withdrawalWorker.drain).toHaveBeenCalledOnce());
		expect(database.prepare('SELECT name, owner_id FROM job_leases ORDER BY name').all()).toEqual([
			{ name: OUTBOX_JOB_NAME, owner_id: 'withdrawal-sender' },
			{ name: WITHDRAWAL_DELIVERY_GUARD_NAME, owner_id: 'withdrawal-sender' }
		]);

		await expect(purging.runWithdrawalRetentionOnce()).resolves.toBeUndefined();
		expect(retention.run).not.toHaveBeenCalled();
		expect(
			database
				.prepare('SELECT name FROM job_leases WHERE name = ?')
				.all(WITHDRAWAL_RETENTION_JOB_NAME)
		).toEqual([]);

		delivery.resolve();
		await activeDelivery;
		await purging.runWithdrawalRetentionOnce();
		expect(retention.run).toHaveBeenCalledOnce();
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		await sending.stop();
		await purging.stop();
	});

	it('heartbeats both outbox leases and releases the guard before the primary lease', async () => {
		const timers = timerHarness();
		let current = initialNow;
		const delivery = deferred<void>();
		const sqliteLeases = new SqliteLeaseRepository(database);
		const calls: string[] = [];
		const leases: LeaseRepository = {
			acquire(name, ...rest) {
				calls.push(`acquire:${name}`);
				return sqliteLeases.acquire(name, ...rest);
			},
			renew(name, ...rest) {
				calls.push(`renew:${name}`);
				return sqliteLeases.renew(name, ...rest);
			},
			release(name, ...rest) {
				calls.push(`release:${name}`);
				sqliteLeases.release(name, ...rest);
			}
		};
		const scheduler = new OutboxScheduler({
			database,
			leases,
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalWorker: { drain: vi.fn(() => delivery.promise) },
			enabled: true,
			ownerId: 'guard-heartbeat',
			clock: () => current,
			schedule: timers.schedule,
			cancel: timers.cancel
		});

		const active = scheduler.runOutboxOnce();
		await vi.waitFor(() =>
			expect(calls.slice(0, 2)).toEqual([
				`acquire:${OUTBOX_JOB_NAME}`,
				`acquire:${WITHDRAWAL_DELIVERY_GUARD_NAME}`
			])
		);
		current = new Date(initialNow.getTime() + 20_000);
		timers.fire(20_000);
		expect(calls).toContain(`renew:${OUTBOX_JOB_NAME}`);
		expect(calls).toContain(`renew:${WITHDRAWAL_DELIVERY_GUARD_NAME}`);

		delivery.resolve();
		await active;
		expect(calls.slice(-2)).toEqual([
			`release:${WITHDRAWAL_DELIVERY_GUARD_NAME}`,
			`release:${OUTBOX_JOB_NAME}`
		]);
		await scheduler.stop();
	});

	it('holds and heartbeats both 30-minute retention leases while concurrent retention skips', async () => {
		const timers = timerHarness();
		let current = initialNow;
		const running = deferred<{ purged: number }>();
		const retention: WithdrawalRetentionJob = { run: vi.fn(() => running.promise) };
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalRetention: retention,
			enabled: true,
			ownerId: 'retention-heartbeat',
			clock: () => current,
			schedule: timers.schedule,
			cancel: timers.cancel
		});
		const contenderRetention: WithdrawalRetentionJob = {
			run: vi.fn(async () => ({ purged: 0 }))
		};
		const contender = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalRetention: contenderRetention,
			enabled: true,
			ownerId: 'retention-contender',
			clock: () => current
		});

		const active = scheduler.runWithdrawalRetentionOnce();
		await vi.waitFor(() => expect(retention.run).toHaveBeenCalledOnce());
		expect(database.prepare('SELECT name, expires_at FROM job_leases ORDER BY name').all()).toEqual(
			[
				{
					name: WITHDRAWAL_DELIVERY_GUARD_NAME,
					expires_at: new Date(initialNow.getTime() + 30 * 60_000).toISOString()
				},
				{
					name: WITHDRAWAL_RETENTION_JOB_NAME,
					expires_at: new Date(initialNow.getTime() + 30 * 60_000).toISOString()
				}
			]
		);
		await contender.runWithdrawalRetentionOnce();
		expect(contenderRetention.run).not.toHaveBeenCalled();

		current = new Date(initialNow.getTime() + 10 * 60_000);
		timers.fire(10 * 60_000);
		expect(database.prepare('SELECT expires_at FROM job_leases ORDER BY name').all()).toEqual([
			{ expires_at: new Date(current.getTime() + 30 * 60_000).toISOString() },
			{ expires_at: new Date(current.getTime() + 30 * 60_000).toISOString() }
		]);
		running.resolve({ purged: 1 });
		await active;
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		await scheduler.stop();
		await contender.stop();
	});

	it('renews both retention leases between real full purge batches', async () => {
		seedDueWithdrawalCases(database, initialNow, 101);
		const timers = timerHarness();
		let current = initialNow;
		const retention = new SqliteWithdrawalRetentionJob({
			repository: new SqliteWithdrawalRepository(database),
			alerts: { enqueueAlert: vi.fn() }
		});
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalRetention: retention,
			enabled: true,
			ownerId: 'retention-real-batch-heartbeat',
			clock: () => current,
			schedule: timers.schedule,
			cancel: timers.cancel
		});

		const active = scheduler.runWithdrawalRetentionOnce(initialNow);
		await settleAsyncWork();
		expect(
			(
				database
					.prepare('SELECT COUNT(*) AS count FROM withdrawal_cases WHERE purged_at IS NOT NULL')
					.get() as { count: number }
			).count
		).toBe(100);

		current = new Date(initialNow.getTime() + 10 * 60_000);
		timers.fire(10 * 60_000);
		expect(database.prepare('SELECT expires_at FROM job_leases ORDER BY name').all()).toEqual([
			{ expires_at: new Date(current.getTime() + 30 * 60_000).toISOString() },
			{ expires_at: new Date(current.getTime() + 30 * 60_000).toISOString() }
		]);

		await active;
		expect(
			(
				database
					.prepare('SELECT COUNT(*) AS count FROM withdrawal_cases WHERE purged_at IS NOT NULL')
					.get() as { count: number }
			).count
		).toBe(101);
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		await scheduler.stop();
	});

	it('skips both outbox drains while another owner holds the delivery guard and retries safely', async () => {
		const leases = new SqliteLeaseRepository(database);
		expect(
			leases.acquire(WITHDRAWAL_DELIVERY_GUARD_NAME, 'retention-owner', initialNow, 30 * 60_000)
		).toBe(true);
		const worker: OutboxWorker = {
			drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 }))
		};
		const withdrawalWorker = { drain: vi.fn(async () => undefined) };
		const scheduler = new OutboxScheduler({
			database,
			leases,
			worker,
			withdrawalWorker,
			enabled: true,
			ownerId: 'guarded-outbox',
			clock: () => initialNow
		});

		await scheduler.runOutboxOnce();
		expect(worker.drain).not.toHaveBeenCalled();
		expect(withdrawalWorker.drain).not.toHaveBeenCalled();
		expect(database.prepare('SELECT name, owner_id FROM job_leases').all()).toEqual([
			{ name: WITHDRAWAL_DELIVERY_GUARD_NAME, owner_id: 'retention-owner' }
		]);

		leases.release(WITHDRAWAL_DELIVERY_GUARD_NAME, 'retention-owner');
		await scheduler.runOutboxOnce();
		expect(worker.drain).toHaveBeenCalledOnce();
		expect(withdrawalWorker.drain).toHaveBeenCalledOnce();
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		await scheduler.stop();
	});

	it('aborts and waits for active retention before reverse-releasing both leases', async () => {
		let receivedSignal: AbortSignal | undefined;
		let settled = false;
		const alerts = { enqueueAlert: vi.fn() };
		const retention: WithdrawalRetentionJob = {
			run: vi.fn(
				(_now: Date, signal?: AbortSignal) =>
					new Promise<{ purged: number }>((_resolve, reject) => {
						receivedSignal = signal;
						signal?.addEventListener(
							'abort',
							() => {
								settled = true;
								reject(new Error('retention aborted'));
							},
							{ once: true }
						);
					})
			)
		};
		const scheduler = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalRetention: retention,
			alerts,
			enabled: true,
			ownerId: 'retention-shutdown',
			clock: () => initialNow
		});

		const active = scheduler.runWithdrawalRetentionOnce();
		await vi.waitFor(() => expect(receivedSignal).toBeInstanceOf(AbortSignal));
		const stopping = scheduler.stop();

		expect(receivedSignal?.aborted).toBe(true);
		await expect(active).rejects.toThrow('retention aborted');
		await stopping;
		expect(settled).toBe(true);
		expect(alerts.enqueueAlert).not.toHaveBeenCalled();
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);
		expect(database.prepare('SELECT result, error_code FROM job_runs').all()).toEqual([
			{ result: 'failed', error_code: 'WITHDRAWAL_RETENTION_FAILED' }
		]);
	});
});
