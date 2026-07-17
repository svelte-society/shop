import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Buffer } from 'node:buffer';
import { parseWithdrawalConfig, type WithdrawalSellerIdentity } from '$lib/config/private.server';
import { SqliteBackupService } from '$lib/server/backups/service.server';
import {
	createS3BackupStore,
	type BackupStore,
	type S3BackupStoreOptions
} from '$lib/server/backups/s3.server';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteFulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import { SqliteLeaseRepository } from '$lib/server/jobs/leases.server';
import { PaidOrderAlertOutboxWorker } from '$lib/server/jobs/outbox-worker.server';
import { OutboxScheduler, type Scheduler } from '$lib/server/jobs/scheduler.server';
import { WithdrawalMessageWorker } from '$lib/server/jobs/withdrawal-worker.server';
import { SqliteOperationalChecksJob } from '$lib/server/jobs/stale-orders.server';
import { SqliteStyriaSyncJob } from '$lib/server/jobs/styria-sync.server';
import { log } from '$lib/server/logging/logger.server';
import { configureAlertService, SqliteAlertService } from '$lib/server/monitoring/alerts.server';
import { createPlunkClient, PLUNK_DEFAULT_TIMEOUT_MS } from '$lib/server/plunk/client.server';
import type { PlunkGateway } from '$lib/server/plunk/gateway';
import { createShippingEmailSender } from '$lib/server/plunk/shipping-email';
import {
	createStripeClient,
	createStripeFulfillmentGateway
} from '$lib/server/stripe/client.server';
import { createStyriaClient } from '$lib/server/styria/client.server';
import { WithdrawalCaseReader } from '$lib/server/withdrawals/case-reader.server';
import { SqliteWithdrawalRepository } from '$lib/server/withdrawals/repository.server';
import { WithdrawalSubmissionService } from '$lib/server/withdrawals/submission.server';

type RuntimeEnvironment = Record<string, string | undefined>;

export type ApplicationStartOptions = {
	environment: RuntimeEnvironment;
	building: boolean;
	test: boolean;
};

export type ApplicationRuntime = {
	database: ShopDatabase;
	scheduler: Scheduler | null;
	withdrawal: WithdrawalRuntime;
	databasePath: string;
	migrationsDirectory: string;
	environment: RuntimeEnvironment;
};

export type WithdrawalRuntime = {
	submission: WithdrawalSubmissionService;
	repository: SqliteWithdrawalRepository;
	reader: WithdrawalCaseReader;
	worker: WithdrawalMessageWorker;
	dataKey: Buffer;
	seller: WithdrawalSellerIdentity;
};

export type ApplicationRuntimeDependencies = {
	migrationsDirectory?: string;
	openDatabase?: typeof openDatabase;
	closeDatabase?: typeof closeDatabase;
	migrate?: typeof migrate;
	createScheduler?: (
		database: ShopDatabase,
		environment: RuntimeEnvironment,
		withdrawal: WithdrawalRuntime
	) => Scheduler;
	createBackupStore?: (options: S3BackupStoreOptions) => BackupStore;
	checkReadiness?: (runtime: ApplicationRuntime) => Promise<{ ready: boolean }>;
	scheduleSchedulerActivation?: (callback: () => void, delayMs: number) => ApplicationTimerHandle;
	cancelSchedulerActivation?: (handle: ApplicationTimerHandle) => void;
	schedulerActivationRetryMs?: number;
	reportShutdown?: (
		event: 'scheduler_stopped' | 'database_closed',
		details: { schedulerActive: boolean }
	) => void;
};

export type ApplicationTimerHandle = {
	unref?: () => void;
};

export interface ApplicationLifecycle {
	start(options: ApplicationStartOptions): Promise<ApplicationRuntime | null>;
	current(): ApplicationRuntime | null;
	stop(): Promise<void>;
}

export type ApplicationShutdownTarget = {
	on(event: 'sveltekit:shutdown', listener: (reason?: string) => Promise<void>): unknown;
};

type ApplicationShutdownState = {
	application: ApplicationLifecycle;
	listener: (reason?: string) => Promise<void>;
};

const shutdownStateKey = Symbol.for('dev.sveltesociety.shop.application-shutdown');

export function registerApplicationShutdown(
	application: ApplicationLifecycle,
	target: ApplicationShutdownTarget = process
): void {
	const stateTarget = target as ApplicationShutdownTarget & Record<PropertyKey, unknown>;
	const existing = stateTarget[shutdownStateKey] as ApplicationShutdownState | undefined;
	if (existing) {
		existing.application = application;
		return;
	}

	const state: ApplicationShutdownState = {
		application,
		async listener() {
			await state.application.stop();
		}
	};
	stateTarget[shutdownStateKey] = state;
	if (target === process) {
		process.on('sveltekit:shutdown', state.listener);
	} else {
		target.on('sveltekit:shutdown', state.listener);
	}
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
	return readiness.checkRuntimeReadiness(runtime, { ignoreSchedulerLatch: true });
}

function scheduleAfter(callback: () => void, delayMs: number): ApplicationTimerHandle {
	return setTimeout(callback, delayMs);
}

function cancelScheduled(handle: ApplicationTimerHandle): void {
	clearTimeout(handle as ReturnType<typeof setTimeout>);
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

function requiredBoolean(environment: RuntimeEnvironment, name: string): boolean {
	const value = environment[name];
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error('APPLICATION_CONFIG_INVALID');
}

function createRuntimeScheduler(
	database: ShopDatabase,
	environment: RuntimeEnvironment,
	createBackupStore: (options: S3BackupStoreOptions) => BackupStore,
	migrationsDirectory: string,
	plunk: PlunkGateway,
	alerts: SqliteAlertService,
	withdrawal: WithdrawalRuntime
): Scheduler {
	const outbox = new SqliteOutboxRepository(database);
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
	const sender = createShippingEmailSender(
		plunk,
		{
			name: requiredEnvironmentValue(environment, 'PLUNK_FROM_NAME'),
			email: requiredEnvironmentValue(environment, 'PLUNK_FROM_EMAIL')
		},
		requiredEnvironmentValue(environment, 'PRODUCTION_ORIGIN')
	);
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
		shipping: { stripe, sender, supportEmail },
		alerts
	});
	const fulfillment = new SqliteFulfillmentRepository(database);
	const styriaSync = new SqliteStyriaSyncJob({ database, styria, fulfillment, outbox, alerts });
	const backupStore = createBackupStore({
		endpoint: requiredEnvironmentValue(environment, 'S3_ENDPOINT'),
		region: requiredEnvironmentValue(environment, 'S3_REGION'),
		bucket: requiredEnvironmentValue(environment, 'S3_BUCKET'),
		accessKeyId: requiredEnvironmentValue(environment, 'S3_ACCESS_KEY_ID'),
		secretAccessKey: requiredEnvironmentValue(environment, 'S3_SECRET_ACCESS_KEY'),
		forcePathStyle: requiredBoolean(environment, 'S3_FORCE_PATH_STYLE')
	});
	const backup = new SqliteBackupService({
		database,
		store: backupStore,
		encryptionKeyBase64: requiredEnvironmentValue(environment, 'BACKUP_ENCRYPTION_KEY_BASE64'),
		prefix: requiredEnvironmentValue(environment, 'S3_PREFIX'),
		temporaryDirectory: environment.TMPDIR ?? tmpdir()
	});
	const operationalChecks = new SqliteOperationalChecksJob({
		database,
		alerts,
		async readiness() {
			const readiness = await import('$lib/server/health/readiness.server');
			return readiness.checkRuntimeReadiness(
				{
					database,
					scheduler: null,
					databasePath: requiredEnvironmentValue(environment, 'DATABASE_PATH'),
					migrationsDirectory,
					environment
				},
				{ ignoreSchedulerLatch: true }
			);
		}
	});

	return new OutboxScheduler({
		database,
		leases: new SqliteLeaseRepository(database),
		worker,
		withdrawalWorker: withdrawal.worker,
		styriaSync,
		backup,
		operationalChecks,
		alerts,
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
	const createBackupStore = dependencies.createBackupStore ?? createS3BackupStore;
	const checkReadiness = dependencies.checkReadiness ?? checkRuntimeReadiness;
	const scheduleActivation = dependencies.scheduleSchedulerActivation ?? scheduleAfter;
	const cancelActivation = dependencies.cancelSchedulerActivation ?? cancelScheduled;
	const activationRetryMs = dependencies.schedulerActivationRetryMs ?? 5_000;
	const reportShutdown = dependencies.reportShutdown ?? (() => undefined);
	let runtime: ApplicationRuntime | null = null;
	let startup: Promise<ApplicationRuntime | null> | null = null;
	let stopping: Promise<void> | null = null;
	let activation: Promise<void> | null = null;
	let activationTimer: ApplicationTimerHandle | undefined;
	let acceptingActivation = false;
	let clearAlertService: (() => void) | null = null;
	let runtimePlunk: PlunkGateway | null = null;
	let runtimeAlerts: SqliteAlertService | null = null;

	const cancelActivationTimer = (): void => {
		if (!activationTimer) return;
		cancelActivation(activationTimer);
		activationTimer = undefined;
	};

	const scheduleActivationRetry = (
		current: ApplicationRuntime,
		environment: RuntimeEnvironment
	): void => {
		if (
			!acceptingActivation ||
			runtime !== current ||
			current.scheduler ||
			activation ||
			activationTimer
		) {
			return;
		}
		const handle = scheduleActivation(() => {
			if (activationTimer !== handle) return;
			activationTimer = undefined;
			void activateScheduler(current, environment);
		}, activationRetryMs);
		activationTimer = handle;
		handle.unref?.();
	};

	const activateScheduler = (
		current: ApplicationRuntime,
		environment: RuntimeEnvironment
	): Promise<void> => {
		if (!acceptingActivation || runtime !== current || current.scheduler) {
			return Promise.resolve();
		}
		if (activation) return activation;
		let retry = false;
		const operation = (async () => {
			let ready: boolean;
			try {
				ready = (await checkReadiness(current)).ready;
			} catch {
				ready = false;
			}
			if (!acceptingActivation || runtime !== current || current.scheduler) return;
			if (!ready) {
				retry = true;
				return;
			}

			let candidate: Scheduler | undefined;
			try {
				candidate = dependencies.createScheduler
					? dependencies.createScheduler(current.database, environment, current.withdrawal)
					: createRuntimeScheduler(
							current.database,
							environment,
							createBackupStore,
							migrationsDirectory,
							runtimePlunk!,
							runtimeAlerts!,
							current.withdrawal
						);
				candidate.start();
				if (!acceptingActivation || runtime !== current) {
					await candidate.stop();
					return;
				}
				current.scheduler = candidate;
			} catch {
				if (candidate) {
					try {
						await candidate.stop();
					} catch {
						// A later activation attempt remains the recovery path.
					}
				}
				retry = acceptingActivation && runtime === current && !current.scheduler;
			}
		})();
		const tracked = operation.finally(() => {
			if (activation === tracked) activation = null;
			if (retry) scheduleActivationRetry(current, environment);
		});
		activation = tracked;
		return tracked;
	};

	const initialize = async (
		options: ApplicationStartOptions
	): Promise<ApplicationRuntime | null> => {
		const databasePath = requiredEnvironmentValue(options.environment, 'DATABASE_PATH');
		const bootstrap = databaseBootstrapEnabled(options.environment);
		const enableScheduler = schedulerEnabled(options.environment);
		const database = open(databasePath, { fileMustExist: !bootstrap });
		try {
			applyMigrations(database, migrationsDirectory);
			const withdrawalConfig = parseWithdrawalConfig(options.environment);
			const plunk = createPlunkClient({
				secretKey: requiredEnvironmentValue(options.environment, 'PLUNK_SECRET_KEY'),
				baseUrl: options.environment.PLUNK_BASE_URL,
				timeoutMs: PLUNK_DEFAULT_TIMEOUT_MS
			});
			const outbox = new SqliteOutboxRepository(database);
			const alerts = new SqliteAlertService(outbox);
			const repository = new SqliteWithdrawalRepository(database);
			const reader = new WithdrawalCaseReader({
				repository,
				dataKey: withdrawalConfig.dataKey,
				alerts
			});
			const worker = new WithdrawalMessageWorker({
				repository,
				reader,
				plunk,
				alerts,
				from: {
					name: requiredEnvironmentValue(options.environment, 'PLUNK_FROM_NAME'),
					email: requiredEnvironmentValue(options.environment, 'PLUNK_FROM_EMAIL')
				},
				supportEmail: withdrawalConfig.supportEmail,
				productionOrigin: withdrawalConfig.productionOrigin,
				seller: withdrawalConfig.seller
			});
			const withdrawal: WithdrawalRuntime = {
				repository,
				reader,
				worker,
				submission: new WithdrawalSubmissionService({
					repository,
					dispatcher: worker,
					dataKey: withdrawalConfig.dataKey
				}),
				dataKey: withdrawalConfig.dataKey,
				seller: withdrawalConfig.seller
			};
			runtimePlunk = plunk;
			runtimeAlerts = alerts;
			clearAlertService?.();
			clearAlertService = configureAlertService(alerts);
			runtime = {
				database,
				scheduler: null,
				withdrawal,
				databasePath,
				migrationsDirectory,
				environment: { ...options.environment }
			};
			acceptingActivation = enableScheduler && !bootstrap;
			if (acceptingActivation) await activateScheduler(runtime, options.environment);
			return runtime;
		} catch (error) {
			acceptingActivation = false;
			cancelActivationTimer();
			runtime = null;
			clearAlertService?.();
			clearAlertService = null;
			runtimePlunk = null;
			runtimeAlerts = null;
			close();
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
			acceptingActivation = false;
			cancelActivationTimer();

			const operation = (async () => {
				if (startup) {
					try {
						await startup;
					} catch {
						return;
					}
				}
				if (activation) await activation;
				if (!runtime) return;
				const current = runtime;
				const schedulerActive = current.scheduler !== null;
				await current.scheduler?.stop();
				try {
					reportShutdown('scheduler_stopped', { schedulerActive });
				} catch {
					// Observability must not block shutdown.
				}
				close();
				runtime = null;
				clearAlertService?.();
				clearAlertService = null;
				runtimePlunk = null;
				runtimeAlerts = null;
				try {
					reportShutdown('database_closed', { schedulerActive });
				} catch {
					// Observability must not block shutdown.
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

export const applicationLifecycle = createApplicationLifecycle({
	reportShutdown(event, details) {
		log({
			level: 'info',
			code:
				event === 'scheduler_stopped'
					? 'APPLICATION_SCHEDULER_STOPPED'
					: 'APPLICATION_DATABASE_CLOSED',
			fields: { scheduler_count: details.schedulerActive ? 1 : 0 }
		});
	}
});

registerApplicationShutdown(applicationLifecycle);
