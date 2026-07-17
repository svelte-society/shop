import { resolve } from 'node:path';
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
import { SqliteLeaseRepository } from './leases.server';
import {
	OUTBOX_JOB_NAME,
	OutboxScheduler,
	type SchedulerTimer,
	type SchedulerTimerHandle
} from './scheduler.server';

const migrationsDirectory = resolve('migrations');
const initialNow = new Date('2026-07-16T08:30:00.000Z');
const schedulerRuntimeEnvironment = {
	DATABASE_PATH: ':memory:',
	SCHEDULER_ENABLED: 'true',
	PLUNK_SECRET_KEY: 'sk_test_scheduler',
	ADMIN_EMAIL: 'shop-ops@sveltesociety.dev',
	PLUNK_FROM_NAME: 'Svelte Society Shop',
	PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev'
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
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
			runOutboxOnce: vi.fn(async () => undefined)
		};
		const dependencies: ApplicationRuntimeDependencies = {
			migrationsDirectory,
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
			'scheduler-created',
			'scheduler-started'
		]);
		expect(scheduler.start).toHaveBeenCalledOnce();
		await application.stop();
		expect(scheduler.stop).toHaveBeenCalledOnce();
		expect(first?.database.open).toBe(false);
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
			{ name: '0002_support_note_text.sql' }
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
			count: 2
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
		expect(openedDatabase?.open).toBe(false);
	});

	it.each([
		'PLUNK_SECRET_KEY',
		'ADMIN_EMAIL',
		'PLUNK_FROM_NAME',
		'PLUNK_FROM_EMAIL',
		'SUPPORT_EMAIL'
	])('rejects enabled production scheduler wiring without %s', async (missingName) => {
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
		).rejects.toThrowError('APPLICATION_CONFIG_INVALID');
		expect(openedDatabase?.open).toBe(false);
	});

	it('wires the enabled production scheduler to migrated SQLite and records its immediate run', async () => {
		closeDatabase();
		const application = createApplicationLifecycle({ migrationsDirectory });

		const runtime = await application.start({
			environment: schedulerRuntimeEnvironment,
			building: false,
			test: false
		});

		expect(runtime?.scheduler).toBeInstanceOf(OutboxScheduler);
		await runtime?.scheduler?.stop();
		expect(
			runtime?.database.prepare('SELECT name, result, error_code FROM job_runs ORDER BY id').all()
		).toEqual([{ name: OUTBOX_JOB_NAME, result: 'completed', error_code: null }]);
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

	it('clears a failed startup so a later request can initialize cleanly', async () => {
		closeDatabase();
		const scheduler = {
			start: vi.fn<() => void>().mockImplementationOnce(() => {
				throw new Error('SCHEDULER_START_FAILED');
			}),
			stop: vi.fn(async () => undefined),
			runOutboxOnce: vi.fn(async () => undefined)
		};
		const createScheduler = vi.fn(() => scheduler);
		const application = createApplicationLifecycle({ migrationsDirectory, createScheduler });
		const options = {
			environment: { DATABASE_PATH: ':memory:', SCHEDULER_ENABLED: 'true' },
			building: false,
			test: false
		};

		await expect(application.start(options)).rejects.toThrowError('SCHEDULER_START_FAILED');
		await expect(application.start(options)).resolves.not.toBeNull();

		expect(createScheduler).toHaveBeenCalledTimes(2);
		expect(scheduler.start).toHaveBeenCalledTimes(2);
		await application.stop();
		expect(scheduler.stop).toHaveBeenCalledTimes(2);
	});

	it('awaits partial scheduler cleanup before closing SQLite after startup fails', async () => {
		closeDatabase();
		const cleanup = deferred<void>();
		const startupFailure = new Error('SCHEDULER_START_FAILED');
		const sequence: string[] = [];
		let timerInstalled = false;
		let openedDatabase: ShopDatabase | undefined;
		const scheduler = {
			start: vi.fn(() => {
				timerInstalled = true;
				throw startupFailure;
			}),
			stop: vi.fn(async () => {
				sequence.push('scheduler-stop');
				timerInstalled = false;
				await cleanup.promise;
				sequence.push('scheduler-stopped');
			}),
			runOutboxOnce: vi.fn(async () => undefined)
		};
		const application = createApplicationLifecycle({
			migrationsDirectory,
			openDatabase(path) {
				openedDatabase = openDatabase(path);
				return openedDatabase;
			},
			closeDatabase() {
				sequence.push('database-close');
				closeDatabase();
			},
			createScheduler: () => scheduler
		});

		let startupSettled = false;
		const startup = application
			.start({
				environment: { DATABASE_PATH: ':memory:', SCHEDULER_ENABLED: 'true' },
				building: false,
				test: false
			})
			.finally(() => {
				startupSettled = true;
			});
		await Promise.resolve();

		expect(scheduler.stop).toHaveBeenCalledOnce();
		expect(timerInstalled).toBe(false);
		expect(openedDatabase?.open).toBe(true);
		expect(startupSettled).toBe(false);
		expect(sequence).toEqual(['scheduler-stop']);

		cleanup.resolve();
		await expect(startup).rejects.toBe(startupFailure);
		expect(openedDatabase?.open).toBe(false);
		expect(sequence).toEqual(['scheduler-stop', 'scheduler-stopped', 'database-close']);
	});
});

afterEach(() => {
	closeDatabase();
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

	it('finishes its three-timeout drain bound before exact-expiry takeover', async () => {
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

		current = new Date(initialNow.getTime() + 3 * PLUNK_DEFAULT_TIMEOUT_MS);
		boundedDrain.resolve({ completed: 0, rescheduled: 0 });
		await expect(activeRun).resolves.toBeUndefined();
		expect(current.getTime() - initialNow.getTime()).toBe(30_000);
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
});
