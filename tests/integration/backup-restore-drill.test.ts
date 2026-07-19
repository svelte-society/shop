import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import {
	copyFile,
	mkdir,
	readFile,
	rename as fsRename,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteBackupService } from '$lib/server/backups/service.server';
import type { BackupStore } from '$lib/server/backups/s3.server';
import { backupChecksum, encryptBackup } from '$lib/server/backups/format';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { checkRuntimeReadiness } from '$lib/server/health/readiness.server';
import { encryptWithdrawalPayload } from '$lib/server/withdrawals/crypto.server';
import { WithdrawalCaseReader } from '$lib/server/withdrawals/case-reader.server';
import { SqliteWithdrawalRepository } from '$lib/server/withdrawals/repository.server';
import {
	parseRestoreArguments,
	createRestoreStoreFromEnvironment,
	restoreBackup,
	runRestoreCommand
} from '../../scripts/restore-backup.mjs';
import { S3HttpsFixture } from '../fixtures/s3-https-server';

class FileObjectTransport implements BackupStore {
	constructor(private readonly root: string) {}

	private path(key: string): string {
		if (!key || key.startsWith('/') || key.split('/').includes('..')) {
			throw new Error('TEST_OBJECT_KEY_INVALID');
		}
		return join(this.root, ...key.split('/'));
	}

	async put(key: string, body: Uint8Array): Promise<void> {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, body, { mode: 0o600 });
	}

	async get(key: string): Promise<Uint8Array> {
		return readFile(this.path(key));
	}

	async list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>> {
		const keys: string[] = [];
		const walk = async (directory: string): Promise<void> => {
			const entries = await import('node:fs/promises').then(({ readdir }) =>
				readdir(directory, { withFileTypes: true })
			);
			for (const entry of entries) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) await walk(path);
				else
					keys.push(
						path
							.slice(this.root.length + 1)
							.split('/')
							.join('/')
					);
			}
		};
		await walk(this.root).catch(() => undefined);
		return Promise.all(
			keys
				.filter((key) => key.startsWith(prefix))
				.map(async (key) => ({ key, lastModified: (await stat(this.path(key))).mtime }))
		);
	}

	async delete(keys: string[]): Promise<void> {
		await Promise.all(keys.map((key) => rm(this.path(key), { force: true })));
	}
}

const migrationsDirectory = resolve('migrations');
const backupNow = new Date('2026-07-17T02:30:45.000Z');
const restoreNow = new Date('2026-07-17T04:05:06.000Z');
const encryptionKey = randomBytes(32).toString('base64');
const withdrawalDataKey = Buffer.alloc(32, 17);
const canonicalBackupKey = 'drill-bucket/2026/07/17/shop-20260717T023045Z.sqlite.ssbk';
const deletionBackupKey =
	'drill-bucket/2026/07/17/shop-20260717T023045Z-33333333-3333-4333-8333-333333333333.sqlite.ssbk';
let root: string;
let sourcePath: string;
let dataDirectory: string;
let databasePath: string;
let transport: FileObjectTransport;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'shop-restore-drill-'));
	sourcePath = join(root, 'source.sqlite');
	dataDirectory = join(root, 'data');
	databasePath = join(dataDirectory, 'shop.sqlite');
	rmSync(dataDirectory, { recursive: true, force: true });
	transport = new FileObjectTransport(join(root, 'objects'));
});

afterEach(() => {
	closeDatabase();
	rmSync(root, { recursive: true, force: true });
});

async function createEncryptedBackup(
	store: BackupStore = transport,
	prefix = 'drill-bucket'
): Promise<string> {
	await mkdir(join(root, 'objects'), { recursive: true });
	const source = openDatabase(sourcePath);
	migrate(source, migrationsDirectory);
	source.exec('CREATE TABLE restore_proof (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)');
	const insert = source.prepare('INSERT INTO restore_proof (marker) VALUES (?)');
	insert.run('first recovered row');
	insert.run('second recovered row');
	insert.run('third recovered row');
	const withdrawals = new SqliteWithdrawalRepository(source);
	withdrawals.createSubmission({
		id: 'restore_withdrawal_case',
		reference: 'WDR-RESTOREBACKUPDRILL1234',
		scope: 'specific_items',
		encryptedPayload: encryptWithdrawalPayload(
			{
				fullName: 'Private Restore Customer',
				receiptEmail: 'private.restore@example.com',
				enteredOrderReference: 'PRIVATE-RESTORE-ORDER',
				items: [{ description: 'Private restore hoodie', quantity: 1 }],
				reconciliation: null
			},
			'restore_withdrawal_case',
			withdrawalDataKey
		),
		dedupeFingerprint: 'b'.repeat(64),
		createdAt: backupNow
	});
	withdrawals.createSubmission({
		id: 'restore_purged_case',
		reference: 'WDR-PURGEDBACKUPDRILL12345',
		scope: 'entire_order',
		encryptedPayload: encryptWithdrawalPayload(
			{
				fullName: 'Private Purged Customer',
				receiptEmail: 'private.purged@example.com',
				enteredOrderReference: 'PRIVATE-PURGED-ORDER',
				items: [],
				reconciliation: null
			},
			'restore_purged_case',
			withdrawalDataKey
		),
		dedupeFingerprint: 'c'.repeat(64),
		createdAt: backupNow
	});
	source
		.prepare(
			`UPDATE withdrawal_cases SET status = 'closed', eligibility = 'eligible_eu',
			 outcome_code = 'WITHDRAWAL_COMPLETED', closed_at = ?, pii_purge_due_at = ?
			 WHERE id = 'restore_purged_case'`
		)
		.run(backupNow.toISOString(), backupNow.toISOString());
	expect(withdrawals.purgeDue(backupNow, 100)).toBe(1);
	const service = new SqliteBackupService({
		database: source,
		store,
		encryptionKeyBase64: encryptionKey,
		prefix,
		temporaryDirectory: join(root, 'backup-temp')
	});
	const result = await service.run(backupNow);
	closeDatabase();
	return result.objectKey;
}

function createCurrentDatabase(): void {
	rmSync(dataDirectory, { recursive: true, force: true });
	mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
	const current = openDatabase(databasePath);
	migrate(current, migrationsDirectory);
	current.exec('CREATE TABLE current_only (marker TEXT NOT NULL)');
	current.prepare('INSERT INTO current_only (marker) VALUES (?)').run('pre-restore current row');
	closeDatabase();
}

function preRestoreArtifacts(): string[] {
	return readdirSync(dataDirectory)
		.filter((name) => name.startsWith('shop.pre-restore.'))
		.sort();
}

function expectPriorDatabase(path: string): void {
	const prior = new Database(path, { readonly: true, fileMustExist: true });
	try {
		expect(prior.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
		expect(prior.prepare('SELECT marker FROM current_only').get()).toEqual({
			marker: 'pre-restore current row'
		});
		expect(
			prior
				.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'restore_proof'")
				.get()
		).toEqual({ count: 0 });
	} finally {
		prior.close();
	}
}

function expectRestoredDatabase(path: string): void {
	const restored = new Database(path, { readonly: true, fileMustExist: true });
	try {
		expect(restored.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
		expect(restored.prepare('SELECT COUNT(*) AS count FROM restore_proof').get()).toEqual({
			count: 3
		});
		expect(restored.prepare('SELECT COUNT(*) AS count FROM withdrawal_cases').get()).toEqual({
			count: 2
		});
		const serializedWithdrawal = JSON.stringify(
			restored
				.prepare(
					`SELECT public_reference, schema_version, encryption_key_version,
					 hex(encrypted_payload) AS encrypted_payload FROM withdrawal_cases`
				)
				.get()
		);
		expect(serializedWithdrawal).not.toContain('Private Restore Customer');
		expect(serializedWithdrawal).not.toContain(withdrawalDataKey.toString('base64'));
		expect(
			restored
				.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'current_only'")
				.get()
		).toEqual({ count: 0 });
	} finally {
		restored.close();
	}
}

async function backupCurrentWithActiveSidecars(source: string, destination: string): Promise<void> {
	const current = new Database(source, { fileMustExist: true });
	try {
		await current.backup(destination);
	} finally {
		current.close();
	}
	await Promise.all([
		writeFile(`${source}-wal`, new Uint8Array(), { mode: 0o600 }),
		writeFile(`${source}-shm`, new Uint8Array(), { mode: 0o600 })
	]);
}

async function createCrashLeftWalDatabase(): Promise<void> {
	rmSync(dataDirectory, { recursive: true, force: true });
	mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
	const base = openDatabase(databasePath);
	migrate(base, migrationsDirectory);
	closeDatabase();
	const childCode = `
		import Database from 'better-sqlite3';
		const database = new Database(${JSON.stringify(databasePath)}, { fileMustExist: true });
		database.pragma('journal_mode = WAL');
		database.pragma('wal_autocheckpoint = 0');
		database.pragma('synchronous = FULL');
		database.exec('CREATE TABLE current_only (marker TEXT NOT NULL)');
		database.prepare('INSERT INTO current_only (marker) VALUES (?)').run('committed crash-left WAL row');
		process.stdout.write('WAL_COMMITTED\\n');
		setInterval(() => undefined, 1_000);
	`;
	const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
		cwd: resolve('.'),
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	await new Promise<void>((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`TEST_WAL_CHILD_TIMEOUT:${stderr}`));
		}, 5_000);
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
			if (!stdout.includes('WAL_COMMITTED')) return;
			clearTimeout(timer);
			resolvePromise();
		});
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
	child.kill('SIGKILL');
	await once(child, 'exit');
	if (!existsSync(`${databasePath}-wal`)) throw new Error('TEST_WAL_NOT_LEFT_BEHIND');
}

describe('offline restore command safety', () => {
	it('requires the object key and both destructive confirmations', () => {
		expect(() => parseRestoreArguments([])).toThrowError(/^RESTORE_ARGUMENTS_INVALID$/);
		expect(() => parseRestoreArguments(['--key', canonicalBackupKey])).toThrowError(
			/^RESTORE_CONFIRMATION_REQUIRED$/
		);
		expect(() =>
			parseRestoreArguments(['--key', canonicalBackupKey, '--confirm-app-stopped'])
		).toThrowError(/^RESTORE_CONFIRMATION_REQUIRED$/);
		expect(
			parseRestoreArguments([
				'--key',
				canonicalBackupKey,
				'--confirm-app-stopped',
				'--confirm-replace'
			])
		).toEqual({ key: canonicalBackupKey });
	});

	it('accepts deletion backup keys with an immutable UUID suffix', () => {
		expect(
			parseRestoreArguments([
				'--key',
				deletionBackupKey,
				'--confirm-app-stopped',
				'--confirm-replace'
			])
		).toEqual({ key: deletionBackupKey });
	});

	it.each([
		'drill-bucket/object.ssbk',
		`${canonicalBackupKey}.sha256`,
		'drill-bucket/2026/07/18/shop-20260717T023045Z.sqlite.ssbk',
		'drill-bucket/2026/02/29/shop-20260229T023045Z.sqlite.ssbk',
		'drill-bucket/2026/07/17/shop-20260717T253045Z.sqlite.ssbk',
		'drill-\u0001bucket/2026/07/17/shop-20260717T023045Z.sqlite.ssbk',
		`${'é'.repeat(500)}/2026/07/17/shop-20260717T023045Z.sqlite.ssbk`
	])('rejects non-canonical or oversized object key %j', (key) => {
		expect(() =>
			parseRestoreArguments(['--key', key, '--confirm-app-stopped', '--confirm-replace'])
		).toThrowError(/^RESTORE_ARGUMENTS_INVALID$/);
	});

	it('does not construct storage or emit private details when confirmation is missing', async () => {
		const createStore = vi.fn();
		const output = { log: vi.fn(), error: vi.fn() };

		await expect(
			runRestoreCommand({
				args: ['--key', canonicalBackupKey],
				environment: {
					S3_SECRET_ACCESS_KEY: 'private-secret',
					BACKUP_ENCRYPTION_KEY_BASE64: encryptionKey
				},
				output,
				createStore
			})
		).resolves.toBe(1);

		expect(createStore).not.toHaveBeenCalled();
		expect(output.log).not.toHaveBeenCalled();
		expect(JSON.stringify(output.error.mock.calls)).toBe(
			'[["{\\"event\\":\\"restore_failed\\",\\"error_code\\":\\"RESTORE_CONFIRMATION_REQUIRED\\"}"]]'
		);
		expect(JSON.stringify(output.error.mock.calls)).not.toContain('private-secret');
		expect(JSON.stringify(output.error.mock.calls)).not.toContain(canonicalBackupKey);
	});

	it('rejects a non-HTTPS restore endpoint before credentials can be used', () => {
		expect(() =>
			createRestoreStoreFromEnvironment({
				S3_ENDPOINT: 'http://s3.restore.test',
				S3_BUCKET: 'restore-backups',
				S3_REGION: 'eu-north-1',
				S3_ACCESS_KEY_ID: 'restore-access',
				S3_SECRET_ACCESS_KEY: 'private-restore-secret',
				S3_FORCE_PATH_STYLE: 'true'
			})
		).toThrowError(/^RESTORE_CONFIG_INVALID$/);
	});

	it('fails closed on checksum mismatch, preserves the current DB, and removes restore temp files', async () => {
		const key = await createEncryptedBackup();
		await transport.put(`${key}.sha256`, Buffer.from(`${'0'.repeat(64)}\n`));
		createCurrentDatabase();
		const before = readFileSync(databasePath);

		await expect(
			restoreBackup({
				key,
				encryptionKeyBase64: encryptionKey,
				dataDirectory,
				store: transport,
				now: () => restoreNow
			})
		).rejects.toThrowError(/^RESTORE_CHECKSUM_MISMATCH$/);

		expect(readFileSync(databasePath)).toEqual(before);
		expect(existsSync(join(dataDirectory, 'shop.restore.tmp'))).toBe(false);
		expect(existsSync(join(dataDirectory, 'shop.restore.tmp-wal'))).toBe(false);
		expect(existsSync(join(dataDirectory, 'shop.restore.tmp-shm'))).toBe(false);
		expect(existsSync(join(dataDirectory, 'shop.pre-restore.20260717T040506Z.sqlite'))).toBe(false);
	});

	it('fails closed on a modified encrypted object without replacing the current DB', async () => {
		const key = await createEncryptedBackup();
		const encrypted = Buffer.from(await transport.get(key));
		encrypted[33] ^= 0xff;
		await transport.put(key, encrypted);
		const { createHash } = await import('node:crypto');
		await transport.put(
			`${key}.sha256`,
			Buffer.from(`${createHash('sha256').update(encrypted).digest('hex')}\n`)
		);
		createCurrentDatabase();
		const before = readFileSync(databasePath);

		await expect(
			restoreBackup({
				key,
				encryptionKeyBase64: encryptionKey,
				dataDirectory,
				store: transport,
				now: () => restoreNow
			})
		).rejects.toThrowError(/^RESTORE_DECRYPT_FAILED$/);
		expect(readFileSync(databasePath)).toEqual(before);
		expect(existsSync(join(dataDirectory, 'shop.restore.tmp'))).toBe(false);
	});

	it('rejects authenticated non-SQLite plaintext at quick_check before copying or replacement', async () => {
		const key = 'drill-bucket/2026/07/17/shop-20260717T023045Z.sqlite.ssbk';
		const encrypted = encryptBackup(Buffer.from('authenticated but corrupt SQLite'), encryptionKey);
		await mkdir(join(root, 'objects'), { recursive: true });
		await transport.put(key, encrypted);
		await transport.put(`${key}.sha256`, Buffer.from(`${backupChecksum(encrypted)}\n`));
		createCurrentDatabase();
		const before = readFileSync(databasePath);

		await expect(
			restoreBackup({
				key,
				encryptionKeyBase64: encryptionKey,
				dataDirectory,
				store: transport,
				now: () => restoreNow
			})
		).rejects.toThrowError(/^RESTORE_INTEGRITY_FAILED$/);
		expect(readFileSync(databasePath)).toEqual(before);
		expect(existsSync(join(dataDirectory, 'shop.restore.tmp'))).toBe(false);
		expect(existsSync(join(dataDirectory, 'shop.pre-restore.20260717T040506Z.sqlite'))).toBe(false);
	});

	it('attempts every restore-temp cleanup and fails closed when mandatory removal fails', async () => {
		const key = await createEncryptedBackup();
		createCurrentDatabase();
		const before = readFileSync(databasePath);
		await writeFile(join(dataDirectory, 'shop.restore.tmp'), Buffer.from('stale plaintext temp'), {
			mode: 0o600
		});
		const attempted = new Set<string>();
		const removeFile = async (path: string, options?: { force?: boolean }): Promise<void> => {
			attempted.add(path);
			if (path === join(dataDirectory, 'shop.restore.tmp')) {
				throw new Error('private restore cleanup detail');
			}
			await rm(path, options);
		};

		await expect(
			restoreBackup({
				key,
				encryptionKeyBase64: encryptionKey,
				dataDirectory,
				store: transport,
				now: () => restoreNow,
				removeFile
			} as Parameters<typeof restoreBackup>[0])
		).rejects.toThrowError(/^RESTORE_CLEANUP_FAILED$/);
		expect(attempted).toEqual(
			new Set([
				join(dataDirectory, 'shop.restore.tmp'),
				join(dataDirectory, 'shop.restore.tmp-wal'),
				join(dataDirectory, 'shop.restore.tmp-shm')
			])
		);
		expect(readFileSync(databasePath)).toEqual(before);
	}, 10_000);

	it('does not publish a canonical rollback artifact when the current database is corrupt', async () => {
		const key = await createEncryptedBackup();
		createCurrentDatabase();
		await writeFile(databasePath, Buffer.from('corrupt current SQLite'), { mode: 0o600 });

		await expect(
			restoreBackup({
				key,
				encryptionKeyBase64: encryptionKey,
				dataDirectory,
				store: transport,
				now: () => restoreNow
			})
		).rejects.toThrowError(/^RESTORE_FAILED$/);

		expect(preRestoreArtifacts()).toEqual([]);
		expect(readFileSync(databasePath)).toEqual(Buffer.from('corrupt current SQLite'));
	});

	it('cleans noncanonical rollback temps when current-database backup fails', async () => {
		const key = await createEncryptedBackup();
		createCurrentDatabase();

		await expect(
			restoreBackup({
				key,
				encryptionKeyBase64: encryptionKey,
				dataDirectory,
				store: transport,
				now: () => restoreNow,
				backupCurrent: async () => {
					throw new Error('private current-backup detail');
				}
			} as Parameters<typeof restoreBackup>[0])
		).rejects.toThrowError(/^RESTORE_FAILED$/);

		expect(preRestoreArtifacts()).toEqual([]);
		expectPriorDatabase(databasePath);
	});

	it('cleans noncanonical rollback temps when copied-current verification fails', async () => {
		const key = await createEncryptedBackup();
		createCurrentDatabase();

		await expect(
			restoreBackup({
				key,
				encryptionKeyBase64: encryptionKey,
				dataDirectory,
				store: transport,
				now: () => restoreNow,
				backupCurrent: async (_source: string, destination: string) => {
					await writeFile(destination, Buffer.from('corrupt copied current'), { mode: 0o600 });
				}
			} as Parameters<typeof restoreBackup>[0])
		).rejects.toThrowError(/^RESTORE_INTEGRITY_FAILED$/);

		expect(preRestoreArtifacts()).toEqual([]);
		expectPriorDatabase(databasePath);
	});

	it.each(['file', 'publication-directory'] as const)(
		'removes every rollback candidate when %s synchronization fails',
		async (failurePoint) => {
			const key = await createEncryptedBackup();
			createCurrentDatabase();

			await expect(
				restoreBackup({
					key,
					encryptionKeyBase64: encryptionKey,
					dataDirectory,
					store: transport,
					now: () => restoreNow,
					syncFile:
						failurePoint === 'file'
							? async () => {
									throw new Error('private file-sync detail');
								}
							: undefined,
					syncDirectory:
						failurePoint === 'publication-directory'
							? async () => {
									throw new Error('private directory-sync detail');
								}
							: undefined
				} as Parameters<typeof restoreBackup>[0])
			).rejects.toThrowError(/^RESTORE_FAILED$/);

			expect(preRestoreArtifacts()).toEqual([]);
			expectPriorDatabase(databasePath);
		}
	);
});

describe('production-shaped backup and restore drill', () => {
	it('restores real rows, preserves the prior DB, migrates, passes quick_check, and becomes ready', async () => {
		const key = await createEncryptedBackup();
		const backupObject = Buffer.from(await transport.get(key));
		const sourceBytes = readFileSync(sourcePath);
		for (const keyMaterial of [
			withdrawalDataKey,
			Buffer.from(withdrawalDataKey.toString('base64'), 'utf8'),
			Buffer.from(encryptionKey, 'base64'),
			Buffer.from(encryptionKey, 'utf8')
		]) {
			expect(backupObject.includes(keyMaterial)).toBe(false);
			expect(sourceBytes.includes(keyMaterial)).toBe(false);
		}
		createCurrentDatabase();

		const restored = await restoreBackup({
			key,
			encryptionKeyBase64: encryptionKey,
			dataDirectory,
			store: transport,
			now: () => restoreNow
		});

		expect(restored).toEqual({
			databasePath,
			preRestorePath: join(dataDirectory, 'shop.pre-restore.20260717T040506Z.sqlite')
		});
		const previous = new Database(restored.preRestorePath, {
			readonly: true,
			fileMustExist: true
		});
		try {
			expect(previous.prepare('SELECT marker FROM current_only').get()).toEqual({
				marker: 'pre-restore current row'
			});
		} finally {
			previous.close();
		}

		const database = openDatabase(databasePath, { fileMustExist: true });
		migrate(database, migrationsDirectory);
		expect(database.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
		expect(database.prepare('SELECT COUNT(*) AS count FROM restore_proof').get()).toEqual({
			count: 3
		});
		expect(database.prepare('SELECT COUNT(*) AS count FROM withdrawal_cases').get()).toEqual({
			count: 2
		});
		const repository = new SqliteWithdrawalRepository(database);
		const alerts = { enqueueAlert: vi.fn() };
		const reader = new WithdrawalCaseReader({ repository, dataKey: withdrawalDataKey, alerts });
		expect(reader.inspectActive('WDR-RESTOREBACKUPDRILL1234', restoreNow).payload).toMatchObject({
			fullName: 'Private Restore Customer',
			receiptEmail: 'private.restore@example.com'
		});
		const wrongKeyReader = new WithdrawalCaseReader({
			repository,
			dataKey: Buffer.alloc(32, 18),
			alerts
		});
		expect(() =>
			wrongKeyReader.inspectActive('WDR-RESTOREBACKUPDRILL1234', restoreNow)
		).toThrowError('WITHDRAWAL_DECRYPT_FAILED');
		expect(() => reader.inspectActive('WDR-PURGEDBACKUPDRILL12345', restoreNow)).toThrowError(
			'WITHDRAWAL_CASE_NOT_FOUND'
		);
		expect(repository.loadEncryptedByReference('WDR-PURGEDBACKUPDRILL12345')).toBeNull();
		expect(database.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({
			count: 5
		});

		const readiness = await checkRuntimeReadiness({
			database,
			scheduler: null,
			databasePath,
			migrationsDirectory,
			environment: {
				STOREFRONT_ENABLED: 'false',
				CHECKOUT_ENABLED: 'false',
				MCP_ENABLED: 'false',
				SCHEDULER_ENABLED: 'false',
				DATABASE_BOOTSTRAP: 'false',
				PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
				SUPPORT_EMAIL: 'merch@sveltesociety.dev',
				STRIPE_WEBHOOK_SECRET: 'whsec_restore_drill',
				STYRIA_SUPPORTED_COUNTRIES: 'SE,JP,TW',
				DATABASE_PATH: databasePath
			}
		});
		expect(readiness.ready).toBe(true);
		expect(readiness.checks).toEqual({
			configuration: 'ok',
			database: 'ok',
			migrations: 'ok',
			volume: 'ok',
			disk: 'ok'
		});
		expect(existsSync(join(dataDirectory, 'shop.restore.tmp'))).toBe(false);
		expect(existsSync(join(dataDirectory, 'shop.restore.tmp-wal'))).toBe(false);
		expect(existsSync(join(dataDirectory, 'shop.restore.tmp-shm'))).toBe(false);
	});

	it('materializes crash-left WAL state, removes stale sidecars, and restarts with restored rows', async () => {
		const key = await createEncryptedBackup();
		await createCrashLeftWalDatabase();
		const detachedMain = join(root, 'detached-current-main.sqlite');
		await copyFile(databasePath, detachedMain);
		const mainWithoutWal = new Database(detachedMain, { readonly: true, fileMustExist: true });
		try {
			expect(
				mainWithoutWal
					.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'current_only'")
					.get()
			).toEqual({ count: 0 });
		} finally {
			mainWithoutWal.close();
		}

		const restored = await restoreBackup({
			key,
			encryptionKeyBase64: encryptionKey,
			dataDirectory,
			store: transport,
			now: () => restoreNow
		});

		const previous = new Database(restored.preRestorePath, {
			readonly: true,
			fileMustExist: true
		});
		try {
			expect(previous.prepare('SELECT marker FROM current_only').get()).toEqual({
				marker: 'committed crash-left WAL row'
			});
			expect(previous.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
		} finally {
			previous.close();
		}
		expect(existsSync(`${databasePath}-wal`)).toBe(false);
		expect(existsSync(`${databasePath}-shm`)).toBe(false);

		let restarted = new Database(databasePath, { fileMustExist: true });
		try {
			expect(restarted.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
			expect(restarted.prepare('SELECT COUNT(*) AS count FROM restore_proof').get()).toEqual({
				count: 3
			});
			expect(
				restarted
					.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'current_only'")
					.get()
			).toEqual({ count: 0 });
		} finally {
			restarted.close();
		}
		restarted = new Database(databasePath, { readonly: true, fileMustExist: true });
		try {
			expect(restarted.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
		} finally {
			restarted.close();
		}
	});

	it('syncs each materialized file and commit directory before returning success', async () => {
		const key = await createEncryptedBackup();
		createCurrentDatabase();
		const syncedFiles: string[] = [];
		const syncedDirectories: string[] = [];

		await restoreBackup({
			key,
			encryptionKeyBase64: encryptionKey,
			dataDirectory,
			store: transport,
			now: () => restoreNow,
			syncFile: async (path: string) => {
				syncedFiles.push(path);
			},
			syncDirectory: async (path: string) => {
				syncedDirectories.push(path);
			}
		} as Parameters<typeof restoreBackup>[0]);

		expect(
			syncedFiles.some((path) =>
				path.includes('shop.pre-restore.20260717T040506Z.sqlite.building-')
			)
		).toBe(true);
		expect(syncedFiles.some((path) => path.includes('shop.prior-install.'))).toBe(true);
		expect(syncedDirectories).toEqual([dataDirectory, dataDirectory, dataDirectory]);
	});

	it('rolls back sidecar quarantine failure and leaves the prior logical database installed', async () => {
		const key = await createEncryptedBackup();
		createCurrentDatabase();
		const canonical = join(dataDirectory, 'shop.pre-restore.20260717T040506Z.sqlite');
		const renameFile = async (source: string, destination: string): Promise<void> => {
			if (source === `${databasePath}-shm` && destination.includes('.restore-quarantine-')) {
				throw new Error('private quarantine detail');
			}
			await fsRename(source, destination);
		};

		await expect(
			restoreBackup({
				key,
				encryptionKeyBase64: encryptionKey,
				dataDirectory,
				store: transport,
				now: () => restoreNow,
				backupCurrent: backupCurrentWithActiveSidecars,
				renameFile
			} as Parameters<typeof restoreBackup>[0])
		).rejects.toThrowError(/^RESTORE_FAILED$/);

		expect(existsSync(`${databasePath}-wal`)).toBe(true);
		expect(existsSync(`${databasePath}-shm`)).toBe(true);
		expectPriorDatabase(databasePath);
		expectPriorDatabase(canonical);
	});

	it('keeps the standalone prior database and canonical copy when quarantine removal fails', async () => {
		const key = await createEncryptedBackup();
		createCurrentDatabase();
		const canonical = join(dataDirectory, 'shop.pre-restore.20260717T040506Z.sqlite');
		const removeFile = async (path: string, options?: { force?: boolean }): Promise<void> => {
			if (path.includes('.restore-quarantine-')) {
				throw new Error('private quarantine-removal detail');
			}
			await rm(path, options);
		};

		await expect(
			restoreBackup({
				key,
				encryptionKeyBase64: encryptionKey,
				dataDirectory,
				store: transport,
				now: () => restoreNow,
				backupCurrent: backupCurrentWithActiveSidecars,
				removeFile
			} as Parameters<typeof restoreBackup>[0])
		).rejects.toThrowError(/^RESTORE_CLEANUP_FAILED$/);

		expectPriorDatabase(databasePath);
		expectPriorDatabase(canonical);
		expect(
			readdirSync(dataDirectory).filter((name) => name.includes('.restore-quarantine-'))
		).toHaveLength(2);
	});

	it('leaves the prior database installed when the final restore rename fails', async () => {
		const key = await createEncryptedBackup();
		createCurrentDatabase();
		const canonical = join(dataDirectory, 'shop.pre-restore.20260717T040506Z.sqlite');
		const renameFile = async (source: string, destination: string): Promise<void> => {
			if (source === join(dataDirectory, 'shop.restore.tmp')) {
				throw new Error('private restore-rename detail');
			}
			await fsRename(source, destination);
		};

		await expect(
			restoreBackup({
				key,
				encryptionKeyBase64: encryptionKey,
				dataDirectory,
				store: transport,
				now: () => restoreNow,
				renameFile
			} as Parameters<typeof restoreBackup>[0])
		).rejects.toThrowError(/^RESTORE_FAILED$/);

		expectPriorDatabase(databasePath);
		expectPriorDatabase(canonical);
		expect(existsSync(join(dataDirectory, 'shop.restore.tmp'))).toBe(false);
	});

	it('returns RESTORE_STATE_UNCERTAIN and retains both exact states after post-rename sync failure', async () => {
		const key = await createEncryptedBackup();
		createCurrentDatabase();
		const canonical = join(dataDirectory, 'shop.pre-restore.20260717T040506Z.sqlite');
		let directorySyncs = 0;

		await expect(
			restoreBackup({
				key,
				encryptionKeyBase64: encryptionKey,
				dataDirectory,
				store: transport,
				now: () => restoreNow,
				syncDirectory: async () => {
					directorySyncs += 1;
					if (directorySyncs === 3) throw new Error('private post-rename sync detail');
				}
			} as Parameters<typeof restoreBackup>[0])
		).rejects.toThrowError(/^RESTORE_STATE_UNCERTAIN$/);

		expect(directorySyncs).toBe(3);
		expectRestoredDatabase(databasePath);
		expectPriorDatabase(canonical);
		expect(existsSync(join(dataDirectory, 'shop.restore.tmp'))).toBe(false);
	});
});

describe('real S3-compatible HTTPS production path', () => {
	it('backs up and restores through real signed S3Client PUT, GET, paginated LIST, and pair DELETE requests', async () => {
		const fixture = await S3HttpsFixture.start();
		const bucket = 'restore-backups';
		const prefix = 'drill-bucket';
		const oldBase = `${prefix}/2026/06/01/shop-20260601T000000Z.sqlite.ssbk`;
		fixture.seed(bucket, oldBase, Buffer.from('old encrypted object'), new Date('2026-06-01'));
		fixture.seed(
			bucket,
			`${oldBase}.sha256`,
			Buffer.from(`${'0'.repeat(64)}\n`),
			new Date('2026-06-01')
		);
		try {
			const childEnvironment = { ...process.env };
			delete childEnvironment.NODE_TLS_REJECT_UNAUTHORIZED;
			Object.assign(childEnvironment, {
				NODE_EXTRA_CA_CERTS: resolve('tests/fixtures/provider-cert.pem'),
				REAL_S3_DRILL_ROOT: root,
				REAL_S3_ENDPOINT: fixture.endpoint,
				REAL_S3_ENCRYPTION_KEY: encryptionKey,
				FORCE_COLOR: '0'
			});
			const child = spawn(
				'pnpm',
				[
					'exec',
					'vitest',
					'run',
					'--config',
					'tests/fixtures/real-s3-drill-child.vitest.config.ts'
				],
				{
					cwd: resolve('.'),
					env: childEnvironment,
					stdio: ['ignore', 'pipe', 'pipe']
				}
			);
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on('data', (chunk: string) => {
				stderr += chunk;
			});
			const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
				const timer = setTimeout(() => {
					child.kill('SIGKILL');
					reject(new Error('TEST_REAL_S3_CHILD_TIMEOUT'));
				}, 10_000);
				child.once('error', (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.once('exit', (code) => {
					clearTimeout(timer);
					resolvePromise(code);
				});
			});
			expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
			expect(`${stdout}\n${stderr}`).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');

			const key = canonicalBackupKey;
			const encrypted = fixture.object(bucket, key);
			const companion = fixture.object(bucket, `${key}.sha256`);
			expect(encrypted?.contentType).toBe('application/octet-stream');
			expect(companion?.contentType).toBe('text/plain; charset=utf-8');
			expect(Buffer.from(companion?.body ?? []).toString('ascii')).toBe(
				`${backupChecksum(encrypted?.body ?? new Uint8Array())}\n`
			);
			expect(fixture.object(bucket, oldBase)).toBeUndefined();
			expect(fixture.object(bucket, `${oldBase}.sha256`)).toBeUndefined();

			const puts = fixture.requests.filter((request) => request.method === 'PUT');
			const gets = fixture.requests.filter((request) => request.method === 'GET');
			const lists = fixture.requests.filter((request) => request.method === 'LIST');
			const deletes = fixture.requests.filter((request) => request.method === 'DELETE');
			expect(puts.map((request) => request.key)).toEqual([key, `${key}.sha256`]);
			expect(gets.map((request) => request.key).sort()).toEqual([key, `${key}.sha256`].sort());
			expect(lists.some((request) => request.continuationToken !== undefined)).toBe(true);
			expect(deletes).toHaveLength(1);
			expect(deletes[0]?.deletedKeys?.sort()).toEqual([oldBase, `${oldBase}.sha256`].sort());
			for (const request of fixture.requests) {
				expect(request.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
			}
		} finally {
			await fixture.close();
		}
		expect(fixture.listening).toBe(false);
	}, 15_000);
});
