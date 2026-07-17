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
import { PLUNK_DEFAULT_TIMEOUT_MS } from '$lib/server/plunk/client.server';
import type { LeaseRepository } from './leases.server';
import type { OutboxWorker } from './outbox-worker.server';
import type { StyriaSyncJob } from './styria-sync.server';
import { SqliteLeaseRepository } from './leases.server';
import {
	OUTBOX_JOB_NAME,
	OutboxScheduler,
	STYRIA_SYNC_JOB_NAME,
	type SchedulerTimer,
	type SchedulerTimerHandle
} from './scheduler.server';

const migrationsDirectory = resolve('migrations');
const initialNow = new Date('2026-07-16T08:30:00.000Z');
const schedulerRuntimeEnvironment = {
	DATABASE_PATH: ':memory:',
	DATABASE_BOOTSTRAP: 'false',
	SCHEDULER_ENABLED: 'true',
	PLUNK_SECRET_KEY: 'sk_test_scheduler',
	ADMIN_EMAIL: 'shop-ops@sveltesociety.dev',
	PLUNK_FROM_NAME: 'Svelte Society Shop',
	PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	STRIPE_SECRET_KEY: 'sk_test_scheduler_stripe',
	STYRIA_APP_ID: 'scheduler-app',
	STYRIA_SECRET_KEY: 'scheduler-secret',
	STYRIA_BASE_URL: 'https://styria.scheduler.test'
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
			runStyriaSyncOnce: vi.fn(async () => undefined)
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
			environment: { DATABASE_PATH: ':memory:', SCHEDULER_ENABLED: 'true' },
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
			runStyriaSyncOnce: vi.fn(async () => undefined)
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
			runStyriaSyncOnce: vi.fn(async () => undefined)
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
		).toHaveLength(3);
		await bootstrap.stop();

		const production = createApplicationLifecycle({ migrationsDirectory });
		const productionRuntime = await production.start({
			environment: {
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
		).toHaveLength(3);
		await production.stop();
	});

	it('opens and migrates SQLite without constructing a scheduler when disabled', async () => {
		closeDatabase();
		const createScheduler = vi.fn();
		const application = createApplicationLifecycle({ migrationsDirectory, createScheduler });
		expect(application.current()).toBeNull();

		const runtime = await application.start({
			environment: { DATABASE_PATH: ':memory:', SCHEDULER_ENABLED: 'false' },
			building: false,
			test: false
		});

		expect(runtime?.scheduler).toBeNull();
		expect(application.current()).toBe(runtime);
		expect(createScheduler).not.toHaveBeenCalled();
		expect(runtime?.database.prepare('SELECT name FROM _migrations ORDER BY name').all()).toEqual([
			{ name: '0001_initial.sql' },
			{ name: '0002_support_note_text.sql' },
			{ name: '0003_styria_sync_cursor.sql' }
		]);
		await application.stop();
		expect(application.current()).toBeNull();
	});

	it('defaults an absent scheduler flag to disabled after database readiness', async () => {
		closeDatabase();
		const createScheduler = vi.fn();
		const application = createApplicationLifecycle({ migrationsDirectory, createScheduler });

		const runtime = await application.start({
			environment: { DATABASE_PATH: ':memory:' },
			building: false,
			test: false
		});

		expect(runtime?.scheduler).toBeNull();
		expect(createScheduler).not.toHaveBeenCalled();
		expect(runtime?.database.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({
			count: 3
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

	it.each([
		'PLUNK_SECRET_KEY',
		'ADMIN_EMAIL',
		'PLUNK_FROM_NAME',
		'PLUNK_FROM_EMAIL',
		'SUPPORT_EMAIL',
		'STRIPE_SECRET_KEY',
		'STYRIA_APP_ID',
		'STYRIA_SECRET_KEY'
	])('keeps scheduler off when readiness rejects missing %s', async (missingName) => {
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
	});

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
		const application = createApplicationLifecycle({
			migrationsDirectory,
			checkReadiness: async () => ({ ready: true })
		});

		const runtime = await application.start({
			environment: schedulerRuntimeEnvironment,
			building: false,
			test: false
		});

		expect(runtime?.scheduler).toBeInstanceOf(OutboxScheduler);
		await runtime?.scheduler?.stop();
		expect(
			runtime?.database.prepare('SELECT name, result, error_code FROM job_runs ORDER BY id').all()
		).toEqual([
			{ name: OUTBOX_JOB_NAME, result: 'completed', error_code: null },
			{ name: STYRIA_SYNC_JOB_NAME, result: 'completed', error_code: null }
		]);
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
				runStyriaSyncOnce: vi.fn(async () => undefined)
			};
			const runningScheduler = {
				start: vi.fn(),
				stop: vi.fn(async () => undefined),
				runOutboxOnce: vi.fn(async () => undefined),
				runStyriaSyncOnce: vi.fn(async () => undefined)
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
		expect(worker.drain).toHaveBeenCalledWith(initialNow, 3);
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
});
