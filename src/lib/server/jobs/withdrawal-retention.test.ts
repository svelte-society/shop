import { describe, expect, it, vi } from 'vitest';
import type { AlertService } from '$lib/server/monitoring/alerts.server';
import { SqliteWithdrawalRetentionJob } from './withdrawal-retention.server';

const now = new Date('2026-07-18T03:15:00.000Z');

function setup(purgeDue = vi.fn<() => number>(() => 0)) {
	const alerts: AlertService = { enqueueAlert: vi.fn() };
	return {
		purgeDue,
		alerts,
		job: new SqliteWithdrawalRetentionJob({ repository: { purgeDue }, alerts })
	};
}

describe('SqliteWithdrawalRetentionJob', () => {
	it('repeats fixed-size purge batches until one returns fewer than 100', async () => {
		const fixture = setup(
			vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(100).mockReturnValue(3)
		);

		await expect(fixture.job.run(now)).resolves.toEqual({ purged: 203 });
		expect(fixture.purgeDue).toHaveBeenCalledTimes(3);
		expect(fixture.purgeDue).toHaveBeenNthCalledWith(1, now, 100);
		expect(fixture.purgeDue).toHaveBeenNthCalledWith(2, now, 100);
		expect(fixture.purgeDue).toHaveBeenNthCalledWith(3, now, 100);
		expect(fixture.alerts.enqueueAlert).not.toHaveBeenCalled();
	});

	it('honors abort between committed batches without starting another purge', async () => {
		const controller = new AbortController();
		const stopped = new Error('RETENTION_STOPPED');
		const purgeDue = vi.fn(() => {
			controller.abort(stopped);
			return 100;
		});
		const fixture = setup(purgeDue);

		await expect(fixture.job.run(now, controller.signal)).rejects.toBe(stopped);
		expect(purgeDue).toHaveBeenCalledOnce();
		expect(fixture.alerts.enqueueAlert).not.toHaveBeenCalled();
	});

	it('returns a stable failure and a PII-free scheduler alert when a purge batch fails', async () => {
		const fixture = setup(
			vi.fn(() => {
				throw new Error('private.customer@example.test remained encrypted');
			})
		);

		await expect(fixture.job.run(now)).rejects.toThrowError('WITHDRAWAL_RETENTION_FAILED');
		expect(fixture.alerts.enqueueAlert).toHaveBeenCalledOnce();
		expect(fixture.alerts.enqueueAlert).toHaveBeenCalledWith(
			'SCHEDULER_FAILED',
			'withdrawal-retention',
			now
		);
		expect(JSON.stringify(vi.mocked(fixture.alerts.enqueueAlert).mock.calls)).not.toContain(
			'private.customer@example.test'
		);
	});

	it('depends only on the purge API and never requests a decrypted case read', async () => {
		const fixture = setup(vi.fn().mockReturnValue(0));
		const repository = {
			purgeDue: fixture.purgeDue,
			loadEncryptedById: vi.fn(() => {
				throw new Error('DECRYPT_PATH_MUST_NOT_RUN');
			})
		};
		const job = new SqliteWithdrawalRetentionJob({ repository, alerts: fixture.alerts });

		await expect(job.run(now)).resolves.toEqual({ purged: 0 });
		expect(repository.loadEncryptedById).not.toHaveBeenCalled();
	});
});
