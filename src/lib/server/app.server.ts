import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteLeaseRepository } from '$lib/server/jobs/leases.server';
import { PaidOrderAlertOutboxWorker } from '$lib/server/jobs/outbox-worker.server';
import { OutboxScheduler, type Scheduler } from '$lib/server/jobs/scheduler.server';
import { createPlunkClient, PLUNK_DEFAULT_TIMEOUT_MS } from '$lib/server/plunk/client.server';

type RuntimeEnvironment = Record<string, string | undefined>;

export type ApplicationStartOptions = {
	environment: RuntimeEnvironment;
	building: boolean;
	test: boolean;
};

export type ApplicationRuntime = {
	database: ShopDatabase;
	scheduler: Scheduler | null;
};

export type ApplicationRuntimeDependencies = {
	migrationsDirectory?: string;
	openDatabase?: typeof openDatabase;
	closeDatabase?: typeof closeDatabase;
	migrate?: typeof migrate;
	createScheduler?: (database: ShopDatabase, environment: RuntimeEnvironment) => Scheduler;
};

export interface ApplicationLifecycle {
	start(options: ApplicationStartOptions): Promise<ApplicationRuntime | null>;
	stop(): Promise<void>;
}

function requiredEnvironmentValue(environment: RuntimeEnvironment, name: string): string {
	const value = environment[name];
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error('APPLICATION_CONFIG_INVALID');
	}
	return value;
}

function schedulerEnabled(environment: RuntimeEnvironment): boolean {
	const value = environment.SCHEDULER_ENABLED;
	if (value === undefined || value === 'false') return false;
	if (value === 'true') return true;
	throw new Error('APPLICATION_CONFIG_INVALID');
}

function createRuntimeScheduler(
	database: ShopDatabase,
	environment: RuntimeEnvironment
): Scheduler {
	const outbox = new SqliteOutboxRepository(database);
	const plunk = createPlunkClient({
		secretKey: requiredEnvironmentValue(environment, 'PLUNK_SECRET_KEY'),
		baseUrl: environment.PLUNK_BASE_URL,
		timeoutMs: PLUNK_DEFAULT_TIMEOUT_MS
	});
	const worker = new PaidOrderAlertOutboxWorker({
		database,
		outbox,
		plunk,
		alertEmail: {
			to: requiredEnvironmentValue(environment, 'ADMIN_EMAIL'),
			from: {
				name: requiredEnvironmentValue(environment, 'PLUNK_FROM_NAME'),
				email: requiredEnvironmentValue(environment, 'PLUNK_FROM_EMAIL')
			},
			replyTo: requiredEnvironmentValue(environment, 'SUPPORT_EMAIL')
		}
	});

	return new OutboxScheduler({
		database,
		leases: new SqliteLeaseRepository(database),
		worker,
		enabled: true,
		ownerId: randomUUID()
	});
}

export function createApplicationLifecycle(
	dependencies: ApplicationRuntimeDependencies = {}
): ApplicationLifecycle {
	const migrationsDirectory = dependencies.migrationsDirectory ?? resolve('migrations');
	const open = dependencies.openDatabase ?? openDatabase;
	const close = dependencies.closeDatabase ?? closeDatabase;
	const applyMigrations = dependencies.migrate ?? migrate;
	const createScheduler = dependencies.createScheduler ?? createRuntimeScheduler;
	let runtime: ApplicationRuntime | null = null;
	let startup: Promise<ApplicationRuntime | null> | null = null;
	let stopping: Promise<void> | null = null;

	const initialize = async (
		options: ApplicationStartOptions
	): Promise<ApplicationRuntime | null> => {
		const databasePath = requiredEnvironmentValue(options.environment, 'DATABASE_PATH');
		const database = open(databasePath);
		let scheduler: Scheduler | null = null;
		try {
			applyMigrations(database, migrationsDirectory);
			scheduler = schedulerEnabled(options.environment)
				? createScheduler(database, options.environment)
				: null;
			scheduler?.start();
			runtime = { database, scheduler };
			return runtime;
		} catch (error) {
			let cleanupError: unknown;
			try {
				await scheduler?.stop();
			} catch (stopError) {
				cleanupError = stopError;
			} finally {
				runtime = null;
				close();
			}
			if (cleanupError !== undefined) {
				throw new AggregateError([error, cleanupError], 'APPLICATION_STARTUP_CLEANUP_FAILED', {
					cause: error
				});
			}
			throw error;
		}
	};

	return {
		start(options): Promise<ApplicationRuntime | null> {
			if (options.building || options.test) return Promise.resolve(null);
			if (startup) return startup;
			if (runtime) return Promise.resolve(runtime);

			const operation = initialize(options);
			const trackedStartup = operation.finally(() => {
				if (startup === trackedStartup) startup = null;
			});
			startup = trackedStartup;
			return trackedStartup;
		},

		stop(): Promise<void> {
			if (stopping) return stopping;

			const operation = (async () => {
				if (startup) {
					try {
						await startup;
					} catch {
						return;
					}
				}
				if (!runtime) return;
				const current = runtime;
				try {
					await current.scheduler?.stop();
				} finally {
					close();
					runtime = null;
				}
			})();
			const trackedStop = operation.finally(() => {
				if (stopping === trackedStop) stopping = null;
			});
			stopping = trackedStop;
			return trackedStop;
		}
	};
}

export const applicationLifecycle = createApplicationLifecycle();
