import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptBackup } from '$lib/server/backups/format';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteLeaseRepository } from '$lib/server/jobs/leases.server';
import {
	REVIEW_ALERT_BACKLOG_CONFIRMATION,
	SqliteReviewAlertBacklogSuppressionService
} from '$lib/server/maintenance/review-alert-backlog.server';
import { createMcpServer } from '../server';

const migrationsDirectory = resolve('migrations');
const now = new Date('2026-10-10T18:30:00.000Z');
const encryptionKey = randomBytes(32).toString('base64');

type RpcResult = {
	result: {
		isError?: boolean;
		structuredContent?: Record<string, unknown>;
		tools?: Array<{ name: string; annotations: Record<string, boolean> }>;
	};
};

let directory: string;
let database: ShopDatabase;

function insertJob(input: {
	kind: string;
	key: string;
	code?: string;
	completed?: boolean;
}): number {
	const result = database
		.prepare(
			`INSERT INTO outbox_jobs (
				kind, idempotency_key, order_id, attempt_count, next_attempt_at,
				completed_at, last_error_code, alert_code, alert_subject_id, alert_observed_at
			) VALUES (?, ?, NULL, 4, ?, ?, 'EMAIL_FAILED', ?, ?, ?)`
		)
		.run(
			input.kind,
			input.key,
			now.toISOString(),
			input.completed ? now.toISOString() : null,
			input.code ?? null,
			input.code ? `subject-${input.key}` : null,
			input.code ? now.toISOString() : null
		);
	return Number(result.lastInsertRowid);
}

function seedBacklog(): { targetedIds: number[]; completedId: number; unrelatedIds: number[] } {
	const pendingId = insertJob({
		kind: 'operational-alert',
		key: 'alert:ORDER_PENDING_REVIEW:order-one:2026-10-10',
		code: 'ORDER_PENDING_REVIEW'
	});
	const styriaId = insertJob({
		kind: 'operational-alert',
		key: 'alert:STYRIA_REVIEW_REQUIRED:order-two:2026-10-10T18',
		code: 'STYRIA_REVIEW_REQUIRED'
	});
	const completedId = insertJob({
		kind: 'operational-alert',
		key: 'alert:STYRIA_REVIEW_REQUIRED:order-old:2026-10-09T18',
		code: 'STYRIA_REVIEW_REQUIRED',
		completed: true
	});
	const otherAlertId = insertJob({
		kind: 'operational-alert',
		key: 'alert:BACKUP_FAILED:daily-backup:2026-10-10T18',
		code: 'BACKUP_FAILED'
	});
	const shippingId = insertJob({ kind: 'shipping-email', key: 'shipping:order-three:track-3' });
	return {
		targetedIds: [pendingId, styriaId],
		completedId,
		unrelatedIds: [otherAlertId, shippingId]
	};
}

function createService() {
	let id = 0;
	return new SqliteReviewAlertBacklogSuppressionService({
		database,
		leases: new SqliteLeaseRepository(database),
		encryptionKeyBase64: encryptionKey,
		temporaryDirectory: join(directory, 'plaintext-temporary'),
		clock: () => now,
		createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
	});
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'review-alert-suppression-test-'));
	database = new Database(join(directory, 'shop.sqlite'));
	database.pragma('journal_mode = WAL');
	database.pragma('foreign_keys = ON');
	migrate(database, migrationsDirectory);
});

afterEach(async () => {
	if (database.open) database.close();
	await rm(directory, { recursive: true, force: true });
});

describe('review alert backlog suppression service', () => {
	it('backs up, verifies, and suppresses only active targeted jobs without deleting history', async () => {
		const seeded = seedBacklog();
		const beforeRows = database.prepare('SELECT * FROM outbox_jobs ORDER BY id').all();
		const result = await createService().suppress({
			expectedOutstandingCount: 2,
			confirmation: REVIEW_ALERT_BACKLOG_CONFIRMATION
		});

		expect(result).toMatchObject({
			suppressedCount: 2,
			previouslySuppressedCount: 0,
			remainingActiveCount: 0,
			targetedRowCount: 3,
			completedRowCount: 1,
			totalOutboxRowCount: 5
		});
		const afterRows = database.prepare('SELECT * FROM outbox_jobs ORDER BY id').all() as Array<
			Record<string, unknown>
		>;
		expect(afterRows).toHaveLength(beforeRows.length);
		for (const before of beforeRows as Array<Record<string, unknown>>) {
			const after = afterRows.find(({ id }) => id === before.id);
			if (seeded.targetedIds.includes(before.id as number)) {
				expect(after).toEqual({ ...before, completed_at: now.toISOString() });
			} else {
				expect(after).toEqual(before);
			}
		}
		expect(
			database
				.prepare(
					`SELECT outbox_job_id, reason, actor, backup_id, backup_filename,
						backup_sha256, previous_next_attempt_at,
						previous_last_error_code, suppressed_at
					 FROM outbox_job_suppressions ORDER BY outbox_job_id`
				)
				.all()
		).toEqual([
			expect.objectContaining({
				reason: 'REVIEW_ALERT_BACKLOG_CLEANUP',
				actor: 'codex-admin',
				backup_id: result.backupId,
				backup_filename: result.backupFilename,
				backup_sha256: result.backupChecksum,
				previous_next_attempt_at: now.toISOString(),
				previous_last_error_code: 'EMAIL_FAILED',
				suppressed_at: now.toISOString()
			}),
			expect.objectContaining({ backup_id: result.backupId })
		]);

		expect(
			database
				.prepare(
					`SELECT id FROM outbox_jobs
					 WHERE completed_at IS NULL AND next_attempt_at <= ?
					 ORDER BY id`
				)
				.all(now.toISOString())
		).toEqual(seeded.unrelatedIds.map((id) => ({ id })));
		const claimed = new SqliteOutboxRepository(database).claimDue(now, 10);
		expect(claimed.map(({ id }) => id).sort((left, right) => left - right)).toEqual(
			seeded.unrelatedIds.sort((left, right) => left - right)
		);
		expect(claimed.map(({ id }) => id)).not.toContain(seeded.completedId);

		const artifactPath = join(directory, 'review-alert-backups', result.backupFilename);
		const checksumPath = `${artifactPath}.sha256`;
		const encrypted = await readFile(artifactPath);
		expect(encrypted.subarray(0, 5).toString('ascii')).toBe('SSBK1');
		expect(encrypted.includes(Buffer.from('SQLite format 3\0'))).toBe(false);
		expect(createHash('sha256').update(encrypted).digest('hex')).toBe(result.backupChecksum);
		expect((await readFile(checksumPath, 'ascii')).trim()).toBe(result.backupChecksum);
		expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
		expect((await stat(checksumPath)).mode & 0o777).toBe(0o600);
		expect((await readdir(join(directory, 'review-alert-backups'))).sort()).toEqual(
			[result.backupFilename, `${result.backupFilename}.sha256`].sort()
		);

		const restoredPath = join(directory, 'independent-restore.sqlite');
		const plaintext = Buffer.from(decryptBackup(encrypted, encryptionKey));
		try {
			await writeFile(restoredPath, plaintext, { mode: 0o600 });
		} finally {
			plaintext.fill(0);
		}
		const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
		try {
			expect(restored.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
			expect(
				restored.prepare('SELECT COUNT(*) AS count FROM outbox_job_suppressions').get()
			).toEqual({ count: 0 });
			expect(restored.prepare('SELECT COUNT(*) AS count FROM outbox_jobs').get()).toEqual({
				count: 5
			});
			expect(
				restored
					.prepare(
						`SELECT COUNT(*) AS count FROM outbox_jobs
						 WHERE completed_at IS NULL
						   AND alert_code IN ('ORDER_PENDING_REVIEW', 'STYRIA_REVIEW_REQUIRED')`
					)
					.get()
			).toEqual({ count: 2 });
		} finally {
			restored.close();
		}
		expect(await readdir(join(directory, 'plaintext-temporary'))).toEqual([]);
	});

	it('fails closed while the outbox lease is busy', async () => {
		seedBacklog();
		const leases = new SqliteLeaseRepository(database);
		expect(leases.acquire('outbox', 'active-worker', now, 60_000)).toBe(true);
		const service = new SqliteReviewAlertBacklogSuppressionService({
			database,
			leases,
			encryptionKeyBase64: encryptionKey,
			temporaryDirectory: join(directory, 'plaintext-temporary'),
			clock: () => now
		});

		await expect(
			service.suppress({
				expectedOutstandingCount: 2,
				confirmation: REVIEW_ALERT_BACKLOG_CONFIRMATION
			})
		).rejects.toMatchObject({ code: 'REVIEW_ALERT_OUTBOX_LEASE_BUSY' });
		expect(database.prepare('SELECT COUNT(*) AS count FROM outbox_job_suppressions').get()).toEqual(
			{ count: 0 }
		);
	});

	it('rejects an outdated expected count before creating a backup or suppression records', async () => {
		seedBacklog();

		await expect(
			createService().suppress({
				expectedOutstandingCount: 3,
				confirmation: REVIEW_ALERT_BACKLOG_CONFIRMATION
			})
		).rejects.toMatchObject({ code: 'REVIEW_ALERT_OUTSTANDING_COUNT_MISMATCH' });
		expect(database.prepare('SELECT COUNT(*) AS count FROM outbox_job_suppressions').get()).toEqual(
			{ count: 0 }
		);
		await expect(readdir(join(directory, 'review-alert-backups'))).rejects.toMatchObject({
			code: 'ENOENT'
		});
	});

	it('removes the backup and leaves jobs active when lease ownership expires during backup', async () => {
		seedBacklog();
		let clockRead = 0;
		const service = new SqliteReviewAlertBacklogSuppressionService({
			database,
			leases: new SqliteLeaseRepository(database),
			encryptionKeyBase64: encryptionKey,
			temporaryDirectory: join(directory, 'plaintext-temporary'),
			clock: () => (clockRead++ === 0 ? now : new Date(now.getTime() + 30 * 60_000 + 1)),
			createId: (() => {
				let id = 0;
				return () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
			})()
		});

		await expect(
			service.suppress({
				expectedOutstandingCount: 2,
				confirmation: REVIEW_ALERT_BACKLOG_CONFIRMATION
			})
		).rejects.toMatchObject({ code: 'REVIEW_ALERT_OUTBOX_LEASE_LOST' });
		expect(database.prepare('SELECT COUNT(*) AS count FROM outbox_job_suppressions').get()).toEqual(
			{ count: 0 }
		);
		expect(
			database
				.prepare(
					`SELECT COUNT(*) AS count FROM outbox_jobs
					 WHERE completed_at IS NULL
					   AND alert_code IN ('ORDER_PENDING_REVIEW', 'STYRIA_REVIEW_REQUIRED')`
				)
				.get()
		).toEqual({ count: 2 });
		expect(await readdir(join(directory, 'review-alert-backups'))).toEqual([]);
	});
});

describe('suppress_review_alert_backlog MCP contract', () => {
	it('advertises destructive local semantics and requires exact confirmation input', async () => {
		const suppression = {
			suppress: vi.fn(async () => ({
				backupId: 'backup-id',
				backupFilename: 'backup-id.sqlite.ssbk',
				backupChecksum: 'a'.repeat(64),
				suppressedCount: 2,
				previouslySuppressedCount: 0,
				remainingActiveCount: 0,
				targetedRowCount: 3,
				completedRowCount: 1,
				totalOutboxRowCount: 5
			}))
		};
		const server = createMcpServer({ reviewAlertBacklogSuppression: suppression });
		const listed = (await server.receive({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: {}
		})) as RpcResult;
		const tool = listed.result.tools?.find(({ name }) => name === 'suppress_review_alert_backlog');
		expect(tool?.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false
		});

		const rejected = (await server.receive({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'suppress_review_alert_backlog',
				arguments: { expected_outstanding_count: 2, confirmation: 'wrong' }
			}
		})) as RpcResult;
		expect(rejected.result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'INVALID_TOOL_ARGUMENTS' } }
		});
		expect(suppression.suppress).not.toHaveBeenCalled();

		const accepted = (await server.receive({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: {
				name: 'suppress_review_alert_backlog',
				arguments: {
					expected_outstanding_count: 2,
					confirmation: REVIEW_ALERT_BACKLOG_CONFIRMATION
				}
			}
		})) as RpcResult;
		expect(accepted.result.structuredContent).toMatchObject({
			backup_filename: 'backup-id.sqlite.ssbk',
			backup_sha256: 'a'.repeat(64),
			suppressed_count: 2,
			remaining_active_count: 0
		});
		expect(suppression.suppress).toHaveBeenCalledWith({
			expectedOutstandingCount: 2,
			confirmation: REVIEW_ALERT_BACKLOG_CONFIRMATION
		});
	});
});
