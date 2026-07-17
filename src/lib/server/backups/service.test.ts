import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { backupChecksum, decryptBackup, verifyBackupChecksum } from './format';
import type { BackupStore } from './s3.server';
import { SqliteBackupService } from './service.server';

type StoredObject = {
	body: Uint8Array;
	contentType: string;
	lastModified: Date;
};

class MemoryBackupStore implements BackupStore {
	readonly objects = new Map<string, StoredObject>();
	readonly events: string[] = [];
	failPutNumber: number | undefined;
	failDelete = false;
	omitFromFirstList: string | undefined;
	onPut: (() => void) | undefined;
	private putCount = 0;
	private listCount = 0;

	async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
		this.putCount += 1;
		this.events.push(`put:${key}`);
		this.onPut?.();
		if (this.failPutNumber === this.putCount) throw new Error('private upload detail');
		this.objects.set(key, {
			body: Uint8Array.from(body),
			contentType,
			lastModified: new Date('2026-07-17T02:30:00.000Z')
		});
	}

	async get(key: string): Promise<Uint8Array> {
		const object = this.objects.get(key);
		if (!object) throw new Error('missing');
		return Uint8Array.from(object.body);
	}

	async list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>> {
		this.listCount += 1;
		this.events.push(`list:${prefix}`);
		return [...this.objects.entries()]
			.filter(
				([key]) =>
					key.startsWith(prefix) && !(this.listCount === 1 && key === this.omitFromFirstList)
			)
			.map(([key, object]) => ({ key, lastModified: object.lastModified }));
	}

	async delete(keys: string[]): Promise<void> {
		this.events.push(`delete:${keys.join(',')}`);
		if (this.failDelete) throw new Error('private delete detail');
		for (const key of keys) this.objects.delete(key);
	}
}

const now = new Date('2026-07-17T02:30:45.000Z');
const encryptionKey = randomBytes(32).toString('base64');
let directory: string;
let database: ShopDatabase;
let store: MemoryBackupStore;

function service(key = encryptionKey): SqliteBackupService {
	return new SqliteBackupService({
		database,
		store,
		encryptionKeyBase64: key,
		prefix: 'shop-backups',
		temporaryDirectory: directory
	});
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'shop-backup-service-'));
	database = openDatabase(join(directory, 'source.sqlite'));
	database.exec('CREATE TABLE proof (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)');
	database.prepare('INSERT INTO proof (marker) VALUES (?)').run('private database row');
	store = new MemoryBackupStore();
});

afterEach(() => {
	closeDatabase();
	rmSync(directory, { recursive: true, force: true });
});

describe('SqliteBackupService', () => {
	it('backs up real SQLite, verifies it, encrypts it, uploads companions, and leaves no temp files', async () => {
		const result = await service().run(now);

		expect(result).toEqual({
			objectKey: 'shop-backups/2026/07/17/shop-20260717T023045Z.sqlite.ssbk',
			checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
			deleted: 0
		});
		const encrypted = store.objects.get(result.objectKey);
		const companion = store.objects.get(`${result.objectKey}.sha256`);
		expect(encrypted?.contentType).toBe('application/octet-stream');
		expect(companion?.contentType).toBe('text/plain; charset=utf-8');
		expect(Buffer.from(companion?.body ?? []).toString('ascii')).toBe(`${result.checksum}\n`);
		verifyBackupChecksum(encrypted?.body ?? new Uint8Array(), `${result.checksum}\n`);
		expect(backupChecksum(encrypted?.body ?? new Uint8Array())).toBe(result.checksum);

		const restoredPath = join(directory, 'independent-restore.sqlite');
		writeFileSync(restoredPath, decryptBackup(encrypted?.body ?? new Uint8Array(), encryptionKey), {
			mode: 0o600
		});
		const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
		try {
			expect(restored.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
			expect(restored.prepare('SELECT marker FROM proof').get()).toEqual({
				marker: 'private database row'
			});
		} finally {
			restored.close();
		}
		rmSync(`${restoredPath}-shm`, { force: true });
		rmSync(`${restoredPath}-wal`, { force: true });
		expect(readdirSync(directory).sort()).toEqual([
			'independent-restore.sqlite',
			'source.sqlite',
			'source.sqlite-shm',
			'source.sqlite-wal'
		]);
		expect(store.events.slice(0, 4)).toEqual([
			`put:${result.objectKey}`,
			`put:${result.objectKey}.sha256`,
			'list:shop-backups/',
			'list:shop-backups/'
		]);
	});

	it('deletes both backup files strictly older than 30 rolling days', async () => {
		const oldBase = 'shop-backups/2026/06/17/shop-20260617T023044Z.sqlite.ssbk';
		const boundaryBase = 'shop-backups/2026/06/17/shop-20260617T023045Z.sqlite.ssbk';
		for (const key of [oldBase, `${oldBase}.sha256`]) {
			store.objects.set(key, {
				body: new Uint8Array(),
				contentType: 'application/octet-stream',
				lastModified: new Date('2026-06-17T02:30:44.999Z')
			});
		}
		for (const key of [boundaryBase, `${boundaryBase}.sha256`]) {
			store.objects.set(key, {
				body: new Uint8Array(),
				contentType: 'application/octet-stream',
				lastModified: new Date('2026-06-17T02:30:45.000Z')
			});
		}

		const result = await service().run(now);

		expect(result.deleted).toBe(2);
		expect(store.objects.has(oldBase)).toBe(false);
		expect(store.objects.has(`${oldBase}.sha256`)).toBe(false);
		expect(store.objects.has(boundaryBase)).toBe(true);
		expect(store.objects.has(`${boundaryBase}.sha256`)).toBe(true);
	});

	it('fails closed when the snapshot quick check cannot open the online-backup output', async () => {
		vi.spyOn(database, 'backup').mockImplementation(async (destination) => {
			writeFileSync(destination, Buffer.from('not a SQLite snapshot'));
			return { totalPages: 1, remainingPages: 0 };
		});

		await expect(service().run(now)).rejects.toThrowError(/^BACKUP_FAILED$/);

		expect(store.objects.size).toBe(0);
		expect(readdirSync(directory).sort()).toEqual([
			'source.sqlite',
			'source.sqlite-shm',
			'source.sqlite-wal'
		]);
		expect(database.prepare('SELECT marker FROM proof').get()).toEqual({
			marker: 'private database row'
		});
	});

	it.each([
		['invalid encryption key', 'invalid-key', undefined],
		['encrypted upload', encryptionKey, 1],
		['checksum upload', encryptionKey, 2]
	] as const)(
		'cleans every local temporary file after a failed %s',
		async (_stage, key, failPut) => {
			store.failPutNumber = failPut;

			await expect(service(key).run(now)).rejects.toThrowError(/^BACKUP_FAILED$/);

			expect(readdirSync(directory).sort()).toEqual([
				'source.sqlite',
				'source.sqlite-shm',
				'source.sqlite-wal'
			]);
			expect(database.prepare('SELECT marker FROM proof').get()).toEqual({
				marker: 'private database row'
			});
		}
	);

	it('removes an incomplete remote pair when checksum upload or listing verification fails', async () => {
		store.omitFromFirstList = 'shop-backups/2026/07/17/shop-20260717T023045Z.sqlite.ssbk.sha256';

		await expect(service().run(now)).rejects.toThrowError(/^BACKUP_FAILED$/);

		expect(store.objects.size).toBe(0);
		expect(store.events.at(-1)).toContain('delete:');
		expect(readdirSync(directory).sort()).toEqual([
			'source.sqlite',
			'source.sqlite-shm',
			'source.sqlite-wal'
		]);
	});

	it('stops between phases when aborted and does not begin a checksum upload', async () => {
		const controller = new AbortController();
		store.onPut = () => controller.abort(new Error('scheduler stopping'));

		await expect(service().run(now, controller.signal)).rejects.toThrowError(/^BACKUP_FAILED$/);

		expect(store.events.filter((event) => event.startsWith('put:'))).toHaveLength(1);
		expect(readdirSync(directory).sort()).toEqual([
			'source.sqlite',
			'source.sqlite-shm',
			'source.sqlite-wal'
		]);
	});

	it('waits for the non-abortable SQLite backup boundary then performs no storage I/O', async () => {
		let releaseSnapshot!: () => void;
		const snapshotBarrier = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		vi.spyOn(database, 'backup').mockImplementation(async () => {
			await snapshotBarrier;
			return { totalPages: 1, remainingPages: 0 };
		});
		const controller = new AbortController();
		let settled = false;
		const run = service()
			.run(now, controller.signal)
			.finally(() => {
				settled = true;
			});
		await vi.waitFor(() => expect(database.backup).toHaveBeenCalledOnce());

		controller.abort(new Error('scheduler stopping'));
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(store.events).toEqual([]);

		releaseSnapshot();
		await expect(run).rejects.toThrowError(/^BACKUP_FAILED$/);
		expect(store.events).toEqual([]);
		expect(readdirSync(directory).sort()).toEqual([
			'source.sqlite',
			'source.sqlite-shm',
			'source.sqlite-wal'
		]);
	});

	it('cleans local files even if retention fails after a verified backup', async () => {
		store.objects.set('shop-backups/2026/06/01/shop-20260601T000000Z.sqlite.ssbk', {
			body: new Uint8Array(),
			contentType: 'application/octet-stream',
			lastModified: new Date('2026-06-01T00:00:00.000Z')
		});
		store.failDelete = true;

		await expect(service().run(now)).rejects.toThrowError(/^BACKUP_FAILED$/);

		expect(readdirSync(directory).sort()).toEqual([
			'source.sqlite',
			'source.sqlite-shm',
			'source.sqlite-wal'
		]);
	});

	it('never reads or changes the source database file after a failed backup', async () => {
		const sourceBefore = readFileSync(join(directory, 'source.sqlite'));
		vi.spyOn(database, 'backup').mockRejectedValue(new Error('private snapshot detail'));

		await expect(service().run(now)).rejects.toThrowError(/^BACKUP_FAILED$/);

		expect(readFileSync(join(directory, 'source.sqlite'))).toEqual(sourceBefore);
		expect(database.prepare('SELECT COUNT(*) AS count FROM proof').get()).toEqual({ count: 1 });
	});
});
