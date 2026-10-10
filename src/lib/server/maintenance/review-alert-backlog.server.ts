import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
	chmod,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
	backupChecksum,
	backupEncryptionKeyIsValid,
	decryptBackup,
	encryptBackup,
	verifyBackupChecksum
} from '$lib/server/backups/format';
import type { ShopDatabase } from '$lib/server/db/types';
import type { LeaseRepository } from '$lib/server/jobs/leases.server';

export const REVIEW_ALERT_BACKLOG_CONFIRMATION = 'SUPPRESS_REVIEW_ALERT_BACKLOG_AFTER_BACKUP';

const OUTBOX_LEASE_NAME = 'outbox';
const OUTBOX_LEASE_TTL_MS = 30 * 60_000;
const SUPPRESSION_REASON = 'REVIEW_ALERT_BACKLOG_CLEANUP';
const SUPPRESSION_ACTOR = 'codex-admin';
const TARGET_KEY_PREDICATE = `oj.kind = 'operational-alert'
	AND (
		(oj.alert_code = 'ORDER_PENDING_REVIEW'
			AND oj.idempotency_key GLOB 'alert:ORDER_PENDING_REVIEW:*')
		OR (oj.alert_code = 'STYRIA_REVIEW_REQUIRED'
			AND oj.idempotency_key GLOB 'alert:STYRIA_REVIEW_REQUIRED:*')
	)`;
const TARGET_PREDICATE = `${TARGET_KEY_PREDICATE}
	AND oj.completed_at IS NULL`;
const ACTIVE_TARGET_PREDICATE = `${TARGET_PREDICATE}
	AND NOT EXISTS (
		SELECT 1 FROM outbox_job_suppressions AS suppression
		WHERE suppression.outbox_job_id = oj.id
	)`;

export type ReviewAlertBacklogSuppressionInput = {
	expectedOutstandingCount: number;
	confirmation: typeof REVIEW_ALERT_BACKLOG_CONFIRMATION;
};

export type ReviewAlertBacklogSuppressionResult = {
	backupId: string;
	backupFilename: string;
	backupChecksum: string;
	suppressedCount: number;
	previouslySuppressedCount: number;
	remainingActiveCount: number;
	targetedRowCount: number;
	completedRowCount: number;
	totalOutboxRowCount: number;
};

export interface ReviewAlertBacklogSuppressionService {
	suppress(input: ReviewAlertBacklogSuppressionInput): Promise<ReviewAlertBacklogSuppressionResult>;
}

export type SqliteReviewAlertBacklogSuppressionOptions = {
	database: ShopDatabase;
	leases: LeaseRepository;
	encryptionKeyBase64: string;
	temporaryDirectory?: string;
	clock?: () => Date;
	createId?: () => string;
};

type CountRow = { count: unknown };

type SnapshotArtifact = {
	id: string;
	filename: string;
	path: string;
	checksumPath: string;
	checksum: string;
};

export class ReviewAlertBacklogSuppressionError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'ReviewAlertBacklogSuppressionError';
	}
}

function fail(code: string): never {
	throw new ReviewAlertBacklogSuppressionError(code);
}

function validCount(row: CountRow | undefined): number {
	if (!row || !Number.isSafeInteger(row.count) || (row.count as number) < 0) {
		fail('REVIEW_ALERT_SUPPRESSION_ROW_INVALID');
	}
	return row.count as number;
}

function healthySnapshot(path: string): boolean {
	const snapshot = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const rows = snapshot.pragma('quick_check') as Array<Record<string, unknown>>;
		return rows.length === 1 && rows[0]?.quick_check === 'ok';
	} finally {
		snapshot.close();
	}
}

function countActive(database: ShopDatabase): number {
	return validCount(
		database
			.prepare(`SELECT COUNT(*) AS count FROM outbox_jobs AS oj WHERE ${ACTIVE_TARGET_PREDICATE}`)
			.get() as CountRow | undefined
	);
}

async function assertPrivateFile(path: string): Promise<void> {
	const metadata = await stat(path);
	if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
		fail('REVIEW_ALERT_BACKUP_PERMISSION_INVALID');
	}
}

async function syncPath(path: string): Promise<void> {
	const handle = await open(path, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class SqliteReviewAlertBacklogSuppressionService implements ReviewAlertBacklogSuppressionService {
	private readonly clock: () => Date;
	private readonly createId: () => string;
	private readonly temporaryDirectory: string;

	constructor(private readonly options: SqliteReviewAlertBacklogSuppressionOptions) {
		this.clock = options.clock ?? (() => new Date());
		this.createId = options.createId ?? randomUUID;
		this.temporaryDirectory = options.temporaryDirectory ?? tmpdir();
	}

	async suppress(
		input: ReviewAlertBacklogSuppressionInput
	): Promise<ReviewAlertBacklogSuppressionResult> {
		if (
			!input ||
			!Number.isSafeInteger(input.expectedOutstandingCount) ||
			input.expectedOutstandingCount < 1 ||
			input.confirmation !== REVIEW_ALERT_BACKLOG_CONFIRMATION
		) {
			fail('REVIEW_ALERT_SUPPRESSION_INPUT_INVALID');
		}
		if (!backupEncryptionKeyIsValid(this.options.encryptionKeyBase64)) {
			fail('REVIEW_ALERT_BACKUP_KEY_INVALID');
		}
		const now = this.clock();
		if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
			fail('REVIEW_ALERT_SUPPRESSION_TIME_INVALID');
		}
		const databaseName = this.options.database.name;
		if (!databaseName || databaseName === ':memory:') {
			fail('REVIEW_ALERT_BACKUP_PATH_UNAVAILABLE');
		}

		const ownerId = `mcp-review-alert-suppression:${this.createId()}`;
		if (!this.options.leases.acquire(OUTBOX_LEASE_NAME, ownerId, now, OUTBOX_LEASE_TTL_MS)) {
			fail('REVIEW_ALERT_OUTBOX_LEASE_BUSY');
		}

		let artifact: SnapshotArtifact | undefined;
		let suppressionCommitted = false;
		try {
			const activeBeforeBackup = countActive(this.options.database);
			if (activeBeforeBackup !== input.expectedOutstandingCount) {
				fail('REVIEW_ALERT_OUTSTANDING_COUNT_MISMATCH');
			}

			artifact = await this.createVerifiedBackup(input.expectedOutstandingCount);
			const transactionNow = this.clock();
			if (!(transactionNow instanceof Date) || !Number.isFinite(transactionNow.getTime())) {
				fail('REVIEW_ALERT_SUPPRESSION_TIME_INVALID');
			}
			if (
				!this.options.leases.renew(OUTBOX_LEASE_NAME, ownerId, transactionNow, OUTBOX_LEASE_TTL_MS)
			) {
				fail('REVIEW_ALERT_OUTBOX_LEASE_LOST');
			}
			const result = this.suppressTransaction(
				input.expectedOutstandingCount,
				artifact,
				transactionNow
			);
			suppressionCommitted = true;
			return result;
		} catch (error) {
			if (artifact && !suppressionCommitted) {
				await Promise.all([
					rm(artifact.path, { force: true }),
					rm(artifact.checksumPath, { force: true })
				]);
			}
			if (error instanceof ReviewAlertBacklogSuppressionError) throw error;
			fail('REVIEW_ALERT_SUPPRESSION_FAILED');
		} finally {
			this.options.leases.release(OUTBOX_LEASE_NAME, ownerId);
		}
	}

	private async createVerifiedBackup(expectedActiveCount: number): Promise<SnapshotArtifact> {
		const databasePath = resolve(this.options.database.name);
		const databaseDirectory = dirname(databasePath);
		const artifactDirectory = join(databaseDirectory, 'review-alert-backups');
		const id = this.createId();
		const filename = `${id}.sqlite.ssbk`;
		const artifactPath = join(artifactDirectory, filename);
		const checksumPath = `${artifactPath}.sha256`;
		const buildingArtifactPath = `${artifactPath}.building`;
		const buildingChecksumPath = `${checksumPath}.building`;
		await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
		await chmod(artifactDirectory, 0o700);
		await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
		const runDirectory = await mkdtemp(join(this.temporaryDirectory, 'review-alert-backup-'));
		await chmod(runDirectory, 0o700);
		const snapshotPath = join(runDirectory, 'snapshot.sqlite');
		const verificationPath = join(runDirectory, 'verification.sqlite');
		try {
			await this.options.database.backup(snapshotPath);
			await chmod(snapshotPath, 0o600);
			if (!healthySnapshot(snapshotPath)) fail('REVIEW_ALERT_BACKUP_SNAPSHOT_INVALID');
			const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
			try {
				if (countActive(snapshot) !== expectedActiveCount) {
					fail('REVIEW_ALERT_BACKUP_COUNT_MISMATCH');
				}
			} finally {
				snapshot.close();
			}

			const plaintext = await readFile(snapshotPath);
			let encrypted: Uint8Array;
			try {
				encrypted = encryptBackup(plaintext, this.options.encryptionKeyBase64);
			} finally {
				plaintext.fill(0);
			}
			const checksum = backupChecksum(encrypted);
			await writeFile(buildingArtifactPath, encrypted, { flag: 'wx', mode: 0o600 });
			await writeFile(buildingChecksumPath, `${checksum}\n`, {
				encoding: 'ascii',
				flag: 'wx',
				mode: 0o600
			});
			await Promise.all([chmod(buildingArtifactPath, 0o600), chmod(buildingChecksumPath, 0o600)]);
			await Promise.all([
				assertPrivateFile(buildingArtifactPath),
				assertPrivateFile(buildingChecksumPath)
			]);
			await Promise.all([syncPath(buildingArtifactPath), syncPath(buildingChecksumPath)]);

			const stored = await readFile(buildingArtifactPath);
			verifyBackupChecksum(stored, await readFile(buildingChecksumPath, 'ascii'));
			const decrypted = Buffer.from(decryptBackup(stored, this.options.encryptionKeyBase64));
			try {
				await writeFile(verificationPath, decrypted, { flag: 'wx', mode: 0o600 });
				await chmod(verificationPath, 0o600);
				if (!healthySnapshot(verificationPath)) {
					fail('REVIEW_ALERT_BACKUP_VERIFICATION_FAILED');
				}
				const verified = new Database(verificationPath, { readonly: true, fileMustExist: true });
				try {
					if (countActive(verified) !== expectedActiveCount) {
						fail('REVIEW_ALERT_BACKUP_COUNT_MISMATCH');
					}
				} finally {
					verified.close();
				}
			} finally {
				decrypted.fill(0);
			}
			// Publish the checksum first and the verified encrypted artifact last. Consumers can
			// therefore treat the final .ssbk name as the atomic availability boundary.
			await rename(buildingChecksumPath, checksumPath);
			await rename(buildingArtifactPath, artifactPath);
			await syncPath(artifactDirectory);

			return {
				id,
				filename: basename(artifactPath),
				path: artifactPath,
				checksumPath,
				checksum
			};
		} catch (error) {
			await Promise.all([
				rm(buildingArtifactPath, { force: true }),
				rm(buildingChecksumPath, { force: true }),
				rm(artifactPath, { force: true }),
				rm(checksumPath, { force: true })
			]);
			throw error;
		} finally {
			await rm(runDirectory, { recursive: true, force: true });
		}
	}

	private suppressTransaction(
		expectedCount: number,
		artifact: SnapshotArtifact,
		now: Date
	): ReviewAlertBacklogSuppressionResult {
		const timestamp = now.toISOString();
		const suppress = this.options.database.transaction(() => {
			const activeCount = countActive(this.options.database);
			if (activeCount !== expectedCount) fail('REVIEW_ALERT_OUTSTANDING_COUNT_MISMATCH');

			const totalOutboxBefore = validCount(
				this.options.database.prepare('SELECT COUNT(*) AS count FROM outbox_jobs').get() as
					CountRow | undefined
			);
			const targetedRowCount = validCount(
				this.options.database
					.prepare(`SELECT COUNT(*) AS count FROM outbox_jobs AS oj WHERE ${TARGET_KEY_PREDICATE}`)
					.get() as CountRow | undefined
			);
			const completedRowCount = validCount(
				this.options.database
					.prepare(
						`SELECT COUNT(*) AS count FROM outbox_jobs AS oj
						 WHERE ${TARGET_KEY_PREDICATE}
						   AND oj.completed_at IS NOT NULL`
					)
					.get() as CountRow | undefined
			);
			const previouslySuppressedCount = validCount(
				this.options.database
					.prepare(
						`SELECT COUNT(*) AS count
						 FROM outbox_job_suppressions AS suppression
						 JOIN outbox_jobs AS oj ON oj.id = suppression.outbox_job_id
						 WHERE ${TARGET_KEY_PREDICATE}`
					)
					.get() as CountRow | undefined
			);

			const inserted = this.options.database
				.prepare(
					`INSERT INTO outbox_job_suppressions (
						outbox_job_id, reason, actor, backup_id, backup_filename,
						backup_sha256, previous_next_attempt_at,
						previous_last_error_code, suppressed_at
					)
					SELECT oj.id, ?, ?, ?, ?, ?, oj.next_attempt_at, oj.last_error_code, ?
					FROM outbox_jobs AS oj
					WHERE ${ACTIVE_TARGET_PREDICATE}`
				)
				.run(
					SUPPRESSION_REASON,
					SUPPRESSION_ACTOR,
					artifact.id,
					artifact.filename,
					artifact.checksum,
					timestamp
				).changes;
			if (inserted !== expectedCount) fail('REVIEW_ALERT_SUPPRESSION_COUNT_MISMATCH');
			const terminallyMarked = this.options.database
				.prepare(
					`UPDATE outbox_jobs
					 SET completed_at = ?
					 WHERE completed_at IS NULL
					   AND id IN (
						SELECT outbox_job_id FROM outbox_job_suppressions
						WHERE backup_id = ?
					   )`
				)
				.run(timestamp, artifact.id).changes;
			if (terminallyMarked !== expectedCount) {
				fail('REVIEW_ALERT_SUPPRESSION_COUNT_MISMATCH');
			}
			const remainingActiveCount = countActive(this.options.database);
			if (remainingActiveCount !== 0) fail('REVIEW_ALERT_SUPPRESSION_VERIFICATION_FAILED');
			const totalOutboxAfter = validCount(
				this.options.database.prepare('SELECT COUNT(*) AS count FROM outbox_jobs').get() as
					CountRow | undefined
			);
			if (totalOutboxAfter !== totalOutboxBefore) fail('REVIEW_ALERT_ROW_PRESERVATION_FAILED');

			return {
				backupId: artifact.id,
				backupFilename: artifact.filename,
				backupChecksum: artifact.checksum,
				suppressedCount: inserted,
				previouslySuppressedCount,
				remainingActiveCount,
				targetedRowCount,
				completedRowCount,
				totalOutboxRowCount: totalOutboxAfter
			};
		});

		return suppress.immediate();
	}
}
