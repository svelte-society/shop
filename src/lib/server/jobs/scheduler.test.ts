import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createApplicationLifecycle,
	type ApplicationRuntimeDependencies
} from '$lib/server/app.server';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import type { ShopDatabase } from '$lib/server/db/types';
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
	let callback: (() => void) | undefined;
	const handle: SchedulerTimerHandle = { unref: vi.fn() };
	const schedule: SchedulerTimer = vi.fn((scheduledCallback, intervalMs) => {
		callback = scheduledCallback;
		expect(intervalMs).toBe(60_000);
		return handle;
	});
	const cancel = vi.fn();
	return {
		handle,
		schedule,
		cancel,
		fire() {
			if (!callback) throw new Error('TEST_TIMER_NOT_SCHEDULED');
			callback();
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

		const first = application.start(options);
		const second = application.start(options);

		expect(second).toBe(first);
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

		const runtime = application.start({
			environment: { DATABASE_PATH: ':memory:', SCHEDULER_ENABLED: 'false' },
			building: false,
			test: false
		});

		expect(runtime?.scheduler).toBeNull();
		expect(createScheduler).not.toHaveBeenCalled();
		expect(runtime?.database.prepare('SELECT name FROM _migrations ORDER BY name').all()).toEqual([
			{ name: '0001_initial.sql' }
		]);
		await application.stop();
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

		expect(
			application.start({ environment: {}, building: mode.building, test: mode.test })
		).toBeNull();
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

		expect(() =>
			application.start({
				environment: { DATABASE_PATH: ':memory:', SCHEDULER_ENABLED: 'true' },
				building: false,
				test: false
			})
		).toThrowError('MIGRATION_FAILED');
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

		expect(() => application.start(options)).toThrowError('SCHEDULER_START_FAILED');
		expect(() => application.start(options)).not.toThrow();

		expect(createScheduler).toHaveBeenCalledTimes(2);
		expect(scheduler.start).toHaveBeenCalledTimes(2);
		await application.stop();
		expect(scheduler.stop).toHaveBeenCalledOnce();
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
		expect(timers.schedule).toHaveBeenCalledOnce();
		expect(timers.handle.unref).toHaveBeenCalledOnce();
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
		expect(timers.cancel).toHaveBeenCalledOnce();
		expect(timers.cancel).toHaveBeenCalledWith(timers.handle);
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
		expect(timers.cancel).toHaveBeenCalledWith(timers.handle);
		expect(worker.drain).toHaveBeenCalledOnce();
		drain.resolve({ completed: 0, rescheduled: 0 });
		await stopping;
		expect(stopped).toBe(true);
		expect(database.prepare('SELECT * FROM job_leases').all()).toEqual([]);

		timers.fire();
		await Promise.resolve();
		expect(worker.drain).toHaveBeenCalledOnce();
	});
});
