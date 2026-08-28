import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Buffer } from 'node:buffer';
import type { WithdrawalSellerIdentity } from '$lib/config/private.server';
import {
	parseApplicationDeploymentConfig,
	requireSchedulerDeploymentConfig,
	type ApplicationDeploymentConfig,
	type DeploymentReadinessConfig,
	type RuntimeEnvironment
} from '$lib/config/deployment.server';
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
import { SqliteApprovalRepository } from '$lib/server/fulfillment/approvals.server';
import { FulfillmentPreparationService } from '$lib/server/fulfillment/prepare.server';
import { SqliteFulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import { FulfillmentSubmissionService } from '$lib/server/fulfillment/submit.server';
import { SqliteLeaseRepository } from '$lib/server/jobs/leases.server';
import { PaidOrderAlertOutboxWorker } from '$lib/server/jobs/outbox-worker.server';
import { OutboxScheduler, type Scheduler } from '$lib/server/jobs/scheduler.server';
import { DurableStyriaSubmissionWorker } from '$lib/server/jobs/styria-submission-worker.server';
import { WithdrawalMessageWorker } from '$lib/server/jobs/withdrawal-worker.server';
import { SqliteWithdrawalRetentionJob } from '$lib/server/jobs/withdrawal-retention.server';
import { SqliteOperationalChecksJob } from '$lib/server/jobs/stale-orders.server';
import { SqliteStyriaSyncJob } from '$lib/server/jobs/styria-sync.server';
import { log } from '$lib/server/logging/logger.server';
import { configureAlertService, SqliteAlertService } from '$lib/server/monitoring/alerts.server';
import type { EmailGateway } from '$lib/server/email/gateway';
import { createResendEmailGateway } from '$lib/server/email/resend.server';
import { createShippingEmailSender } from '$lib/server/email/shipping-email';
import {
	createStripeClient,
	createStripeFulfillmentGateway
} from '$lib/server/stripe/client.server';
import { createStyriaClient } from '$lib/server/styria/client.server';
import { WithdrawalCaseReader } from '$lib/server/withdrawals/case-reader.server';
import { SqliteWithdrawalRepository } from '$lib/server/withdrawals/repository.server';
import { WithdrawalSubmissionService } from '$lib/server/withdrawals/submission.server';

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
	configuration: DeploymentReadinessConfig;
};

export type WithdrawalRuntime = {
	submission: WithdrawalSubmissionService;
	repository: SqliteWithdrawalRepository;
	reader: WithdrawalCaseReader;
	worker: WithdrawalMessageWorker;
	retention: SqliteWithdrawalRetentionJob;
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
		configuration: ApplicationDeploymentConfig,
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

function createRuntimeScheduler(
	database: ShopDatabase,
	configuration: ApplicationDeploymentConfig,
	createBackupStore: (options: S3BackupStoreOptions) => BackupStore,
	migrationsDirectory: string,
	email: EmailGateway,
	alerts: SqliteAlertService,
	withdrawal: WithdrawalRuntime
): Scheduler {
	const schedulerConfiguration = requireSchedulerDeploymentConfig(configuration);
	const automaticStyriaSubmission = configuration.features.automaticStyriaSubmissionEnabled;
	const backupsEnabled = schedulerConfiguration.backup.status === 'configured';
	const outbox = new SqliteOutboxRepository(database);
	const stripe = createStripeFulfillmentGateway(
		createStripeClient(schedulerConfiguration.stripeSecretKey)
	);
	const styria = createStyriaClient({
		appId: schedulerConfiguration.styria.appId,
		secretKey: schedulerConfiguration.styria.secretKey,
		baseUrl: schedulerConfiguration.styria.baseUrl,
		timeoutMs: schedulerConfiguration.styria.timeoutMs
	});
	const supportEmail = configuration.withdrawal.supportEmail;
	const sender = createShippingEmailSender(
		email,
		configuration.email.from,
		configuration.withdrawal.productionOrigin.origin
	);
	const worker = new PaidOrderAlertOutboxWorker({
		database,
		outbox,
		email,
		alertEmail: {
			to: configuration.email.adminEmail,
			from: configuration.email.from,
			replyTo: supportEmail
		},
		shipping: { stripe, sender, supportEmail },
		alerts,
		automaticStyriaSubmission
	});
	const fulfillment = new SqliteFulfillmentRepository(database);
	const styriaSubmission = automaticStyriaSubmission
		? (() => {
				const automaticFulfillment = new SqliteFulfillmentRepository(database, 'system-auto');
				const automaticShared = {
					fulfillment: automaticFulfillment,
					stripe,
					brandName: schedulerConfiguration.styria.brandName,
					comment: 'Automatically prepared after confirmed Stripe payment'
				};
				return new DurableStyriaSubmissionWorker({
					outbox,
					fulfillment: automaticFulfillment,
					preparation: new FulfillmentPreparationService({
						...automaticShared,
						approvals: new SqliteApprovalRepository(database, 'system-auto')
					}),
					submission: new FulfillmentSubmissionService({
						...automaticShared,
						styria,
						alerts
					}),
					alerts
				});
			})()
		: undefined;
	const styriaSync = new SqliteStyriaSyncJob({ database, styria, fulfillment, outbox, alerts });
	const backupConfiguration = schedulerConfiguration.backup;
	const backup =
		backupConfiguration.status === 'configured'
			? new SqliteBackupService({
					database,
					store: createBackupStore(backupConfiguration.store),
					encryptionKeyBase64: backupConfiguration.encryptionKeyBase64,
					prefix: backupConfiguration.prefix,
					temporaryDirectory: backupConfiguration.temporaryDirectory
				})
			: undefined;
	const operationalChecks = new SqliteOperationalChecksJob({
		database,
		alerts,
		backupsEnabled,
		async readiness() {
			const readiness = await import('$lib/server/health/readiness.server');
			return readiness.checkRuntimeReadiness(
				{
					database,
					scheduler: null,
					databasePath: configuration.database.path,
					migrationsDirectory,
					configuration: configuration.readiness
				},
				{ ignoreSchedulerLatch: true }
			);
		}
	});

	return new OutboxScheduler({
		database,
		leases: new SqliteLeaseRepository(database),
		worker,
		styriaSubmission,
		withdrawalWorker: withdrawal.worker,
		withdrawalRetention: withdrawal.retention,
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
	let runtimeEmail: EmailGateway | null = null;
	let runtimeAlerts: SqliteAlertService | null = null;

	const cancelActivationTimer = (): void => {
		if (!activationTimer) return;
		cancelActivation(activationTimer);
		activationTimer = undefined;
	};

	const scheduleActivationRetry = (
		current: ApplicationRuntime,
		configuration: ApplicationDeploymentConfig
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
			void activateScheduler(current, configuration);
		}, activationRetryMs);
		activationTimer = handle;
		handle.unref?.();
	};

	const activateScheduler = (
		current: ApplicationRuntime,
		configuration: ApplicationDeploymentConfig
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
					? dependencies.createScheduler(current.database, configuration, current.withdrawal)
					: createRuntimeScheduler(
							current.database,
							configuration,
							createBackupStore,
							migrationsDirectory,
							runtimeEmail!,
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
			if (retry) scheduleActivationRetry(current, configuration);
		});
		activation = tracked;
		return tracked;
	};

	const initialize = async (
		options: ApplicationStartOptions
	): Promise<ApplicationRuntime | null> => {
		const configuration = parseApplicationDeploymentConfig(options.environment);
		const databasePath = configuration.database.path;
		const bootstrap = configuration.database.bootstrap;
		const database = open(databasePath, { fileMustExist: !bootstrap });
		try {
			applyMigrations(database, migrationsDirectory);
			const withdrawalConfig = configuration.withdrawal;
			const email = createResendEmailGateway(configuration.email.provider);
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
				email,
				alerts,
				from: configuration.email.from,
				supportEmail: withdrawalConfig.supportEmail,
				productionOrigin: withdrawalConfig.productionOrigin,
				seller: withdrawalConfig.seller
			});
			const withdrawal: WithdrawalRuntime = {
				repository,
				reader,
				worker,
				retention: new SqliteWithdrawalRetentionJob({ repository, alerts }),
				submission: new WithdrawalSubmissionService({
					repository,
					dispatcher: worker,
					dataKey: withdrawalConfig.dataKey
				}),
				dataKey: withdrawalConfig.dataKey,
				seller: withdrawalConfig.seller
			};
			runtimeEmail = email;
			runtimeAlerts = alerts;
			clearAlertService?.();
			clearAlertService = configureAlertService(alerts);
			runtime = {
				database,
				scheduler: null,
				withdrawal,
				databasePath,
				migrationsDirectory,
				configuration: configuration.readiness
			};
			acceptingActivation = configuration.features.schedulerEnabled && !bootstrap;
			if (acceptingActivation) await activateScheduler(runtime, configuration);
			return runtime;
		} catch (error) {
			acceptingActivation = false;
			cancelActivationTimer();
			runtime = null;
			clearAlertService?.();
			clearAlertService = null;
			runtimeEmail = null;
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
				runtimeEmail = null;
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
