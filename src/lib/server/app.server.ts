import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteLeaseRepository } from '$lib/server/jobs/leases.server';
import { PaidOrderAlertOutboxWorker } from '$lib/server/jobs/outbox-worker.server';
import { OutboxScheduler, type Scheduler } from '$lib/server/jobs/scheduler.server';
import { createPlunkClient } from '$lib/server/plunk/client.server';

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
	start(options: ApplicationStartOptions): ApplicationRuntime | null;
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
		baseUrl: environment.PLUNK_BASE_URL
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

	return {
		start(options): ApplicationRuntime | null {
			if (options.building || options.test) return null;
			if (runtime) return runtime;

			const databasePath = requiredEnvironmentValue(options.environment, 'DATABASE_PATH');
			const database = open(databasePath);
			try {
				applyMigrations(database, migrationsDirectory);
				const scheduler = schedulerEnabled(options.environment)
					? createScheduler(database, options.environment)
					: null;
				runtime = { database, scheduler };
				scheduler?.start();
				return runtime;
			} catch (error) {
				runtime = null;
				close();
				throw error;
			}
		},

		async stop(): Promise<void> {
			if (!runtime) return;
			const current = runtime;
			try {
				await current.scheduler?.stop();
			} finally {
				close();
				runtime = null;
			}
		}
	};
}

export const applicationLifecycle = createApplicationLifecycle();
