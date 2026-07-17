import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteFulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import { SqliteLeaseRepository } from '$lib/server/jobs/leases.server';
import { PaidOrderAlertOutboxWorker } from '$lib/server/jobs/outbox-worker.server';
import { OutboxScheduler, type Scheduler } from '$lib/server/jobs/scheduler.server';
import { SqliteStyriaSyncJob } from '$lib/server/jobs/styria-sync.server';
import { createPlunkClient, PLUNK_DEFAULT_TIMEOUT_MS } from '$lib/server/plunk/client.server';
import { createShippingEmailSender } from '$lib/server/plunk/shipping-email';
import {
	createStripeClient,
	createStripeFulfillmentGateway
} from '$lib/server/stripe/client.server';
import { createStyriaClient } from '$lib/server/styria/client.server';

type RuntimeEnvironment = Record<string, string | undefined>;

export type ApplicationStartOptions = {
	environment: RuntimeEnvironment;
	building: boolean;
	test: boolean;
};

export type ApplicationRuntime = {
	database: ShopDatabase;
	scheduler: Scheduler | null;
	databasePath: string;
	migrationsDirectory: string;
	environment: RuntimeEnvironment;
};

export type ApplicationRuntimeDependencies = {
	migrationsDirectory?: string;
	openDatabase?: typeof openDatabase;
	closeDatabase?: typeof closeDatabase;
	migrate?: typeof migrate;
	createScheduler?: (database: ShopDatabase, environment: RuntimeEnvironment) => Scheduler;
	checkReadiness?: (runtime: ApplicationRuntime) => Promise<{ ready: boolean }>;
};

export interface ApplicationLifecycle {
	start(options: ApplicationStartOptions): Promise<ApplicationRuntime | null>;
	current(): ApplicationRuntime | null;
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

function databaseBootstrapEnabled(environment: RuntimeEnvironment): boolean {
	const value = environment.DATABASE_BOOTSTRAP;
	if (value === undefined || value === 'false') return false;
	if (value === 'true') return true;
	throw new Error('APPLICATION_CONFIG_INVALID');
}

async function checkRuntimeReadiness(runtime: ApplicationRuntime): Promise<{ ready: boolean }> {
	const readiness = await import('$lib/server/health/readiness.server');
	return readiness.checkRuntimeReadiness(runtime);
}

function optionalPositiveInteger(
	environment: RuntimeEnvironment,
	name: string,
	maximum: number
): number | undefined {
	const value = environment[name];
	if (value === undefined) return undefined;
	if (!/^[1-9]\d*$/.test(value)) throw new Error('APPLICATION_CONFIG_INVALID');
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum) {
		throw new Error('APPLICATION_CONFIG_INVALID');
	}
	return parsed;
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
	const stripe = createStripeFulfillmentGateway(
		createStripeClient(requiredEnvironmentValue(environment, 'STRIPE_SECRET_KEY'))
	);
	const styria = createStyriaClient({
		appId: requiredEnvironmentValue(environment, 'STYRIA_APP_ID'),
		secretKey: requiredEnvironmentValue(environment, 'STYRIA_SECRET_KEY'),
		baseUrl: environment.STYRIA_BASE_URL,
		timeoutMs: optionalPositiveInteger(environment, 'STYRIA_TIMEOUT_MS', 10_000)
	});
	const supportEmail = requiredEnvironmentValue(environment, 'SUPPORT_EMAIL');
	const sender = createShippingEmailSender(plunk, {
		name: requiredEnvironmentValue(environment, 'PLUNK_FROM_NAME'),
		email: requiredEnvironmentValue(environment, 'PLUNK_FROM_EMAIL')
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
			replyTo: supportEmail
		},
		shipping: { stripe, sender, supportEmail }
	});
	const fulfillment = new SqliteFulfillmentRepository(database);
	const styriaSync = new SqliteStyriaSyncJob({ database, styria, fulfillment, outbox });

	return new OutboxScheduler({
		database,
		leases: new SqliteLeaseRepository(database),
		worker,
		styriaSync,
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
	const checkReadiness = dependencies.checkReadiness ?? checkRuntimeReadiness;
	let runtime: ApplicationRuntime | null = null;
	let startup: Promise<ApplicationRuntime | null> | null = null;
	let stopping: Promise<void> | null = null;

	const initialize = async (
		options: ApplicationStartOptions
	): Promise<ApplicationRuntime | null> => {
		const databasePath = requiredEnvironmentValue(options.environment, 'DATABASE_PATH');
		const bootstrap = databaseBootstrapEnabled(options.environment);
		const enableScheduler = schedulerEnabled(options.environment);
		const database = open(databasePath, { fileMustExist: !bootstrap });
		let scheduler: Scheduler | null = null;
		try {
			applyMigrations(database, migrationsDirectory);
			runtime = {
				database,
				scheduler,
				databasePath,
				migrationsDirectory,
				environment: { ...options.environment }
			};
			if (enableScheduler && !bootstrap) {
				let ready = false;
				try {
					ready = (await checkReadiness(runtime)).ready;
				} catch {
					ready = false;
				}
				if (ready) {
					scheduler = createScheduler(database, options.environment);
					runtime.scheduler = scheduler;
					scheduler.start();
				}
			}
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
		current(): ApplicationRuntime | null {
			return runtime;
		},

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
