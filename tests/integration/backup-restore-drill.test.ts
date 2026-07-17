import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteBackupService } from '$lib/server/backups/service.server';
import type { BackupStore } from '$lib/server/backups/s3.server';
import { backupChecksum, encryptBackup } from '$lib/server/backups/format';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { checkRuntimeReadiness } from '$lib/server/health/readiness.server';
import {
	parseRestoreArguments,
	createRestoreStoreFromEnvironment,
	restoreBackup,
	runRestoreCommand
} from '../../scripts/restore-backup.mjs';

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

async function createEncryptedBackup(): Promise<string> {
	await mkdir(join(root, 'objects'), { recursive: true });
	const source = openDatabase(sourcePath);
	migrate(source, migrationsDirectory);
	source.exec('CREATE TABLE restore_proof (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)');
	const insert = source.prepare('INSERT INTO restore_proof (marker) VALUES (?)');
	insert.run('first recovered row');
	insert.run('second recovered row');
	insert.run('third recovered row');
	const service = new SqliteBackupService({
		database: source,
		store: transport,
		encryptionKeyBase64: encryptionKey,
		prefix: 'drill-bucket',
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

describe('offline restore command safety', () => {
	it('requires the object key and both destructive confirmations', () => {
		expect(() => parseRestoreArguments([])).toThrowError(/^RESTORE_ARGUMENTS_INVALID$/);
		expect(() => parseRestoreArguments(['--key', 'bucket/object.ssbk'])).toThrowError(
			/^RESTORE_CONFIRMATION_REQUIRED$/
		);
		expect(() =>
			parseRestoreArguments(['--key', 'bucket/object.ssbk', '--confirm-app-stopped'])
		).toThrowError(/^RESTORE_CONFIRMATION_REQUIRED$/);
		expect(
			parseRestoreArguments([
				'--key',
				'bucket/object.ssbk',
				'--confirm-app-stopped',
				'--confirm-replace'
			])
		).toEqual({ key: 'bucket/object.ssbk' });
	});

	it('does not construct storage or emit private details when confirmation is missing', async () => {
		const createStore = vi.fn();
		const output = { log: vi.fn(), error: vi.fn() };

		await expect(
			runRestoreCommand({
				args: ['--key', 'private/object-key.ssbk'],
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
		expect(JSON.stringify(output.error.mock.calls)).not.toContain('private/object-key');
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
});

describe('production-shaped backup and restore drill', () => {
	it('restores real rows, preserves the prior DB, migrates, passes quick_check, and becomes ready', async () => {
		const key = await createEncryptedBackup();
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
		expect(database.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({
			count: 3
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
});
