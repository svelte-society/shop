import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ShopDatabase } from '$lib/server/db/types';
import { backupChecksum, encryptBackup } from './format';
import type { BackupStore } from './s3.server';

const RETENTION_MS = 30 * 24 * 60 * 60_000;
const REMOTE_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_S3_KEY_BYTES = 1_024;
const LONGEST_KEY_SUFFIX = '/0000/00/00/shop-00000000T000000Z.sqlite.ssbk.sha256';

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
	removeFile?: (path: string, options?: { force?: boolean; recursive?: boolean }) => Promise<void>;
	remoteCleanupTimeoutMs?: number;
};

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error('BACKUP_ABORTED');
}

function normalizedPrefix(prefix: string): string {
	const hasControlCharacter = [...prefix].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
	if (prefix !== prefix.trim() || hasControlCharacter) {
		throw new Error('BACKUP_CONFIG_INVALID');
	}
	const normalized = prefix.replace(/^\/+|\/+$/gu, '');
	if (
		!normalized ||
		normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
		Buffer.byteLength(`${normalized}${LONGEST_KEY_SUFFIX}`, 'utf8') > MAX_S3_KEY_BYTES
	) {
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

function canonicalBackupBase(key: string, prefix: string): string | undefined {
	const prefixWithSlash = `${prefix}/`;
	if (!key.startsWith(prefixWithSlash)) return undefined;
	const relative = key.slice(prefixWithSlash.length);
	const match =
		/^(\d{4})\/(\d{2})\/(\d{2})\/shop-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.sqlite\.ssbk(\.sha256)?$/u.exec(
			relative
		);
	if (!match) return undefined;
	const [, pathYear, pathMonth, pathDay, year, month, day, hour, minute, second, companion] = match;
	if (pathYear !== year || pathMonth !== month || pathDay !== day) return undefined;
	const timestamp = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
	const parsed = new Date(timestamp);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) return undefined;
	return companion ? key.slice(0, -'.sha256'.length) : key;
}

function expiredBackupKeys(
	listing: Array<{ key: string; lastModified: Date }>,
	prefix: string,
	cutoff: Date
): string[] {
	const groups = new Map<
		string,
		{
			base?: { key: string; lastModified: Date };
			companion?: { key: string; lastModified: Date };
		}
	>();
	for (const item of listing) {
		const baseKey = canonicalBackupBase(item.key, prefix);
		if (!baseKey) continue;
		const group = groups.get(baseKey) ?? {};
		if (item.key.endsWith('.sha256')) group.companion = item;
		else group.base = item;
		groups.set(baseKey, group);
	}
	const expired: string[] = [];
	for (const group of groups.values()) {
		const authoritative = group.base ?? group.companion;
		if (!authoritative || authoritative.lastModified >= cutoff) continue;
		if (group.base) expired.push(group.base.key);
		if (group.companion) expired.push(group.companion.key);
	}
	return expired;
}

async function chmodIfPresent(path: string, mode: number): Promise<void> {
	try {
		await chmod(path, mode);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}

async function removeLocalArtifacts(
	paths: string[],
	runDirectory: string,
	removeFile: NonNullable<SqliteBackupServiceOptions['removeFile']>
): Promise<void> {
	let failed = false;
	await Promise.all(
		paths.map(async (path) => {
			try {
				await removeFile(path, { force: true });
			} catch {
				failed = true;
			}
		})
	);
	try {
		await removeFile(runDirectory, { force: true, recursive: true });
	} catch {
		failed = true;
	}
	if (failed) throw new Error('BACKUP_CLEANUP_FAILED');
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
		const runDirectory = join(this.options.temporaryDirectory, id);
		const snapshotPath = join(runDirectory, `${id}.snapshot.sqlite`);
		const encryptedPath = join(runDirectory, `${id}.sqlite.ssbk`);
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
		let result: { objectKey: string; checksum: string; deleted: number } | undefined;
		let failed = false;

		try {
			checkAborted(signal);
			await mkdir(this.options.temporaryDirectory, { recursive: true, mode: 0o700 });
			await mkdir(runDirectory, { mode: 0o700 });
			await this.options.database.backup(snapshotPath);
			await chmod(snapshotPath, 0o600);
			checkAborted(signal);
			if (!snapshotIsHealthy(snapshotPath)) throw new Error('BACKUP_SNAPSHOT_INVALID');
			await Promise.all([
				chmodIfPresent(snapshotPath, 0o600),
				chmodIfPresent(`${snapshotPath}-wal`, 0o600),
				chmodIfPresent(`${snapshotPath}-shm`, 0o600)
			]);

			checkAborted(signal);
			const plaintext = await readFile(snapshotPath);
			let encrypted: Uint8Array;
			try {
				encrypted = encryptBackup(plaintext, this.options.encryptionKeyBase64);
			} finally {
				plaintext.fill(0);
			}
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

			await removeLocalArtifacts(localFiles, runDirectory, this.options.removeFile ?? rm);

			checkAborted(signal);
			const cutoff = new Date(now.getTime() - RETENTION_MS);
			const retainedListing = await this.options.store.list(`${this.prefix}/`, signal);
			const expired = expiredBackupKeys(retainedListing, this.prefix, cutoff);
			if (expired.length > 0) await this.options.store.delete(expired, signal);
			result = { objectKey: key, checksum, deleted: expired.length };
		} catch {
			failed = true;
			if (!verified && intendedRemoteKeys.length > 0) {
				const cleanupSignal = AbortSignal.timeout(
					this.options.remoteCleanupTimeoutMs ?? REMOTE_CLEANUP_TIMEOUT_MS
				);
				try {
					await this.options.store.delete(intendedRemoteKeys, cleanupSignal);
				} catch {
					// The stable failure takes precedence; a later retention pass removes old debris.
				}
			}
		} finally {
			try {
				await removeLocalArtifacts(localFiles, runDirectory, this.options.removeFile ?? rm);
			} catch {
				failed = true;
			}
		}
		if (failed || !result) throw new Error('BACKUP_FAILED');
		return result;
	}
}
