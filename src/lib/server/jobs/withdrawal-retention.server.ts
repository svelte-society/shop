import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { AlertService } from '$lib/server/monitoring/alerts.server';
import type { SqliteWithdrawalRepository } from '$lib/server/withdrawals/repository.server';

const PURGE_BATCH_LIMIT = 100;
const JOB_NAME = 'withdrawal-retention';

export interface WithdrawalRetentionJob {
	run(now: Date, signal?: AbortSignal): Promise<{ purged: number }>;
}

export type WithdrawalRetentionDependencies = {
	repository: Pick<SqliteWithdrawalRepository, 'purgeDue'>;
	alerts: AlertService;
};

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error('WITHDRAWAL_RETENTION_ABORTED');
}

export class SqliteWithdrawalRetentionJob implements WithdrawalRetentionJob {
	constructor(private readonly dependencies: WithdrawalRetentionDependencies) {}

	async run(now: Date, signal?: AbortSignal): Promise<{ purged: number }> {
		let purged = 0;
		try {
			if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
				throw new Error('WITHDRAWAL_RETENTION_FAILED');
			}
			throwIfAborted(signal);
			while (true) {
				const batch = this.dependencies.repository.purgeDue(now, PURGE_BATCH_LIMIT);
				purged += batch;
				if (batch < PURGE_BATCH_LIMIT) return { purged };
				await yieldToEventLoop();
				throwIfAborted(signal);
			}
		} catch (error) {
			throwIfAborted(signal);
			try {
				this.dependencies.alerts.enqueueAlert('SCHEDULER_FAILED', JOB_NAME, now);
			} catch {
				// The stable retention failure must survive independent alert persistence failure.
			}
			throw new Error('WITHDRAWAL_RETENTION_FAILED', { cause: error });
		}
	}
}
