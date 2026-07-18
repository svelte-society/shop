import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { migrate } from '$lib/server/db/migrate.server';
import type { AlertService } from '$lib/server/monitoring/alerts.server';
import { SqliteWithdrawalRepository } from '$lib/server/withdrawals/repository.server';
import { SqliteWithdrawalRetentionJob } from './withdrawal-retention.server';

const now = new Date('2026-07-18T03:15:00.000Z');
const migrationsDirectory = resolve('migrations');

function seedDueWithdrawalCases(database: Database.Database, count: number): void {
	const insert = database.prepare(`
		INSERT INTO withdrawal_cases (
			id, public_reference, status, revision, scope, eligibility, outcome_code,
			schema_version, encryption_key_version, encrypted_payload, payload_nonce,
			payload_tag, dedupe_fingerprint, created_at, updated_at,
			reconciled_at, closed_at, pii_purge_due_at, purged_at
		) VALUES (?, ?, 'closed', 1, 'entire_order', 'eligible_eu', 'WITHDRAWAL_COMPLETED',
			1, 1, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
	`);
	const seed = database.transaction(() => {
		for (let index = 0; index < count; index += 1) {
			insert.run(
				`retention_case_${index}`,
				`WDR-${String(index).padStart(22, '0')}`,
				Buffer.from([index + 1]),
				Buffer.alloc(12, index),
				Buffer.alloc(16, index),
				index.toString(16).padStart(64, '0'),
				now.toISOString(),
				now.toISOString(),
				now.toISOString(),
				now.toISOString()
			);
		}
	});
	seed();
}

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

	it('lets an external abort stop after the first real committed 100-row batch', async () => {
		const database = new Database(':memory:');
		try {
			migrate(database, migrationsDirectory);
			seedDueWithdrawalCases(database, 101);
			const alerts: AlertService = { enqueueAlert: vi.fn() };
			const job = new SqliteWithdrawalRetentionJob({
				repository: new SqliteWithdrawalRepository(database),
				alerts
			});
			const controller = new AbortController();
			const stopped = new Error('RETENTION_STOPPED_EXTERNALLY');

			const running = job.run(now, controller.signal);
			const committedBeforeAbort = database
				.prepare('SELECT COUNT(*) AS count FROM withdrawal_cases WHERE purged_at IS NOT NULL')
				.get() as { count: number };
			controller.abort(stopped);

			await expect(running).rejects.toBe(stopped);
			expect(committedBeforeAbort.count).toBe(100);
			expect(
				(
					database
						.prepare('SELECT COUNT(*) AS count FROM withdrawal_cases WHERE purged_at IS NOT NULL')
						.get() as { count: number }
				).count
			).toBe(100);
			expect(alerts.enqueueAlert).not.toHaveBeenCalled();
		} finally {
			database.close();
		}
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
