import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
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
	waitForDeleteAbort = false;
	omitFromFirstList: string | undefined;
	onPut: ((key: string, signal?: AbortSignal) => void) | undefined;
	readonly deleteSignals: Array<AbortSignal | undefined> = [];
	private putCount = 0;
	private listCount = 0;

	private rejectPreAborted(signal?: AbortSignal): void {
		if (signal?.aborted) throw new Error('private pre-aborted operation');
	}

	async put(
		key: string,
		body: Uint8Array,
		contentType: string,
		signal?: AbortSignal
	): Promise<void> {
		this.rejectPreAborted(signal);
		this.putCount += 1;
		this.events.push(`put:${key}`);
		if (this.failPutNumber === this.putCount) throw new Error('private upload detail');
		this.objects.set(key, {
			body: Uint8Array.from(body),
			contentType,
			lastModified: new Date('2026-07-17T02:30:00.000Z')
		});
		this.onPut?.(key, signal);
	}

	async get(key: string, signal?: AbortSignal): Promise<Uint8Array> {
		this.rejectPreAborted(signal);
		const object = this.objects.get(key);
		if (!object) throw new Error('missing');
		return Uint8Array.from(object.body);
	}

	async list(
		prefix: string,
		signal?: AbortSignal
	): Promise<Array<{ key: string; lastModified: Date }>> {
		this.rejectPreAborted(signal);
		this.listCount += 1;
		this.events.push(`list:${prefix}`);
		return [...this.objects.entries()]
			.filter(
				([key]) =>
					key.startsWith(prefix) && !(this.listCount === 1 && key === this.omitFromFirstList)
			)
			.map(([key, object]) => ({ key, lastModified: object.lastModified }));
	}

	async delete(keys: string[], signal?: AbortSignal): Promise<void> {
		this.deleteSignals.push(signal);
		this.rejectPreAborted(signal);
		this.events.push(`delete:${keys.join(',')}`);
		if (this.waitForDeleteAbort) {
			await new Promise<never>((_resolve, reject) => {
				signal?.addEventListener(
					'abort',
					() => reject(new Error('private stalled cleanup detail')),
					{ once: true }
				);
			});
		}
		if (this.failDelete) throw new Error('private delete detail');
		for (const key of keys) this.objects.delete(key);
	}
}

const now = new Date('2026-07-17T02:30:45.000Z');
const encryptionKey = randomBytes(32).toString('base64');
let directory: string;
let database: ShopDatabase;
let store: MemoryBackupStore;

type ReviewFilesystemOptions = {
	removeFile?: (path: string, options?: { force?: boolean; recursive?: boolean }) => Promise<void>;
	remoteCleanupTimeoutMs?: number;
};

function service(
	key = encryptionKey,
	temporaryDirectory = directory,
	reviewOptions: ReviewFilesystemOptions = {}
): SqliteBackupService {
	return new SqliteBackupService({
		database,
		store,
		encryptionKeyBase64: key,
		prefix: 'shop-backups',
		temporaryDirectory,
		...reviewOptions
	} as ConstructorParameters<typeof SqliteBackupService>[0]);
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

	it('finishes verified local cleanup before retention listing or deletion', async () => {
		const oldBase = 'shop-backups/2026/06/01/shop-20260601T000000Z.sqlite.ssbk';
		for (const key of [oldBase, `${oldBase}.sha256`]) {
			store.objects.set(key, {
				body: new Uint8Array(),
				contentType: 'application/octet-stream',
				lastModified: new Date('2026-06-01T00:00:00.000Z')
			});
		}
		const removeFile = async (
			path: string,
			options?: { force?: boolean; recursive?: boolean }
		): Promise<void> => {
			store.events.push(`cleanup:${path.endsWith('.sqlite.ssbk') ? 'encrypted' : 'artifact'}`);
			await rm(path, options);
		};

		await service(encryptionKey, join(directory, 'backup-temp'), { removeFile }).run(now);

		const verificationList = store.events.indexOf('list:shop-backups/');
		const firstCleanup = store.events.findIndex((event) => event.startsWith('cleanup:'));
		const retentionList = store.events.indexOf('list:shop-backups/', verificationList + 1);
		const retentionDelete = store.events.findIndex(
			(event) => event === `delete:${oldBase},${oldBase}.sha256`
		);
		expect([verificationList, firstCleanup, retentionList, retentionDelete]).toEqual([
			2,
			expect.any(Number),
			expect.any(Number),
			expect.any(Number)
		]);
		expect(verificationList).toBeLessThan(firstCleanup);
		expect(firstCleanup).toBeLessThan(retentionList);
		expect(retentionList).toBeLessThan(retentionDelete);
	});

	it('does not start retention when mandatory local cleanup fails', async () => {
		const oldBase = 'shop-backups/2026/06/01/shop-20260601T000000Z.sqlite.ssbk';
		store.objects.set(oldBase, {
			body: new Uint8Array(),
			contentType: 'application/octet-stream',
			lastModified: new Date('2026-06-01T00:00:00.000Z')
		});
		const removeFile = async (
			path: string,
			options?: { force?: boolean; recursive?: boolean }
		): Promise<void> => {
			store.events.push(`cleanup:${path}`);
			if (path.endsWith('.sqlite.ssbk')) throw new Error('private cleanup detail');
			await rm(path, options);
		};

		await expect(
			service(encryptionKey, join(directory, 'backup-temp'), { removeFile }).run(now)
		).rejects.toThrowError(/^BACKUP_FAILED$/);

		expect(store.events.filter((event) => event === 'list:shop-backups/')).toHaveLength(1);
		expect(store.events.some((event) => event.startsWith('delete:'))).toBe(false);
		expect(store.events.findIndex((event) => event.startsWith('cleanup:'))).toBeGreaterThan(
			store.events.indexOf('list:shop-backups/')
		);
	});

	it('uses one authoritative age for each pair and handles orphans without splitting companions', async () => {
		const retainedBase = 'shop-backups/2026/06/17/shop-20260617T023045Z.sqlite.ssbk';
		const expiredBase = 'shop-backups/2026/06/17/shop-20260617T023044Z.sqlite.ssbk';
		const oldOrphan = 'shop-backups/2026/06/01/shop-20260601T000000Z.sqlite.ssbk';
		const oldCompanionOrphan = 'shop-backups/2026/06/02/shop-20260602T000000Z.sqlite.ssbk.sha256';
		const boundaryOrphan = 'shop-backups/2026/06/17/shop-20260617T023046Z.sqlite.ssbk';
		const put = (key: string, lastModified: string): void => {
			store.objects.set(key, {
				body: new Uint8Array(),
				contentType: 'application/octet-stream',
				lastModified: new Date(lastModified)
			});
		};
		put(retainedBase, '2026-06-17T02:30:45.000Z');
		put(`${retainedBase}.sha256`, '2026-06-01T00:00:00.000Z');
		put(expiredBase, '2026-06-17T02:30:44.999Z');
		put(`${expiredBase}.sha256`, '2026-07-17T02:30:45.000Z');
		put(oldOrphan, '2026-06-01T00:00:00.000Z');
		put(oldCompanionOrphan, '2026-06-02T00:00:00.000Z');
		put(boundaryOrphan, '2026-06-17T02:30:45.000Z');

		const result = await service().run(now);

		expect(result.deleted).toBe(4);
		expect(store.objects.has(retainedBase)).toBe(true);
		expect(store.objects.has(`${retainedBase}.sha256`)).toBe(true);
		expect(store.objects.has(expiredBase)).toBe(false);
		expect(store.objects.has(`${expiredBase}.sha256`)).toBe(false);
		expect(store.objects.has(oldOrphan)).toBe(false);
		expect(store.objects.has(oldCompanionOrphan)).toBe(false);
		expect(store.objects.has(boundaryOrphan)).toBe(true);
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

	it('uses a fresh cleanup signal after abort and removes the uploaded singleton', async () => {
		const controller = new AbortController();
		store.onPut = () => controller.abort(new Error('scheduler stopping'));

		await expect(service().run(now, controller.signal)).rejects.toThrowError(/^BACKUP_FAILED$/);

		expect(store.events.filter((event) => event.startsWith('put:'))).toHaveLength(1);
		expect(store.deleteSignals).toHaveLength(1);
		expect(store.deleteSignals[0]).not.toBe(controller.signal);
		expect(store.deleteSignals[0]?.aborted).toBe(false);
		expect(store.objects.size).toBe(0);
		expect(readdirSync(directory).sort()).toEqual([
			'source.sqlite',
			'source.sqlite-shm',
			'source.sqlite-wal'
		]);
	});

	it('bounds partial remote cleanup and returns only the stable failure code', async () => {
		const controller = new AbortController();
		store.onPut = () => controller.abort(new Error('scheduler stopping'));
		store.waitForDeleteAbort = true;
		const startedAt = Date.now();

		await expect(
			service(encryptionKey, directory, { remoteCleanupTimeoutMs: 20 }).run(now, controller.signal)
		).rejects.toThrowError(/^BACKUP_FAILED$/);

		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(store.deleteSignals).toHaveLength(1);
		expect(store.deleteSignals[0]?.aborted).toBe(true);
	});

	it('uses a private per-run directory and 0600 for the plaintext snapshot and sidecars', async () => {
		const temporaryDirectory = join(directory, 'backup-temp');
		const originalBackup = database.backup.bind(database);
		let heldSnapshot: Database.Database | undefined;
		vi.spyOn(database, 'backup').mockImplementation(async (destination) => {
			const progress = await originalBackup(destination);
			heldSnapshot = new Database(destination);
			heldSnapshot.pragma('journal_mode = WAL');
			heldSnapshot.exec('CREATE TABLE permission_probe (id INTEGER PRIMARY KEY)');
			return progress;
		});
		let observed = false;
		store.onPut = () => {
			if (observed) return;
			observed = true;
			const entries = readdirSync(temporaryDirectory, { withFileTypes: true });
			expect(entries).toHaveLength(1);
			expect(entries[0]?.isDirectory()).toBe(true);
			const runDirectory = join(temporaryDirectory, entries[0]!.name);
			expect(statSync(runDirectory).mode & 0o777).toBe(0o700);
			const snapshot = readdirSync(runDirectory).find((entry) =>
				entry.endsWith('.snapshot.sqlite')
			);
			expect(snapshot).toBeDefined();
			for (const path of [
				join(runDirectory, snapshot!),
				join(runDirectory, `${snapshot!}-wal`),
				join(runDirectory, `${snapshot!}-shm`)
			]) {
				expect(statSync(path).mode & 0o777).toBe(0o600);
			}
		};

		try {
			await service(encryptionKey, temporaryDirectory).run(now);
		} finally {
			heldSnapshot?.close();
		}
		expect(observed).toBe(true);
		expect(readdirSync(temporaryDirectory)).toEqual([]);
	});

	it.each(['snapshot', 'snapshot-wal', 'snapshot-shm', 'encrypted', 'checksum'] as const)(
		'attempts every local cleanup and fails closed when %s removal fails',
		async (failedKind) => {
			const attempted = new Set<string>();
			const classify = (path: string): string => {
				if (path.endsWith('.snapshot.sqlite-wal')) return 'snapshot-wal';
				if (path.endsWith('.snapshot.sqlite-shm')) return 'snapshot-shm';
				if (path.endsWith('.snapshot.sqlite')) return 'snapshot';
				if (path.endsWith('.sqlite.ssbk.sha256')) return 'checksum';
				if (path.endsWith('.sqlite.ssbk')) return 'encrypted';
				return 'run-directory';
			};
			const removeFile = async (
				path: string,
				options?: { force?: boolean; recursive?: boolean }
			): Promise<void> => {
				const kind = classify(path);
				attempted.add(kind);
				if (kind === failedKind) throw new Error('private cleanup detail');
				await rm(path, options);
			};

			await expect(
				service(encryptionKey, join(directory, 'backup-temp'), { removeFile }).run(now)
			).rejects.toThrowError(/^BACKUP_FAILED$/);
			expect(attempted).toEqual(
				new Set([
					'snapshot',
					'snapshot-wal',
					'snapshot-shm',
					'encrypted',
					'checksum',
					'run-directory'
				])
			);
		}
	);

	it.each(['nested//prefix', 'nested/\u0001prefix'])(
		'rejects non-canonical prefix %j',
		(prefix) => {
			expect(
				() =>
					new SqliteBackupService({
						database,
						store,
						encryptionKeyBase64: encryptionKey,
						prefix,
						temporaryDirectory: directory
					})
			).toThrowError(/^BACKUP_CONFIG_INVALID$/);
		}
	);

	it('rejects a prefix whose checksum companion would exceed the S3 UTF-8 key limit', () => {
		expect(
			() =>
				new SqliteBackupService({
					database,
					store,
					encryptionKeyBase64: encryptionKey,
					prefix: 'é'.repeat(500),
					temporaryDirectory: directory
				})
		).toThrowError(/^BACKUP_CONFIG_INVALID$/);
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
