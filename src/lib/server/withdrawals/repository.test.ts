import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WithdrawalPayloadV1 } from '$lib/domain/withdrawals';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { encryptWithdrawalPayload } from './crypto.server';
import { SqliteWithdrawalRepository, type CreateWithdrawalSubmission } from './repository.server';

const migrationsDirectory = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const now = new Date('2026-07-17T08:30:00.000Z');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'withdrawal-repository-'));
	temporaryDirectories.push(directory);
	return directory;
}

function payload(overrides: Partial<WithdrawalPayloadV1> = {}): WithdrawalPayloadV1 {
	return {
		fullName: 'Private Test Name',
		receiptEmail: 'Private.Customer@example.com',
		enteredOrderReference: 'PRIVATE-ORDER-42',
		items: [{ description: 'Private orange hoodie', quantity: 2 }],
		reconciliation: null,
		...overrides
	};
}

function submission(
	overrides: Partial<CreateWithdrawalSubmission> = {}
): CreateWithdrawalSubmission {
	const id = overrides.id ?? 'case_123';
	return {
		id,
		reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
		scope: 'specific_items',
		encryptedPayload: encryptWithdrawalPayload(payload(), id, key),
		dedupeFingerprint: 'a'.repeat(64),
		createdAt: now,
		...overrides
	};
}

function count(database: ShopDatabase | Database.Database, table: string): number {
	return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
		.count;
}

function openIndependentDatabase(path: string): Database.Database {
	const database = new Database(path);
	database.pragma('journal_mode = WAL');
	database.pragma('foreign_keys = ON');
	database.pragma('busy_timeout = 5000');
	database.pragma('synchronous = FULL');
	return database;
}

async function waitForFiles(paths: string[], timeoutMilliseconds = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (!paths.every((path) => existsSync(path))) {
		if (Date.now() >= deadline) throw new Error('TEST_BARRIER_TIMEOUT');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

type Contender = {
	completion: Promise<{ created: boolean; reference: string }>;
	kill(): void;
};

function spawnContender(
	scriptPath: string,
	databasePath: string,
	id: string,
	reference: string,
	readyPath: string,
	startPath: string,
	resultPath: string
): Contender {
	const child = spawn(
		process.execPath,
		[
			'--no-warnings',
			'--experimental-transform-types',
			scriptPath,
			databasePath,
			id,
			reference,
			readyPath,
			startPath,
			resultPath
		],
		{ cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
	);
	const completion = new Promise<{ created: boolean; reference: string }>((resolve, reject) => {
		let stderr = '';
		child.stderr.on('data', (chunk) => (stderr += String(chunk)));
		child.once('error', reject);
		child.once('exit', (code) => {
			if (code !== 0) {
				reject(new Error(`CONTENDER_FAILED_${code}:${stderr}`));
				return;
			}
			resolve(
				JSON.parse(readFileSync(resultPath, 'utf8')) as { created: boolean; reference: string }
			);
		});
	});
	void completion.catch(() => undefined);
	return { completion, kill: () => child.kill() };
}

let database: ShopDatabase;
let repository: SqliteWithdrawalRepository;

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, migrationsDirectory);
	repository = new SqliteWithdrawalRepository(database);
});

afterEach(() => {
	closeDatabase();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('SqliteWithdrawalRepository submissions', () => {
	it('atomically creates one encrypted case, receipt, PII-free alert, and initial event', () => {
		const result = repository.createSubmission(submission());

		expect(result).toEqual({
			created: true,
			case: {
				id: 'case_123',
				reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				status: 'submitted',
				revision: 1,
				scope: 'specific_items',
				eligibility: 'pending',
				outcomeCode: null,
				createdAt: now,
				updatedAt: now,
				reconciledAt: null,
				closedAt: null,
				piiPurgeDueAt: null,
				purgedAt: null
			},
			receiptMessageId: 1
		});
		expect(
			database
				.prepare(
					`SELECT kind, idempotency_key, attempt_count, next_attempt_at,
						provider_delivery_id, completed_at, last_error_code
					 FROM withdrawal_messages`
				)
				.get()
		).toEqual({
			kind: 'receipt',
			idempotency_key: 'withdrawal:receipt:case_123',
			attempt_count: 0,
			next_attempt_at: now.toISOString(),
			provider_delivery_id: null,
			completed_at: null,
			last_error_code: null
		});
		expect(
			database
				.prepare(
					`SELECT kind, idempotency_key, order_id, alert_code,
						alert_subject_id, alert_observed_at
					 FROM outbox_jobs`
				)
				.get()
		).toEqual({
			kind: 'operational-alert',
			idempotency_key: 'alert:WITHDRAWAL_NOTICE_RECEIVED:WDR-AAAAAAAAAAAAAAAAAAAAAA:2026-07-17T08',
			order_id: null,
			alert_code: 'WITHDRAWAL_NOTICE_RECEIVED',
			alert_subject_id: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
			alert_observed_at: now.toISOString()
		});
		expect(
			database
				.prepare(
					`SELECT actor, action, prior_status, next_status, result_code, created_at
					 FROM withdrawal_case_events`
				)
				.get()
		).toEqual({
			actor: 'customer',
			action: 'submitted',
			prior_status: null,
			next_status: 'submitted',
			result_code: 'NOTICE_RECEIVED',
			created_at: now.toISOString()
		});
	});

	it('rolls back every row when a late atomic insert fails', () => {
		database.exec(`
			CREATE TRIGGER reject_withdrawal_event BEFORE INSERT ON withdrawal_case_events
			BEGIN
				SELECT RAISE(ABORT, 'test late failure');
			END
		`);

		expect(() => repository.createSubmission(submission())).toThrowError(
			'WITHDRAWAL_SUBMISSION_FAILED'
		);
		for (const table of [
			'withdrawal_cases',
			'withdrawal_messages',
			'withdrawal_case_events',
			'outbox_jobs'
		]) {
			expect(count(database, table), table).toBe(0);
		}
	});

	it('reuses an exact fingerprint through the inclusive 24-hour boundary and not afterward', () => {
		const first = repository.createSubmission(submission());
		const atBoundary = repository.createSubmission(
			submission({
				id: 'case_boundary',
				reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
				encryptedPayload: encryptWithdrawalPayload(payload(), 'case_boundary', key),
				createdAt: new Date(now.getTime() + 24 * 60 * 60_000)
			})
		);
		const afterBoundary = repository.createSubmission(
			submission({
				id: 'case_after',
				reference: 'WDR-CCCCCCCCCCCCCCCCCCCCCC',
				encryptedPayload: encryptWithdrawalPayload(payload(), 'case_after', key),
				createdAt: new Date(now.getTime() + 24 * 60 * 60_000 + 1)
			})
		);

		expect(atBoundary).toEqual({ ...first, created: false });
		expect(afterBoundary.created).toBe(true);
		expect(afterBoundary.case.id).toBe('case_after');
		expect(count(database, 'withdrawal_cases')).toBe(2);
		expect(count(database, 'withdrawal_messages')).toBe(2);
		expect(count(database, 'withdrawal_case_events')).toBe(2);
		expect(count(database, 'outbox_jobs')).toBe(2);
	});

	it('provides safe public lookup, encrypted loading, and PII-free newest-first listing', () => {
		const firstInput = submission();
		repository.createSubmission(firstInput);
		const secondAt = new Date(now.getTime() + 1_000);
		repository.createSubmission(
			submission({
				id: 'case_456',
				reference: 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
				scope: 'entire_order',
				encryptedPayload: encryptWithdrawalPayload(payload({ items: [] }), 'case_456', key),
				dedupeFingerprint: 'b'.repeat(64),
				createdAt: secondAt
			})
		);

		const safe = repository.getByReference('WDR-AAAAAAAAAAAAAAAAAAAAAA');
		const encrypted = repository.loadEncryptedByReference('WDR-AAAAAAAAAAAAAAAAAAAAAA');
		const listed = repository.list({ limit: 10 });
		expect(safe?.id).toBe('case_123');
		expect(JSON.stringify(safe)).not.toContain('encryptedPayload');
		expect(encrypted).toEqual({ ...safe, encryptedPayload: firstInput.encryptedPayload });
		expect(listed.map(({ reference }) => reference)).toEqual([
			'WDR-BBBBBBBBBBBBBBBBBBBBBB',
			'WDR-AAAAAAAAAAAAAAAAAAAAAA'
		]);
		expect(repository.list({ status: 'submitted', limit: 1 })).toHaveLength(1);
		expect(JSON.stringify(listed)).not.toMatch(
			/Private Test Name|Private\.Customer@example\.com|PRIVATE-ORDER-42|Private orange hoodie|ciphertext|dedupe/iu
		);
		expect(repository.getByReference('WDR-ZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull();
		expect(repository.loadEncryptedByReference('WDR-ZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull();
	});
});

describe('SqliteWithdrawalRepository message claims and settlement', () => {
	it('claims due messages in stable order, increments the attempt, and moves a five-minute lease', () => {
		repository.createSubmission(submission());

		const [claimed] = repository.claimDueMessages(now, 10);
		expect(claimed).toEqual({
			id: 1,
			caseId: 'case_123',
			kind: 'receipt',
			resendOfMessageId: null,
			idempotencyKey: 'withdrawal:receipt:case_123',
			attemptCount: 1,
			nextAttemptAt: new Date('2026-07-17T08:35:00.000Z'),
			providerDeliveryId: null,
			completedAt: null,
			lastErrorCode: null
		});
		expect(repository.claimDueMessages(now, 10)).toEqual([]);
		expect(repository.claimMessage(1, new Date('2026-07-17T08:34:59.999Z'))).toBeNull();
		expect(repository.claimMessage(1, new Date('2026-07-17T08:35:00.000Z'))?.attemptCount).toBe(2);
	});

	it('completes only the expected claimed attempt with a provider delivery ID', () => {
		repository.createSubmission(submission());
		const message = repository.claimMessage(1, now);
		expect(message?.attemptCount).toBe(1);
		expect(() =>
			repository.completeMessage(1, 2, 'provider_private', new Date('2026-07-17T08:31:00Z'))
		).toThrowError('WITHDRAWAL_MESSAGE_SETTLEMENT_CONFLICT');

		repository.completeMessage(1, 1, 'delivery_123', new Date('2026-07-17T08:31:00Z'));
		expect(
			database
				.prepare(
					`SELECT attempt_count, provider_delivery_id, completed_at, last_error_code
					 FROM withdrawal_messages WHERE id = 1`
				)
				.get()
		).toEqual({
			attempt_count: 1,
			provider_delivery_id: 'delivery_123',
			completed_at: '2026-07-17T08:31:00.000Z',
			last_error_code: null
		});
		expect(() =>
			repository.rescheduleMessage(1, 1, new Date('2026-07-17T08:40:00Z'), 'PLUNK_UNAVAILABLE')
		).toThrowError('WITHDRAWAL_MESSAGE_SETTLEMENT_CONFLICT');
	});

	it('reschedules transient failures and permanently completes rejection without a provider ID', () => {
		repository.createSubmission(submission());
		const transient = repository.claimMessage(1, now);
		repository.rescheduleMessage(
			1,
			transient!.attemptCount,
			new Date('2026-07-17T08:45:00Z'),
			'PLUNK_UNAVAILABLE'
		);
		expect(repository.claimDueMessages(new Date('2026-07-17T08:44:59Z'), 1)).toEqual([]);
		const retry = repository.claimMessage(1, new Date('2026-07-17T08:45:00Z'));
		repository.failMessagePermanently(
			1,
			retry!.attemptCount,
			'PLUNK_RECIPIENT_REJECTED',
			new Date('2026-07-17T08:46:00Z')
		);

		expect(
			database
				.prepare(
					`SELECT attempt_count, next_attempt_at, provider_delivery_id,
						completed_at, last_error_code FROM withdrawal_messages WHERE id = 1`
				)
				.get()
		).toEqual({
			attempt_count: 2,
			next_attempt_at: '2026-07-17T08:50:00.000Z',
			provider_delivery_id: null,
			completed_at: '2026-07-17T08:46:00.000Z',
			last_error_code: 'PLUNK_RECIPIENT_REJECTED'
		});
		expect(repository.claimDueMessages(new Date('2026-07-18T08:00:00Z'), 10)).toEqual([]);
	});

	it('rejects corrupt case, encrypted, and message rows instead of coercing them', () => {
		repository.createSubmission(submission());
		database.prepare('UPDATE withdrawal_cases SET revision = 1.5').run();
		expect(() => repository.getByReference('WDR-AAAAAAAAAAAAAAAAAAAAAA')).toThrowError(
			'WITHDRAWAL_CASE_ROW_INVALID'
		);
		database.prepare('UPDATE withdrawal_cases SET revision = 1').run();
		database.prepare("UPDATE withdrawal_cases SET encrypted_payload = 'not-a-blob'").run();
		expect(() => repository.loadEncryptedByReference('WDR-AAAAAAAAAAAAAAAAAAAAAA')).toThrowError(
			'WITHDRAWAL_CASE_ROW_INVALID'
		);
		database.prepare("UPDATE withdrawal_messages SET next_attempt_at = ''").run();
		expect(() => repository.claimDueMessages(now, 1)).toThrowError(
			'WITHDRAWAL_MESSAGE_ROW_INVALID'
		);
	});
});

describe('SqliteWithdrawalRepository concurrency and privacy', () => {
	it('deduplicates two barrier-synchronized service instances against one WAL database', async () => {
		closeDatabase();
		const directory = temporaryDirectory();
		const databasePath = join(directory, 'shop.sqlite');
		const setup = openIndependentDatabase(databasePath);
		migrate(setup, migrationsDirectory);
		setup.close();
		const repositoryUrl = pathToFileURL(
			fileURLToPath(new URL('./repository.server.ts', import.meta.url))
		).href;
		const databaseModuleUrl = import.meta.resolve('better-sqlite3');
		const scriptPath = join(directory, 'contender.ts');
		writeFileSync(
			scriptPath,
			`import Database from ${JSON.stringify(databaseModuleUrl)};
import { existsSync, writeFileSync } from 'node:fs';
import { SqliteWithdrawalRepository } from ${JSON.stringify(repositoryUrl)};
const [databasePath, id, reference, readyPath, startPath, resultPath] = process.argv.slice(2);
const database = new Database(databasePath);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.pragma('busy_timeout = 5000');
database.pragma('synchronous = FULL');
const repository = new SqliteWithdrawalRepository(database);
const input = {
  id,
  reference,
  scope: 'entire_order' as const,
  encryptedPayload: {
    schemaVersion: 1 as const,
    keyVersion: 1 as const,
    ciphertext: Buffer.from('Y2lwaGVydGV4dA==', 'base64'),
    nonce: Buffer.alloc(12),
    tag: Buffer.alloc(16)
  },
  dedupeFingerprint: 'c'.repeat(64),
  createdAt: new Date('2026-07-17T08:30:00.000Z')
};
writeFileSync(readyPath, 'ready', { flag: 'wx' });
while (!existsSync(startPath)) await new Promise((resolve) => setTimeout(resolve, 5));
const result = repository.createSubmission(input);
writeFileSync(resultPath, JSON.stringify({ created: result.created, reference: result.case.reference }));
database.close();
`
		);
		const startPath = join(directory, 'start');
		const paths = [0, 1].map((index) => ({
			ready: join(directory, `ready-${index}`),
			result: join(directory, `result-${index}.json`)
		}));
		const contenders = paths.map((pathsForContender, index) =>
			spawnContender(
				scriptPath,
				databasePath,
				`case_concurrent_${index}`,
				index === 0 ? 'WDR-AAAAAAAAAAAAAAAAAAAAAA' : 'WDR-BBBBBBBBBBBBBBBBBBBBBB',
				pathsForContender.ready,
				startPath,
				pathsForContender.result
			)
		);
		try {
			await waitForFiles(paths.map(({ ready }) => ready));
			writeFileSync(startPath, 'start', { flag: 'wx' });
			const results = await Promise.all(contenders.map(({ completion }) => completion));
			expect(results.map(({ created }) => created).sort()).toEqual([false, true]);
			expect(new Set(results.map(({ reference }) => reference)).size).toBe(1);
		} finally {
			for (const contender of contenders) contender.kill();
			await Promise.allSettled(contenders.map(({ completion }) => completion));
		}

		const inspection = openIndependentDatabase(databasePath);
		expect(count(inspection, 'withdrawal_cases')).toBe(1);
		expect(count(inspection, 'withdrawal_messages')).toBe(1);
		expect(count(inspection, 'withdrawal_case_events')).toBe(1);
		expect(
			(
				inspection
					.prepare(
						`SELECT COUNT(*) AS count FROM outbox_jobs
						 WHERE alert_code = 'WITHDRAWAL_NOTICE_RECEIVED'`
					)
					.get() as { count: number }
			).count
		).toBe(1);
		inspection.close();
	}, 20_000);

	it('stores none of the submitted plaintext in SQLite, WAL, or SHM bytes after checkpoint', () => {
		closeDatabase();
		const directory = temporaryDirectory();
		const databasePath = join(directory, 'shop.sqlite');
		const fileDatabase = openIndependentDatabase(databasePath);
		migrate(fileDatabase, migrationsDirectory);
		const fileRepository = new SqliteWithdrawalRepository(fileDatabase);
		const privatePayload = payload();
		fileRepository.createSubmission({
			...submission(),
			encryptedPayload: encryptWithdrawalPayload(privatePayload, 'case_123', key)
		});
		fileDatabase.pragma('wal_checkpoint(TRUNCATE)');

		const persisted = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
			.filter((path) => existsSync(path))
			.map((path) => readFileSync(path));
		for (const privateValue of [
			privatePayload.fullName,
			privatePayload.receiptEmail,
			privatePayload.enteredOrderReference,
			privatePayload.items[0].description
		]) {
			for (const bytes of persisted) {
				expect(bytes.includes(Buffer.from(privateValue, 'utf8')), privateValue).toBe(false);
			}
		}
		fileDatabase.close();
	});
});
