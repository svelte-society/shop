import type { ShopDatabase } from '$lib/server/db/types';
import type { BackupService } from '$lib/server/backups/service.server';
import type { AlertCode, AlertService } from '$lib/server/monitoring/alerts.server';
import type { LeaseRepository } from './leases.server';
import type { OutboxWorker } from './outbox-worker.server';
import type { OperationalChecksJob } from './stale-orders.server';
import type { StyriaSyncJob } from './styria-sync.server';
import type { WithdrawalMessageWorker } from './withdrawal-worker.server';
import type { WithdrawalRetentionJob } from './withdrawal-retention.server';

export const OUTBOX_JOB_NAME = 'outbox';
export const STYRIA_SYNC_JOB_NAME = 'styria-sync';
export const BACKUP_JOB_NAME = 'backup';
export const OPERATIONAL_CHECKS_JOB_NAME = 'operational-checks';
export const WITHDRAWAL_RETENTION_JOB_NAME = 'withdrawal-retention';
export const WITHDRAWAL_DELIVERY_GUARD_NAME = 'withdrawal-delivery-guard';
const OUTBOX_INTERVAL_MS = 60_000;
const OUTBOX_LEASE_TTL_MS = 55_000;
const OUTBOX_LEASE_HEARTBEAT_MS = 20_000;
// Runtime cancellation aborts Styria and Plunk immediately. Scheduler-triggered Stripe retrievals
// disable retries and use a five-second request timeout, leaving 25 seconds of adapter-node's
// SHUTDOWN_TIMEOUT=30 for worker settlement, lease release, and SQLite close.
const OUTBOX_DRAIN_LIMIT = 3;
const OUTBOX_DRAIN_ERROR_CODE = 'OUTBOX_DRAIN_FAILED';
const STYRIA_SYNC_INTERVAL_MS = 60 * 60_000;
const STYRIA_SYNC_LEASE_TTL_MS = 55 * 60_000;
const STYRIA_SYNC_ERROR_CODE = 'STYRIA_SYNC_FAILED';
const BACKUP_LEASE_TTL_MS = 120 * 60_000;
const BACKUP_ERROR_CODE = 'BACKUP_FAILED';
const OPERATIONAL_CHECKS_LEASE_TTL_MS = 30 * 60_000;
const OPERATIONAL_CHECKS_ERROR_CODE = 'OPERATIONAL_CHECKS_FAILED';
const WITHDRAWAL_RETENTION_LEASE_TTL_MS = 30 * 60_000;
const WITHDRAWAL_RETENTION_LEASE_HEARTBEAT_MS = 10 * 60_000;
const WITHDRAWAL_RETENTION_ERROR_CODE = 'WITHDRAWAL_RETENTION_FAILED';

export interface Scheduler {
	start(): void;
	stop(): Promise<void>;
	runOutboxOnce(now?: Date): Promise<void>;
	runStyriaSyncOnce(now?: Date): Promise<void>;
	runBackupOnce(now?: Date): Promise<void>;
	runOperationalChecksOnce?(now?: Date): Promise<void>;
	runWithdrawalRetentionOnce?(now?: Date): Promise<void>;
}

export type SchedulerTimerHandle = {
	unref?: () => void;
};

export type SchedulerTimer = (callback: () => void, intervalMs: number) => SchedulerTimerHandle;

export type OutboxSchedulerOptions = {
	database: ShopDatabase;
	leases: LeaseRepository;
	worker: OutboxWorker;
	withdrawalWorker?: Pick<WithdrawalMessageWorker, 'drain'>;
	styriaSync?: StyriaSyncJob;
	backup?: BackupService;
	operationalChecks?: OperationalChecksJob;
	withdrawalRetention?: WithdrawalRetentionJob;
	alerts?: AlertService;
	enabled: boolean;
	ownerId: string;
	clock?: () => Date;
	schedule?: SchedulerTimer;
	scheduleBackup?: SchedulerTimer;
	scheduleOperationalChecks?: SchedulerTimer;
	scheduleWithdrawalRetention?: SchedulerTimer;
	cancel?: (handle: SchedulerTimerHandle) => void;
	reportError?: (errorCode: string) => void;
};

const scheduleEvery: SchedulerTimer = (callback, intervalMs) => setInterval(callback, intervalMs);
const scheduleAfter: SchedulerTimer = (callback, delayMs) => setTimeout(callback, delayMs);

function cancelScheduled(handle: SchedulerTimerHandle): void {
	clearInterval(handle as ReturnType<typeof setInterval>);
}

function reportSchedulerError(errorCode: string): void {
	console.error(JSON.stringify({ event: 'scheduler_failed', error_code: errorCode }));
}

export class OutboxScheduler implements Scheduler {
	private readonly clock: () => Date;
	private readonly schedule: SchedulerTimer;
	private readonly scheduleBackup: SchedulerTimer;
	private readonly scheduleOperationalChecks: SchedulerTimer;
	private readonly scheduleWithdrawalRetention: SchedulerTimer;
	private readonly cancel: (handle: SchedulerTimerHandle) => void;
	private readonly reportError: (errorCode: string) => void;
	private started = false;
	private stopping = false;
	private acceptingScheduledRuns = false;
	private timer: SchedulerTimerHandle | undefined;
	private styriaTimer: SchedulerTimerHandle | undefined;
	private backupTimer: SchedulerTimerHandle | undefined;
	private operationalChecksTimer: SchedulerTimerHandle | undefined;
	private operationalRetryTimer: SchedulerTimerHandle | undefined;
	private withdrawalRetentionTimer: SchedulerTimerHandle | undefined;
	private operationalRetryAt: number | undefined;
	private activeRun: Promise<void> | undefined;
	private activeStyriaRun: Promise<void> | undefined;
	private activeBackupRun: Promise<void> | undefined;
	private activeOperationalChecksRun: Promise<void> | undefined;
	private activeWithdrawalRetentionRun: Promise<void> | undefined;
	private activeRunController: AbortController | undefined;
	private activeStyriaRunController: AbortController | undefined;
	private activeBackupRunController: AbortController | undefined;
	private activeOperationalChecksRunController: AbortController | undefined;
	private activeWithdrawalRetentionRunController: AbortController | undefined;
	private readonly reportedRuns = new WeakSet<Promise<void>>();
	private readonly reportedStyriaRuns = new WeakSet<Promise<void>>();
	private readonly reportedBackupRuns = new WeakSet<Promise<void>>();
	private readonly reportedOperationalChecksRuns = new WeakSet<Promise<void>>();
	private readonly reportedWithdrawalRetentionRuns = new WeakSet<Promise<void>>();

	constructor(private readonly options: OutboxSchedulerOptions) {
		this.clock = options.clock ?? (() => new Date());
		this.schedule = options.schedule ?? scheduleEvery;
		this.scheduleBackup = options.scheduleBackup ?? scheduleAfter;
		this.scheduleOperationalChecks = options.scheduleOperationalChecks ?? scheduleAfter;
		this.scheduleWithdrawalRetention = options.scheduleWithdrawalRetention ?? scheduleAfter;
		this.cancel = options.cancel ?? cancelScheduled;
		this.reportError = options.reportError ?? reportSchedulerError;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		if (!this.options.enabled) return;

		this.acceptingScheduledRuns = true;
		this.timer = this.schedule(() => this.launchScheduledRun(), OUTBOX_INTERVAL_MS);
		this.timer.unref?.();
		this.launchScheduledRun();
		if (this.options.styriaSync) {
			this.styriaTimer = this.schedule(
				() => this.launchScheduledStyriaRun(),
				STYRIA_SYNC_INTERVAL_MS
			);
			this.styriaTimer.unref?.();
			this.launchScheduledStyriaRun();
		}
		if (this.options.backup) this.scheduleNextBackup();
		if (this.options.operationalChecks) {
			this.scheduleNextOperationalChecks();
			if (this.operationalChecksCatchUpDue(this.clock())) {
				this.launchScheduledOperationalChecksRun();
			}
		}
		if (this.options.withdrawalRetention) {
			this.scheduleNextWithdrawalRetention();
			if (this.withdrawalRetentionCatchUpDue(this.clock())) {
				this.launchScheduledWithdrawalRetentionRun();
			}
		}
	}

	async stop(): Promise<void> {
		// This synchronous state transition happens before any await: no new manual or scheduled run
		// can be registered after the active controllers are captured for cancellation.
		this.stopping = true;
		this.acceptingScheduledRuns = false;
		if (this.timer) {
			this.cancel(this.timer);
			this.timer = undefined;
		}
		if (this.styriaTimer) {
			this.cancel(this.styriaTimer);
			this.styriaTimer = undefined;
		}
		if (this.backupTimer) {
			this.cancel(this.backupTimer);
			this.backupTimer = undefined;
		}
		if (this.operationalChecksTimer) {
			this.cancel(this.operationalChecksTimer);
			this.operationalChecksTimer = undefined;
		}
		if (this.withdrawalRetentionTimer) {
			this.cancel(this.withdrawalRetentionTimer);
			this.withdrawalRetentionTimer = undefined;
		}
		this.cancelOperationalRetry();

		const activeRun = this.activeRun;
		const activeStyriaRun = this.activeStyriaRun;
		const activeBackupRun = this.activeBackupRun;
		const activeOperationalChecksRun = this.activeOperationalChecksRun;
		const activeWithdrawalRetentionRun = this.activeWithdrawalRetentionRun;
		this.activeRunController?.abort(new Error('OUTBOX_SCHEDULER_STOPPING'));
		this.activeStyriaRunController?.abort(new Error('OUTBOX_SCHEDULER_STOPPING'));
		this.activeBackupRunController?.abort(new Error('OUTBOX_SCHEDULER_STOPPING'));
		this.activeOperationalChecksRunController?.abort(new Error('OUTBOX_SCHEDULER_STOPPING'));
		this.activeWithdrawalRetentionRunController?.abort(new Error('OUTBOX_SCHEDULER_STOPPING'));
		await Promise.all(
			[
				activeRun,
				activeStyriaRun,
				activeBackupRun,
				activeOperationalChecksRun,
				activeWithdrawalRetentionRun
			]
				.filter(Boolean)
				.map(async (run) => {
					try {
						await run;
					} catch {
						// Scheduled failures are already recorded and reported; shutdown still waits for cleanup.
					}
				})
		);
	}

	runWithdrawalRetentionOnce(now = this.clock()): Promise<void> {
		if (this.stopping) return Promise.resolve();
		if (!this.options.withdrawalRetention) return Promise.resolve();
		if (this.activeWithdrawalRetentionRun) return this.activeWithdrawalRetentionRun;

		const controller = new AbortController();
		this.activeWithdrawalRetentionRunController = controller;
		const execution = Promise.resolve()
			.then(() => this.executeWithdrawalRetentionRun(now, controller.signal))
			.catch((error) => {
				if (!controller.signal.aborted) {
					this.enqueueFailureAlert('SCHEDULER_FAILED', WITHDRAWAL_RETENTION_JOB_NAME, now);
				}
				throw error;
			});
		const trackedRun = execution.finally(() => {
			if (this.activeWithdrawalRetentionRun === trackedRun) {
				this.activeWithdrawalRetentionRun = undefined;
				this.activeWithdrawalRetentionRunController = undefined;
			}
		});
		this.activeWithdrawalRetentionRun = trackedRun;
		return trackedRun;
	}

	runOperationalChecksOnce(now = this.clock()): Promise<void> {
		if (this.stopping) return Promise.resolve();
		if (!this.options.operationalChecks) return Promise.resolve();
		if (this.activeOperationalChecksRun) return this.activeOperationalChecksRun;

		const controller = new AbortController();
		this.activeOperationalChecksRunController = controller;
		const execution = Promise.resolve()
			.then(() => this.executeOperationalChecksRun(now, controller.signal))
			.catch((error) => {
				if (!controller.signal.aborted) {
					this.enqueueFailureAlert('SCHEDULER_FAILED', OPERATIONAL_CHECKS_JOB_NAME, now);
				}
				throw error;
			});
		const trackedRun = execution.finally(() => {
			if (this.activeOperationalChecksRun === trackedRun) {
				this.activeOperationalChecksRun = undefined;
				this.activeOperationalChecksRunController = undefined;
			}
		});
		this.activeOperationalChecksRun = trackedRun;
		return trackedRun;
	}

	runBackupOnce(now = this.clock()): Promise<void> {
		if (this.stopping) return Promise.resolve();
		if (!this.options.backup) return Promise.resolve();
		if (this.activeBackupRun) return this.activeBackupRun;

		const controller = new AbortController();
		this.activeBackupRunController = controller;
		const execution = Promise.resolve()
			.then(() => this.executeBackupRun(now, controller.signal))
			.catch((error) => {
				if (!controller.signal.aborted) {
					this.enqueueFailureAlert('BACKUP_FAILED', 'daily-backup', now);
					this.enqueueFailureAlert('SCHEDULER_FAILED', BACKUP_JOB_NAME, now);
				}
				throw error;
			});
		const trackedRun = execution.finally(() => {
			if (this.activeBackupRun === trackedRun) {
				this.activeBackupRun = undefined;
				this.activeBackupRunController = undefined;
			}
		});
		this.activeBackupRun = trackedRun;
		return trackedRun;
	}

	runStyriaSyncOnce(now = this.clock()): Promise<void> {
		if (this.stopping) return Promise.resolve();
		if (!this.options.styriaSync) return Promise.resolve();
		if (this.activeStyriaRun) return this.activeStyriaRun;

		const controller = new AbortController();
		this.activeStyriaRunController = controller;
		const execution = Promise.resolve()
			.then(() => this.executeStyriaRun(now, controller.signal))
			.catch((error) => {
				if (!controller.signal.aborted) {
					this.enqueueFailureAlert('SCHEDULER_FAILED', STYRIA_SYNC_JOB_NAME, now);
				}
				throw error;
			});
		const trackedRun = execution.finally(() => {
			if (this.activeStyriaRun === trackedRun) {
				this.activeStyriaRun = undefined;
				this.activeStyriaRunController = undefined;
			}
		});
		this.activeStyriaRun = trackedRun;
		return trackedRun;
	}

	runOutboxOnce(now = this.clock()): Promise<void> {
		if (this.stopping) return Promise.resolve();
		if (this.activeRun) return this.activeRun;

		const controller = new AbortController();
		this.activeRunController = controller;
		const execution = Promise.resolve()
			.then(() => this.executeRun(now, controller.signal))
			.catch((error) => {
				if (!controller.signal.aborted) {
					this.enqueueFailureAlert('SCHEDULER_FAILED', OUTBOX_JOB_NAME, now);
				}
				throw error;
			});
		const trackedRun = execution.finally(() => {
			if (this.activeRun === trackedRun) {
				this.activeRun = undefined;
				this.activeRunController = undefined;
			}
		});
		this.activeRun = trackedRun;
		return trackedRun;
	}

	private launchScheduledRun(): void {
		if (!this.acceptingScheduledRuns) return;
		const run = this.runOutboxOnce();
		if (this.reportedRuns.has(run)) return;
		this.reportedRuns.add(run);
		void run.catch(() => this.reportError(OUTBOX_DRAIN_ERROR_CODE));
	}

	private launchScheduledStyriaRun(): void {
		if (!this.acceptingScheduledRuns || !this.options.styriaSync) return;
		const run = this.runStyriaSyncOnce();
		if (this.reportedStyriaRuns.has(run)) return;
		this.reportedStyriaRuns.add(run);
		void run.catch(() => this.reportError(STYRIA_SYNC_ERROR_CODE));
	}

	private scheduleNextBackup(): void {
		if (!this.acceptingScheduledRuns || !this.options.backup || this.backupTimer) return;
		const delayMs = millisecondsUntilNextBackup(this.clock());
		const handle = this.scheduleBackup(() => {
			if (this.backupTimer !== handle) return;
			this.backupTimer = undefined;
			if (!this.acceptingScheduledRuns) return;
			this.scheduleNextBackup();
			this.launchScheduledBackupRun();
		}, delayMs);
		this.backupTimer = handle;
		handle.unref?.();
	}

	private launchScheduledBackupRun(): void {
		if (!this.acceptingScheduledRuns || !this.options.backup) return;
		const run = this.runBackupOnce();
		if (this.reportedBackupRuns.has(run)) return;
		this.reportedBackupRuns.add(run);
		void run.catch(() => this.reportError(BACKUP_ERROR_CODE));
	}

	private scheduleNextOperationalChecks(): void {
		if (
			!this.acceptingScheduledRuns ||
			!this.options.operationalChecks ||
			this.operationalChecksTimer
		) {
			return;
		}
		const delayMs = millisecondsUntilNextOperationalChecks(this.clock());
		const handle = this.scheduleOperationalChecks(() => {
			if (this.operationalChecksTimer !== handle) return;
			this.operationalChecksTimer = undefined;
			if (!this.acceptingScheduledRuns) return;
			this.scheduleNextOperationalChecks();
			this.launchScheduledOperationalChecksRun();
		}, delayMs);
		this.operationalChecksTimer = handle;
		handle.unref?.();
	}

	private launchScheduledOperationalChecksRun(): void {
		if (!this.acceptingScheduledRuns || !this.options.operationalChecks) return;
		const run = this.runOperationalChecksOnce();
		if (this.reportedOperationalChecksRuns.has(run)) return;
		this.reportedOperationalChecksRuns.add(run);
		void run.catch(() => this.reportError(OPERATIONAL_CHECKS_ERROR_CODE));
	}

	private scheduleNextWithdrawalRetention(): void {
		if (
			!this.acceptingScheduledRuns ||
			!this.options.withdrawalRetention ||
			this.withdrawalRetentionTimer
		) {
			return;
		}
		const delayMs = millisecondsUntilNextWithdrawalRetention(this.clock());
		const handle = this.scheduleWithdrawalRetention(() => {
			if (this.withdrawalRetentionTimer !== handle) return;
			this.withdrawalRetentionTimer = undefined;
			if (!this.acceptingScheduledRuns) return;
			this.scheduleNextWithdrawalRetention();
			this.launchScheduledWithdrawalRetentionRun();
		}, delayMs);
		this.withdrawalRetentionTimer = handle;
		handle.unref?.();
	}

	private launchScheduledWithdrawalRetentionRun(): void {
		if (!this.acceptingScheduledRuns || !this.options.withdrawalRetention) return;
		const run = this.runWithdrawalRetentionOnce();
		if (this.reportedWithdrawalRetentionRuns.has(run)) return;
		this.reportedWithdrawalRetentionRuns.add(run);
		void run.catch(() => this.reportError(WITHDRAWAL_RETENTION_ERROR_CODE));
	}

	private withdrawalRetentionCatchUpDue(now: Date): boolean {
		const cadence = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 15, 0, 0)
		);
		if (now < cadence) cadence.setUTCDate(cadence.getUTCDate() - 1);
		const nextCadence = new Date(cadence);
		nextCadence.setUTCDate(nextCadence.getUTCDate() + 1);
		const completed = this.options.database
			.prepare(
				`SELECT 1 FROM job_runs
				 WHERE name = ? AND result = 'completed'
				 AND started_at >= ? AND started_at < ?
				 AND finished_at IS NOT NULL AND finished_at <= ?
				 LIMIT 1`
			)
			.get(
				WITHDRAWAL_RETENTION_JOB_NAME,
				cadence.toISOString(),
				nextCadence.toISOString(),
				now.toISOString()
			);
		return completed === undefined;
	}

	private scheduleOperationalRetry(retryAt: Date): void {
		if (!this.acceptingScheduledRuns || !this.options.operationalChecks) return;
		if (!(retryAt instanceof Date) || !Number.isFinite(retryAt.getTime())) {
			throw new Error('OPERATIONAL_CHECK_RETRY_INVALID');
		}
		const retryTimestamp = retryAt.getTime();
		if (
			this.operationalRetryTimer &&
			this.operationalRetryAt !== undefined &&
			this.operationalRetryAt <= retryTimestamp
		) {
			return;
		}
		this.cancelOperationalRetry();
		const delayMs = Math.max(0, retryTimestamp - this.clock().getTime());
		const handle = this.scheduleOperationalChecks(() => {
			if (this.operationalRetryTimer !== handle) return;
			this.operationalRetryTimer = undefined;
			this.operationalRetryAt = undefined;
			if (!this.acceptingScheduledRuns) return;
			if (!this.operationalChecksCatchUpDue(this.clock())) return;
			this.launchScheduledOperationalChecksRun();
		}, delayMs);
		this.operationalRetryTimer = handle;
		this.operationalRetryAt = retryTimestamp;
		handle.unref?.();
	}

	private cancelOperationalRetry(): void {
		if (this.operationalRetryTimer) this.cancel(this.operationalRetryTimer);
		this.operationalRetryTimer = undefined;
		this.operationalRetryAt = undefined;
	}

	private retryAfterOperationalLease(now: Date): Date {
		const row = this.options.database
			.prepare('SELECT expires_at FROM job_leases WHERE name = ?')
			.get(OPERATIONAL_CHECKS_JOB_NAME) as { expires_at: unknown } | undefined;
		if (!row) return new Date(now.getTime() + 1);
		if (typeof row.expires_at !== 'string') throw new Error('OPERATIONAL_CHECK_LEASE_INVALID');
		const expiresAt = new Date(row.expires_at);
		if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== row.expires_at) {
			throw new Error('OPERATIONAL_CHECK_LEASE_INVALID');
		}
		return expiresAt > now ? expiresAt : new Date(now.getTime() + 1);
	}

	private operationalChecksCatchUpDue(now: Date): boolean {
		const cadence = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0, 0)
		);
		if (now < cadence) return false;
		const nextCadence = new Date(cadence);
		nextCadence.setUTCDate(nextCadence.getUTCDate() + 1);
		const completed = this.options.database
			.prepare(
				`SELECT 1 FROM job_runs
				 WHERE name = ? AND result = 'completed'
				 AND started_at >= ? AND started_at < ?
				 AND finished_at IS NOT NULL AND finished_at <= ?
				 LIMIT 1`
			)
			.get(
				OPERATIONAL_CHECKS_JOB_NAME,
				cadence.toISOString(),
				nextCadence.toISOString(),
				now.toISOString()
			);
		return completed === undefined;
	}

	private async executeRun(now: Date, signal: AbortSignal): Promise<void> {
		if (
			!this.options.leases.acquire(OUTBOX_JOB_NAME, this.options.ownerId, now, OUTBOX_LEASE_TTL_MS)
		) {
			return;
		}
		const guardRequired = this.options.withdrawalWorker !== undefined;
		let guardAcquired: boolean;
		if (!guardRequired) {
			guardAcquired = false;
		} else {
			try {
				guardAcquired = this.options.leases.acquire(
					WITHDRAWAL_DELIVERY_GUARD_NAME,
					this.options.ownerId,
					now,
					OUTBOX_LEASE_TTL_MS
				);
			} catch (error) {
				this.options.leases.release(OUTBOX_JOB_NAME, this.options.ownerId);
				throw error;
			}
			if (!guardAcquired) {
				this.options.leases.release(OUTBOX_JOB_NAME, this.options.ownerId);
				return;
			}
		}

		let runId: number | undefined;
		let heartbeat: SchedulerTimerHandle | undefined;
		let primaryLeaseMaintained = true;
		let guardLeaseMaintained = true;
		try {
			const insert = this.options.database
				.prepare(
					`INSERT INTO job_runs (name, owner_id, started_at)
					VALUES (?, ?, ?)`
				)
				.run(OUTBOX_JOB_NAME, this.options.ownerId, now.toISOString());
			runId = Number(insert.lastInsertRowid);
			heartbeat = this.schedule(() => {
				try {
					primaryLeaseMaintained = this.options.leases.renew(
						OUTBOX_JOB_NAME,
						this.options.ownerId,
						this.clock(),
						OUTBOX_LEASE_TTL_MS
					);
				} catch {
					// The last confirmed lease remains valid; retry on the next 20-second heartbeat.
				}
				if (guardAcquired) {
					try {
						guardLeaseMaintained = this.options.leases.renew(
							WITHDRAWAL_DELIVERY_GUARD_NAME,
							this.options.ownerId,
							this.clock(),
							OUTBOX_LEASE_TTL_MS
						);
					} catch {
						// The last confirmed guard lease remains valid until the next heartbeat.
					}
				}
			}, OUTBOX_LEASE_HEARTBEAT_MS);
			heartbeat.unref?.();

			await this.options.worker.drain(now, OUTBOX_DRAIN_LIMIT, signal);
			if (!signal.aborted) {
				await this.options.withdrawalWorker?.drain(now, OUTBOX_DRAIN_LIMIT, signal);
			}
			if (!primaryLeaseMaintained || !guardLeaseMaintained) {
				throw new Error('OUTBOX_LEASE_LOST');
			}
			this.finishRun(runId, this.clock(), 'completed', null);
		} catch (error) {
			if (runId !== undefined) {
				this.finishRun(runId, this.clock(), 'failed', OUTBOX_DRAIN_ERROR_CODE);
			}
			throw error;
		} finally {
			if (heartbeat) this.cancel(heartbeat);
			if (guardAcquired) {
				this.options.leases.release(WITHDRAWAL_DELIVERY_GUARD_NAME, this.options.ownerId);
			}
			this.options.leases.release(OUTBOX_JOB_NAME, this.options.ownerId);
		}
	}

	private async executeStyriaRun(now: Date, signal: AbortSignal): Promise<void> {
		if (
			!this.options.leases.acquire(
				STYRIA_SYNC_JOB_NAME,
				this.options.ownerId,
				now,
				STYRIA_SYNC_LEASE_TTL_MS
			)
		) {
			return;
		}

		let runId: number | undefined;
		try {
			const insert = this.options.database
				.prepare(
					`INSERT INTO job_runs (name, owner_id, started_at)
					VALUES (?, ?, ?)`
				)
				.run(STYRIA_SYNC_JOB_NAME, this.options.ownerId, now.toISOString());
			runId = Number(insert.lastInsertRowid);
			await this.options.styriaSync?.run(now, signal);
			this.finishRun(runId, this.clock(), 'completed', null);
		} catch (error) {
			if (runId !== undefined) {
				this.finishRun(runId, this.clock(), 'failed', STYRIA_SYNC_ERROR_CODE);
			}
			throw error;
		} finally {
			this.options.leases.release(STYRIA_SYNC_JOB_NAME, this.options.ownerId);
		}
	}

	private async executeBackupRun(now: Date, signal: AbortSignal): Promise<void> {
		if (
			!this.options.leases.acquire(BACKUP_JOB_NAME, this.options.ownerId, now, BACKUP_LEASE_TTL_MS)
		) {
			return;
		}

		let runId: number | undefined;
		try {
			const insert = this.options.database
				.prepare(
					`INSERT INTO job_runs (name, owner_id, started_at)
					VALUES (?, ?, ?)`
				)
				.run(BACKUP_JOB_NAME, this.options.ownerId, now.toISOString());
			runId = Number(insert.lastInsertRowid);
			await this.options.backup?.run(now, signal);
			this.finishRun(runId, this.clock(), 'completed', null);
		} catch (error) {
			if (runId !== undefined) {
				this.finishRun(runId, this.clock(), 'failed', BACKUP_ERROR_CODE);
			}
			throw error;
		} finally {
			this.options.leases.release(BACKUP_JOB_NAME, this.options.ownerId);
		}
	}

	private async executeWithdrawalRetentionRun(now: Date, signal: AbortSignal): Promise<void> {
		if (
			!this.options.leases.acquire(
				WITHDRAWAL_RETENTION_JOB_NAME,
				this.options.ownerId,
				now,
				WITHDRAWAL_RETENTION_LEASE_TTL_MS
			)
		) {
			return;
		}

		let guardAcquired: boolean;
		try {
			guardAcquired = this.options.leases.acquire(
				WITHDRAWAL_DELIVERY_GUARD_NAME,
				this.options.ownerId,
				now,
				WITHDRAWAL_RETENTION_LEASE_TTL_MS
			);
		} catch (error) {
			this.options.leases.release(WITHDRAWAL_RETENTION_JOB_NAME, this.options.ownerId);
			throw error;
		}
		if (!guardAcquired) {
			this.options.leases.release(WITHDRAWAL_RETENTION_JOB_NAME, this.options.ownerId);
			return;
		}

		let runId: number | undefined;
		let heartbeat: SchedulerTimerHandle | undefined;
		let primaryLeaseMaintained = true;
		let guardLeaseMaintained = true;
		try {
			const insert = this.options.database
				.prepare(
					`INSERT INTO job_runs (name, owner_id, started_at)
					 VALUES (?, ?, ?)`
				)
				.run(WITHDRAWAL_RETENTION_JOB_NAME, this.options.ownerId, now.toISOString());
			runId = Number(insert.lastInsertRowid);
			heartbeat = this.schedule(() => {
				try {
					primaryLeaseMaintained = this.options.leases.renew(
						WITHDRAWAL_RETENTION_JOB_NAME,
						this.options.ownerId,
						this.clock(),
						WITHDRAWAL_RETENTION_LEASE_TTL_MS
					);
				} catch {
					// The last confirmed primary lease remains valid until the next heartbeat.
				}
				try {
					guardLeaseMaintained = this.options.leases.renew(
						WITHDRAWAL_DELIVERY_GUARD_NAME,
						this.options.ownerId,
						this.clock(),
						WITHDRAWAL_RETENTION_LEASE_TTL_MS
					);
				} catch {
					// The last confirmed guard lease remains valid until the next heartbeat.
				}
			}, WITHDRAWAL_RETENTION_LEASE_HEARTBEAT_MS);
			heartbeat.unref?.();

			await this.options.withdrawalRetention?.run(now, signal);
			if (!primaryLeaseMaintained || !guardLeaseMaintained) {
				throw new Error(WITHDRAWAL_RETENTION_ERROR_CODE);
			}
			this.finishRun(runId, this.clock(), 'completed', null);
		} catch (error) {
			if (runId !== undefined) {
				this.finishRun(runId, this.clock(), 'failed', WITHDRAWAL_RETENTION_ERROR_CODE);
			}
			throw error;
		} finally {
			if (heartbeat) this.cancel(heartbeat);
			this.options.leases.release(WITHDRAWAL_DELIVERY_GUARD_NAME, this.options.ownerId);
			this.options.leases.release(WITHDRAWAL_RETENTION_JOB_NAME, this.options.ownerId);
		}
	}

	private async executeOperationalChecksRun(now: Date, signal: AbortSignal): Promise<void> {
		if (
			!this.options.leases.acquire(
				OPERATIONAL_CHECKS_JOB_NAME,
				this.options.ownerId,
				now,
				OPERATIONAL_CHECKS_LEASE_TTL_MS
			)
		) {
			this.scheduleOperationalRetry(this.retryAfterOperationalLease(now));
			return;
		}

		let runId: number | undefined;
		try {
			const insert = this.options.database
				.prepare(
					`INSERT INTO job_runs (name, owner_id, started_at)
					VALUES (?, ?, ?)`
				)
				.run(OPERATIONAL_CHECKS_JOB_NAME, this.options.ownerId, now.toISOString());
			runId = Number(insert.lastInsertRowid);
			const result = await this.options.operationalChecks?.run(now, signal);
			const retryAt = result?.retryAt ?? null;
			if (retryAt !== null) {
				if (
					!(retryAt instanceof Date) ||
					!Number.isFinite(retryAt.getTime()) ||
					retryAt.getTime() <= now.getTime()
				) {
					throw new Error('OPERATIONAL_CHECK_RETRY_INVALID');
				}
				this.finishRun(runId, this.clock(), 'deferred', null);
				this.scheduleOperationalRetry(retryAt);
			} else {
				this.finishRun(runId, this.clock(), 'completed', null);
				this.cancelOperationalRetry();
			}
		} catch (error) {
			if (runId !== undefined) {
				this.finishRun(runId, this.clock(), 'failed', OPERATIONAL_CHECKS_ERROR_CODE);
			}
			throw error;
		} finally {
			this.options.leases.release(OPERATIONAL_CHECKS_JOB_NAME, this.options.ownerId);
		}
	}

	private enqueueFailureAlert(code: AlertCode, subjectId: string, now: Date): void {
		try {
			this.options.alerts?.enqueueAlert(code, subjectId, now);
		} catch {
			// Alert persistence failure must not recurse or replace the scheduler's stable result.
		}
	}

	private finishRun(
		runId: number,
		finishedAt: Date,
		result: 'completed' | 'deferred' | 'failed',
		errorCode: string | null
	): void {
		this.options.database
			.prepare(
				`UPDATE job_runs
				SET finished_at = ?, result = ?, error_code = ?
				WHERE id = ? AND owner_id = ? AND finished_at IS NULL`
			)
			.run(finishedAt.toISOString(), result, errorCode, runId, this.options.ownerId);
	}
}

function millisecondsUntilNextBackup(now: Date): number {
	const next = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 30, 0, 0)
	);
	if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
	return next.getTime() - now.getTime();
}

function millisecondsUntilNextOperationalChecks(now: Date): number {
	const next = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0, 0)
	);
	if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
	return next.getTime() - now.getTime();
}

function millisecondsUntilNextWithdrawalRetention(now: Date): number {
	const next = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 15, 0, 0)
	);
	if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
	return next.getTime() - now.getTime();
}
