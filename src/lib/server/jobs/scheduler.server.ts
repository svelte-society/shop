import type { ShopDatabase } from '$lib/server/db/types';
import type { LeaseRepository } from './leases.server';
import type { OutboxWorker } from './outbox-worker.server';
import type { StyriaSyncJob } from './styria-sync.server';

export const OUTBOX_JOB_NAME = 'outbox';
export const STYRIA_SYNC_JOB_NAME = 'styria-sync';
const OUTBOX_INTERVAL_MS = 60_000;
const OUTBOX_LEASE_TTL_MS = 55_000;
const OUTBOX_LEASE_HEARTBEAT_MS = 20_000;
// A shipping job can spend up to three 10-second Stripe attempts plus one 10-second Plunk call.
// One job keeps that worst case inside the 55-second outbox lease.
const OUTBOX_DRAIN_LIMIT = 1;
const OUTBOX_DRAIN_ERROR_CODE = 'OUTBOX_DRAIN_FAILED';
const STYRIA_SYNC_INTERVAL_MS = 60 * 60_000;
const STYRIA_SYNC_LEASE_TTL_MS = 55 * 60_000;
const STYRIA_SYNC_ERROR_CODE = 'STYRIA_SYNC_FAILED';

export interface Scheduler {
	start(): void;
	stop(): Promise<void>;
	runOutboxOnce(now?: Date): Promise<void>;
	runStyriaSyncOnce(now?: Date): Promise<void>;
}

export type SchedulerTimerHandle = {
	unref?: () => void;
};

export type SchedulerTimer = (callback: () => void, intervalMs: number) => SchedulerTimerHandle;

export type OutboxSchedulerOptions = {
	database: ShopDatabase;
	leases: LeaseRepository;
	worker: OutboxWorker;
	styriaSync?: StyriaSyncJob;
	enabled: boolean;
	ownerId: string;
	clock?: () => Date;
	schedule?: SchedulerTimer;
	cancel?: (handle: SchedulerTimerHandle) => void;
	reportError?: (errorCode: string) => void;
};

const scheduleEvery: SchedulerTimer = (callback, intervalMs) => setInterval(callback, intervalMs);

function cancelScheduled(handle: SchedulerTimerHandle): void {
	clearInterval(handle as ReturnType<typeof setInterval>);
}

function reportSchedulerError(errorCode: string): void {
	console.error(JSON.stringify({ event: 'scheduler_failed', error_code: errorCode }));
}

export class OutboxScheduler implements Scheduler {
	private readonly clock: () => Date;
	private readonly schedule: SchedulerTimer;
	private readonly cancel: (handle: SchedulerTimerHandle) => void;
	private readonly reportError: (errorCode: string) => void;
	private started = false;
	private acceptingScheduledRuns = false;
	private timer: SchedulerTimerHandle | undefined;
	private styriaTimer: SchedulerTimerHandle | undefined;
	private activeRun: Promise<void> | undefined;
	private activeStyriaRun: Promise<void> | undefined;
	private readonly reportedRuns = new WeakSet<Promise<void>>();
	private readonly reportedStyriaRuns = new WeakSet<Promise<void>>();

	constructor(private readonly options: OutboxSchedulerOptions) {
		this.clock = options.clock ?? (() => new Date());
		this.schedule = options.schedule ?? scheduleEvery;
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
	}

	async stop(): Promise<void> {
		this.acceptingScheduledRuns = false;
		if (this.timer) {
			this.cancel(this.timer);
			this.timer = undefined;
		}
		if (this.styriaTimer) {
			this.cancel(this.styriaTimer);
			this.styriaTimer = undefined;
		}

		const activeRun = this.activeRun;
		const activeStyriaRun = this.activeStyriaRun;
		await Promise.all(
			[activeRun, activeStyriaRun].filter(Boolean).map(async (run) => {
				try {
					await run;
				} catch {
					// Scheduled failures are already recorded and reported; shutdown still waits for cleanup.
				}
			})
		);
	}

	runStyriaSyncOnce(now = this.clock()): Promise<void> {
		if (!this.options.styriaSync) return Promise.resolve();
		if (this.activeStyriaRun) return this.activeStyriaRun;

		const execution = Promise.resolve().then(() => this.executeStyriaRun(now));
		const trackedRun = execution.finally(() => {
			if (this.activeStyriaRun === trackedRun) this.activeStyriaRun = undefined;
		});
		this.activeStyriaRun = trackedRun;
		return trackedRun;
	}

	runOutboxOnce(now = this.clock()): Promise<void> {
		if (this.activeRun) return this.activeRun;

		const execution = Promise.resolve().then(() => this.executeRun(now));
		const trackedRun = execution.finally(() => {
			if (this.activeRun === trackedRun) this.activeRun = undefined;
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

	private async executeRun(now: Date): Promise<void> {
		if (
			!this.options.leases.acquire(OUTBOX_JOB_NAME, this.options.ownerId, now, OUTBOX_LEASE_TTL_MS)
		) {
			return;
		}

		let runId: number | undefined;
		let heartbeat: SchedulerTimerHandle | undefined;
		let leaseMaintained = true;
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
					leaseMaintained = this.options.leases.renew(
						OUTBOX_JOB_NAME,
						this.options.ownerId,
						this.clock(),
						OUTBOX_LEASE_TTL_MS
					);
				} catch {
					// The last confirmed lease remains valid; retry on the next 20-second heartbeat.
				}
			}, OUTBOX_LEASE_HEARTBEAT_MS);
			heartbeat.unref?.();

			await this.options.worker.drain(now, OUTBOX_DRAIN_LIMIT);
			if (!leaseMaintained) throw new Error('OUTBOX_LEASE_LOST');
			this.finishRun(runId, this.clock(), 'completed', null);
		} catch (error) {
			if (runId !== undefined) {
				this.finishRun(runId, this.clock(), 'failed', OUTBOX_DRAIN_ERROR_CODE);
			}
			throw error;
		} finally {
			if (heartbeat) this.cancel(heartbeat);
			this.options.leases.release(OUTBOX_JOB_NAME, this.options.ownerId);
		}
	}

	private async executeStyriaRun(now: Date): Promise<void> {
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
			await this.options.styriaSync?.run(now);
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

	private finishRun(
		runId: number,
		finishedAt: Date,
		result: 'completed' | 'failed',
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
