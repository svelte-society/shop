import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import Database from 'better-sqlite3';
import { chmod, open, rename, rm } from 'node:fs/promises';
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAGIC = Buffer.from('SSBK1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;
const BASE64_32_BYTE_KEY = /^[A-Za-z0-9+/]{43}=$/;
const MAX_S3_KEY_BYTES = 1_024;
const SAFE_ERROR_CODES = new Set([
	'RESTORE_ARGUMENTS_INVALID',
	'RESTORE_CONFIRMATION_REQUIRED',
	'RESTORE_CONFIG_INVALID',
	'RESTORE_DOWNLOAD_FAILED',
	'RESTORE_CHECKSUM_MISMATCH',
	'RESTORE_KEY_INVALID',
	'RESTORE_FORMAT_INVALID',
	'RESTORE_DECRYPT_FAILED',
	'RESTORE_INTEGRITY_FAILED',
	'RESTORE_CLEANUP_FAILED',
	'RESTORE_FAILED'
]);

/** @param {unknown} value @returns {value is string} */
function exactValue(value) {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value === value.trim() &&
		!/[\r\n]/u.test(value)
	);
}

/** @param {unknown} value @returns {value is string} */
function validObjectKey(value) {
	const hasControlCharacter =
		typeof value === 'string' &&
		[...value].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || codePoint === 0x7f;
		});
	if (
		!exactValue(value) ||
		hasControlCharacter ||
		Buffer.byteLength(`${value}.sha256`, 'utf8') > MAX_S3_KEY_BYTES
	) {
		return false;
	}
	const match =
		/^(.+)\/(\d{4})\/(\d{2})\/(\d{2})\/shop-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.sqlite\.ssbk$/u.exec(
			value
		);
	if (!match) return false;
	const [, prefix, pathYear, pathMonth, pathDay, year, month, day, hour, minute, second] = match;
	if (
		prefix.split('/').some((part) => !part || part === '.' || part === '..') ||
		pathYear !== year ||
		pathMonth !== month ||
		pathDay !== day
	) {
		return false;
	}
	const timestamp = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
	const parsed = new Date(timestamp);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === timestamp;
}

/** @param {unknown} value */
function safeHttpsEndpoint(value) {
	if (!exactValue(value)) return false;
	try {
		const endpoint = new URL(value);
		return (
			endpoint.protocol === 'https:' &&
			!endpoint.username &&
			!endpoint.password &&
			!endpoint.search &&
			!endpoint.hash
		);
	} catch {
		return false;
	}
}

/** @param {string[]} args */
export function parseRestoreArguments(args) {
	let key;
	let appStopped = false;
	let replace = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--key' && key === undefined) {
			const candidate = args[index + 1];
			if (!validObjectKey(candidate) || candidate.startsWith('--')) {
				throw new Error('RESTORE_ARGUMENTS_INVALID');
			}
			key = candidate;
			index += 1;
		} else if (argument === '--confirm-app-stopped' && !appStopped) {
			appStopped = true;
		} else if (argument === '--confirm-replace' && !replace) {
			replace = true;
		} else {
			throw new Error('RESTORE_ARGUMENTS_INVALID');
		}
	}
	if (!key) throw new Error('RESTORE_ARGUMENTS_INVALID');
	if (!appStopped || !replace) throw new Error('RESTORE_CONFIRMATION_REQUIRED');
	return { key };
}

/** @param {Uint8Array} bytes */
function checksum(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

/** @param {Uint8Array} bytes @param {Uint8Array} companion */
function verifyChecksum(bytes, companion) {
	const expected = Buffer.from(companion).toString('ascii').trim();
	const actual = checksum(bytes);
	if (
		!/^[a-f0-9]{64}$/.test(expected) ||
		!timingSafeEqual(Buffer.from(actual, 'ascii'), Buffer.from(expected, 'ascii'))
	) {
		throw new Error('RESTORE_CHECKSUM_MISMATCH');
	}
}

/** @param {string | undefined} value */
function decodeKey(value) {
	if (typeof value !== 'string' || !BASE64_32_BYTE_KEY.test(value)) {
		throw new Error('RESTORE_KEY_INVALID');
	}
	const key = Buffer.from(value, 'base64');
	if (key.length !== 32 || key.toString('base64') !== value) {
		key.fill(0);
		throw new Error('RESTORE_KEY_INVALID');
	}
	return key;
}

/** @param {Uint8Array} bytes @param {string | undefined} keyBase64 */
function decrypt(bytes, keyBase64) {
	const object = Buffer.from(bytes);
	if (object.length < HEADER_BYTES || !object.subarray(0, MAGIC.length).equals(MAGIC)) {
		throw new Error('RESTORE_FORMAT_INVALID');
	}
	const key = decodeKey(keyBase64);
	try {
		const ivStart = MAGIC.length;
		const tagStart = ivStart + IV_BYTES;
		const ciphertextStart = tagStart + TAG_BYTES;
		const decipher = createDecipheriv('aes-256-gcm', key, object.subarray(ivStart, tagStart));
		decipher.setAuthTag(object.subarray(tagStart, ciphertextStart));
		return Buffer.concat([decipher.update(object.subarray(ciphertextStart)), decipher.final()]);
	} catch {
		throw new Error('RESTORE_DECRYPT_FAILED');
	} finally {
		key.fill(0);
	}
}

/** @param {string} path */
function quickCheck(path) {
	let database;
	try {
		database = new Database(path, { readonly: true, fileMustExist: true });
		const rows = /** @type {Array<Record<string, unknown>>} */ (database.pragma('quick_check'));
		if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
			throw new Error('RESTORE_INTEGRITY_FAILED');
		}
	} catch {
		throw new Error('RESTORE_INTEGRITY_FAILED');
	} finally {
		if (database?.open) database.close();
	}
}

/** @param {Date} date */
function timestamp(date) {
	return `${date.toISOString().slice(0, 19).replace(/[-:]/gu, '')}Z`;
}

/**
 * @param {string[]} paths
 * @param {(path: string, options?: { force?: boolean }) => Promise<void>} removeFile
 */
async function removeRequired(paths, removeFile) {
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
	if (failed) throw new Error('RESTORE_CLEANUP_FAILED');
}

/**
 * @param {string} path
 * @param {(path: string, options?: { force?: boolean }) => Promise<void>} removeFile
 */
async function removeRestoreTemps(path, removeFile) {
	await removeRequired([path, `${path}-shm`, `${path}-wal`], removeFile);
}

/** @param {string} path @param {Uint8Array} bytes */
async function writeSynced(path, bytes) {
	const handle = await open(path, 'wx', 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** @param {string} path */
async function syncPath(path) {
	const handle = await open(path, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * @param {string} databasePath
 * @param {string} preRestorePath
 * @param {string} dataDirectory
 * @param {(path: string, options?: { force?: boolean }) => Promise<void>} removeFile
 * @param {(path: string) => Promise<void>} syncFile
 * @param {(path: string) => Promise<void>} syncDirectory
 */
async function materializeCurrentDatabase(
	databasePath,
	preRestorePath,
	dataDirectory,
	removeFile,
	syncFile,
	syncDirectory
) {
	const reservation = await open(preRestorePath, 'wx', 0o600);
	await reservation.close();
	let current;
	try {
		current = new Database(databasePath, { fileMustExist: true });
		await current.backup(preRestorePath);
	} finally {
		if (current?.open) current.close();
	}
	await chmod(preRestorePath, 0o600);
	quickCheck(preRestorePath);
	await removeRequired([`${preRestorePath}-shm`, `${preRestorePath}-wal`], removeFile);
	await syncFile(preRestorePath);
	await syncDirectory(dataDirectory);
}

/**
 * @param {{
 *   key: string;
 *   encryptionKeyBase64: string | undefined;
 *   dataDirectory?: string;
 *   store: { get(key: string): Promise<Uint8Array> };
 *   now?: () => Date;
 *   removeFile?: (path: string, options?: { force?: boolean }) => Promise<void>;
 *   syncFile?: (path: string) => Promise<void>;
 *   syncDirectory?: (path: string) => Promise<void>;
 * }} options
 */
export async function restoreBackup(options) {
	const dataDirectory = options.dataDirectory ?? '/data';
	if (!isAbsolute(dataDirectory) || !validObjectKey(options.key)) {
		throw new Error('RESTORE_CONFIG_INVALID');
	}
	const databasePath = join(dataDirectory, 'shop.sqlite');
	const restorePath = join(dataDirectory, 'shop.restore.tmp');
	const preRestorePath = join(
		dataDirectory,
		`shop.pre-restore.${timestamp((options.now ?? (() => new Date()))())}.sqlite`
	);
	const removeFile = options.removeFile ?? rm;
	const syncFile = options.syncFile ?? syncPath;
	const syncDirectory = options.syncDirectory ?? syncPath;
	let plaintext;
	let result;
	let failure;

	try {
		await removeRestoreTemps(restorePath, removeFile);
		let encrypted;
		let companion;
		try {
			[encrypted, companion] = await Promise.all([
				options.store.get(options.key),
				options.store.get(`${options.key}.sha256`)
			]);
		} catch {
			throw new Error('RESTORE_DOWNLOAD_FAILED');
		}
		verifyChecksum(encrypted, companion);
		plaintext = decrypt(encrypted, options.encryptionKeyBase64);
		await writeSynced(restorePath, plaintext);
		quickCheck(restorePath);
		await removeRequired([`${restorePath}-shm`, `${restorePath}-wal`], removeFile);
		await materializeCurrentDatabase(
			databasePath,
			preRestorePath,
			dataDirectory,
			removeFile,
			syncFile,
			syncDirectory
		);
		await removeRequired([`${databasePath}-shm`, `${databasePath}-wal`], removeFile);
		await rename(restorePath, databasePath);
		await syncDirectory(dataDirectory);
		result = { databasePath, preRestorePath };
	} catch (error) {
		failure =
			error instanceof Error && SAFE_ERROR_CODES.has(error.message)
				? error
				: new Error('RESTORE_FAILED');
	} finally {
		plaintext?.fill(0);
		try {
			await removeRestoreTemps(restorePath, removeFile);
		} catch {
			failure = new Error('RESTORE_CLEANUP_FAILED');
		}
	}
	if (failure) throw failure;
	if (!result) throw new Error('RESTORE_FAILED');
	return result;
}

class S3RestoreStore {
	/** @param {string} bucket @param {S3Client} client */
	constructor(bucket, client) {
		this.bucket = bucket;
		this.client = client;
	}

	/** @param {string} key */
	async get(key) {
		try {
			const response = await this.client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: key })
			);
			if (!response.Body?.transformToByteArray) throw new Error('missing body');
			return await response.Body.transformToByteArray();
		} catch {
			throw new Error('RESTORE_DOWNLOAD_FAILED');
		}
	}
}

/** @param {Record<string, string | undefined>} environment */
export function createRestoreStoreFromEnvironment(environment) {
	const forcePathStyle = environment.S3_FORCE_PATH_STYLE;
	if (
		!safeHttpsEndpoint(environment.S3_ENDPOINT) ||
		!exactValue(environment.S3_BUCKET) ||
		!exactValue(environment.S3_REGION) ||
		!exactValue(environment.S3_ACCESS_KEY_ID) ||
		!exactValue(environment.S3_SECRET_ACCESS_KEY) ||
		(forcePathStyle !== 'true' && forcePathStyle !== 'false')
	) {
		throw new Error('RESTORE_CONFIG_INVALID');
	}
	const client = new S3Client({
		endpoint: environment.S3_ENDPOINT,
		region: environment.S3_REGION,
		forcePathStyle: forcePathStyle === 'true',
		credentials: {
			accessKeyId: environment.S3_ACCESS_KEY_ID,
			secretAccessKey: environment.S3_SECRET_ACCESS_KEY
		}
	});
	return new S3RestoreStore(environment.S3_BUCKET, client);
}

/** @param {unknown} error */
function stableErrorCode(error) {
	return error instanceof Error && SAFE_ERROR_CODES.has(error.message)
		? error.message
		: 'RESTORE_FAILED';
}

/**
 * @param {{
 *   args?: string[];
 *   environment?: Record<string, string | undefined>;
 *   output?: Pick<Console, 'log' | 'error'>;
 *   createStore?: (environment: Record<string, string | undefined>) => { get(key: string): Promise<Uint8Array> };
 * }} [options]
 */
export async function runRestoreCommand(options = {}) {
	const args = options.args ?? process.argv.slice(2);
	const environment = options.environment ?? process.env;
	const output = options.output ?? console;
	const createStore = options.createStore ?? createRestoreStoreFromEnvironment;
	try {
		const { key } = parseRestoreArguments(args);
		const store = createStore(environment);
		await restoreBackup({
			key,
			encryptionKeyBase64: environment.BACKUP_ENCRYPTION_KEY_BASE64,
			store
		});
		output.log(JSON.stringify({ event: 'restore_completed' }));
		return 0;
	} catch (error) {
		output.error(JSON.stringify({ event: 'restore_failed', error_code: stableErrorCode(error) }));
		return 1;
	}
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
	process.exitCode = await runRestoreCommand();
}
