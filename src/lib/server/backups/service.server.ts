import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ShopDatabase } from '$lib/server/db/types';
import { backupChecksum, encryptBackup } from './format';
import type { BackupStore } from './s3.server';

const RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface BackupService {
	run(
		now?: Date,
		signal?: AbortSignal
	): Promise<{ objectKey: string; checksum: string; deleted: number }>;
}

export type SqliteBackupServiceOptions = {
	database: ShopDatabase;
	store: BackupStore;
	encryptionKeyBase64: string;
	prefix: string;
	temporaryDirectory: string;
};

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error('BACKUP_ABORTED');
}

function normalizedPrefix(prefix: string): string {
	if (prefix !== prefix.trim() || /[\r\n]/u.test(prefix)) throw new Error('BACKUP_CONFIG_INVALID');
	const normalized = prefix.replace(/^\/+|\/+$/gu, '');
	if (!normalized || normalized.split('/').some((part) => part === '.' || part === '..')) {
		throw new Error('BACKUP_CONFIG_INVALID');
	}
	return normalized;
}

function objectKey(prefix: string, now: Date): string {
	const iso = now.toISOString();
	const year = iso.slice(0, 4);
	const month = iso.slice(5, 7);
	const day = iso.slice(8, 10);
	const compact = iso.slice(0, 19).replace(/[-:]/gu, '');
	return `${prefix}/${year}/${month}/${day}/shop-${compact}Z.sqlite.ssbk`;
}

function snapshotIsHealthy(path: string): boolean {
	const snapshot = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const rows = snapshot.pragma('quick_check') as Array<Record<string, unknown>>;
		return rows.length === 1 && rows[0]?.quick_check === 'ok';
	} finally {
		snapshot.close();
	}
}

function retentionCandidate(key: string, prefix: string): boolean {
	return (
		key.startsWith(`${prefix}/`) && /\/shop-\d{8}T\d{6}Z\.sqlite\.ssbk(?:\.sha256)?$/u.test(key)
	);
}

async function removeFiles(paths: string[]): Promise<void> {
	await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => undefined)));
}

export class SqliteBackupService implements BackupService {
	private readonly prefix: string;

	constructor(private readonly options: SqliteBackupServiceOptions) {
		this.prefix = normalizedPrefix(options.prefix);
	}

	async run(
		now = new Date(),
		signal?: AbortSignal
	): Promise<{ objectKey: string; checksum: string; deleted: number }> {
		const id = randomUUID();
		const snapshotPath = join(this.options.temporaryDirectory, `${id}.snapshot.sqlite`);
		const encryptedPath = join(this.options.temporaryDirectory, `${id}.sqlite.ssbk`);
		const checksumPath = `${encryptedPath}.sha256`;
		const localFiles = [
			snapshotPath,
			`${snapshotPath}-shm`,
			`${snapshotPath}-wal`,
			encryptedPath,
			checksumPath
		];
		const key = objectKey(this.prefix, now);
		const checksumKey = `${key}.sha256`;
		const intendedRemoteKeys: string[] = [];
		let verified = false;

		try {
			checkAborted(signal);
			await mkdir(this.options.temporaryDirectory, { recursive: true, mode: 0o700 });
			await this.options.database.backup(snapshotPath);
			checkAborted(signal);
			if (!snapshotIsHealthy(snapshotPath)) throw new Error('BACKUP_SNAPSHOT_INVALID');

			checkAborted(signal);
			const plaintext = await readFile(snapshotPath);
			const encrypted = encryptBackup(plaintext, this.options.encryptionKeyBase64);
			await writeFile(encryptedPath, encrypted, { mode: 0o600 });
			const checksum = backupChecksum(encrypted);
			await writeFile(checksumPath, `${checksum}\n`, { encoding: 'ascii', mode: 0o600 });

			checkAborted(signal);
			intendedRemoteKeys.push(key);
			await this.options.store.put(
				key,
				await readFile(encryptedPath),
				'application/octet-stream',
				signal
			);
			checkAborted(signal);
			intendedRemoteKeys.push(checksumKey);
			await this.options.store.put(
				checksumKey,
				await readFile(checksumPath),
				'text/plain; charset=utf-8',
				signal
			);

			checkAborted(signal);
			const uploaded = await this.options.store.list(`${this.prefix}/`, signal);
			if (![key, checksumKey].every((expected) => uploaded.some((item) => item.key === expected))) {
				throw new Error('BACKUP_UPLOAD_NOT_VERIFIED');
			}
			verified = true;

			await removeFiles(localFiles);
			checkAborted(signal);
			const cutoff = new Date(now.getTime() - RETENTION_MS);
			const retainedListing = await this.options.store.list(`${this.prefix}/`, signal);
			const expired = retainedListing
				.filter((item) => retentionCandidate(item.key, this.prefix) && item.lastModified < cutoff)
				.map((item) => item.key);
			if (expired.length > 0) await this.options.store.delete(expired, signal);
			return { objectKey: key, checksum, deleted: expired.length };
		} catch {
			if (!verified && intendedRemoteKeys.length > 0) {
				try {
					await this.options.store.delete(intendedRemoteKeys, signal);
				} catch {
					// The stable failure takes precedence; a later retention pass removes old debris.
				}
			}
			throw new Error('BACKUP_FAILED');
		} finally {
			await removeFiles(localFiles);
		}
	}
}
