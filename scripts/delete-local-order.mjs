import {
	DeleteObjectsCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import Database from 'better-sqlite3';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAGIC = Buffer.from('SSBK1', 'ascii');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BASE64_32_BYTE_KEY = /^[A-Za-z0-9+/]{43}=$/u;
const MAX_S3_KEY_BYTES = 1_024;
const ORDER_ALERT_CODES = [
	'ORDER_PENDING_REVIEW',
	'STYRIA_REVIEW_REQUIRED',
	'SHIPPING_EMAIL_UNSENT'
];
const DELETION_TABLES = [
	'stripe_events',
	'support_notes',
	'email_deliveries',
	'outbox_jobs',
	'submission_approvals',
	'order_events',
	'order_lines',
	'orders',
	'checkout_draft_lines',
	'checkout_drafts'
];
const SAFE_ERROR_CODES = new Set([
	'LOCAL_ORDER_DELETE_ARGUMENTS_INVALID',
	'LOCAL_ORDER_DELETE_CONFIRMATION_REQUIRED',
	'LOCAL_ORDER_DELETE_MAINTENANCE_REQUIRED',
	'LOCAL_ORDER_DELETE_CONFIG_INVALID',
	'LOCAL_ORDER_DELETE_NOT_FOUND',
	'LOCAL_ORDER_DELETE_BACKUP_FAILED',
	'LOCAL_ORDER_DELETE_FAILED'
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

/** @param {unknown} value */
function safeHttpsEndpoint(value) {
	if (!exactValue(value)) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
	} catch {
		return false;
	}
}

/** @param {unknown} value */
function normalizedPrefix(value) {
	if (!exactValue(value)) throw new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
	const prefix = value.replace(/^\/+|\/+$/gu, '');
	if (
		!prefix ||
		prefix.split('/').some((part) => !part || part === '.' || part === '..') ||
		Buffer.byteLength(`${prefix}/0000/00/00/shop-00000000T000000Z.sqlite.ssbk.sha256`, 'utf8') >
			MAX_S3_KEY_BYTES
	) {
		throw new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
	}
	return prefix;
}

/** @param {unknown} value */
function encryptionKey(value) {
	if (typeof value !== 'string' || !BASE64_32_BYTE_KEY.test(value)) {
		throw new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
	}
	const key = Buffer.from(value, 'base64');
	if (key.length !== 32 || key.toString('base64') !== value) {
		key.fill(0);
		throw new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
	}
	return key;
}

/** @param {Uint8Array} plaintext @param {string | undefined} keyBase64 */
function encryptBackup(plaintext, keyBase64) {
	const key = encryptionKey(keyBase64);
	try {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', key, iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
	} catch {
		throw new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
	} finally {
		key.fill(0);
	}
}

/** @param {Date} now @param {string} prefix */
function backupObjectKey(now, prefix) {
	const iso = now.toISOString();
	if (!Number.isFinite(now.getTime())) throw new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
	return `${prefix}/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/shop-${iso
		.slice(0, 19)
		.replace(/[-:]/gu, '')}Z.sqlite.ssbk`;
}

class S3DeletionBackupStore {
	/** @param {string} bucket @param {S3Client} client */
	constructor(bucket, client) {
		this.bucket = bucket;
		this.client = client;
	}

	/** @param {string} key @param {Uint8Array} body @param {string} contentType */
	async put(key, body, contentType) {
		await this.client.send(
			new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType })
		);
	}

	/** @param {string} prefix */
	async list(prefix) {
		const keys = [];
		let continuationToken;
		do {
			/** @type {{ Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string }} */
			const response = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					...(continuationToken ? { ContinuationToken: continuationToken } : {})
				})
			);
			for (const item of response.Contents ?? []) {
				if (typeof item.Key === 'string') keys.push(item.Key);
			}
			if (!response.IsTruncated) break;
			if (!response.NextContinuationToken) {
				throw new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
			}
			continuationToken = response.NextContinuationToken;
		} while (continuationToken);
		return keys;
	}

	/** @param {string[]} keys */
	async delete(keys) {
		if (keys.length === 0) return;
		await this.client.send(
			new DeleteObjectsCommand({
				Bucket: this.bucket,
				Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true }
			})
		);
	}
}

/** @param {Record<string, string | undefined>} environment */
function createBackupStore(environment) {
	if (
		!safeHttpsEndpoint(environment.S3_ENDPOINT) ||
		!exactValue(environment.S3_BUCKET) ||
		!exactValue(environment.S3_REGION) ||
		!exactValue(environment.S3_ACCESS_KEY_ID) ||
		!exactValue(environment.S3_SECRET_ACCESS_KEY) ||
		!['true', 'false'].includes(environment.S3_FORCE_PATH_STYLE ?? '')
	) {
		throw new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
	}
	const client = new S3Client({
		endpoint: environment.S3_ENDPOINT,
		region: environment.S3_REGION,
		forcePathStyle: environment.S3_FORCE_PATH_STYLE === 'true',
		credentials: {
			accessKeyId: environment.S3_ACCESS_KEY_ID,
			secretAccessKey: environment.S3_SECRET_ACCESS_KEY
		}
	});
	return new S3DeletionBackupStore(environment.S3_BUCKET, client);
}

/**
 * @param {{
 *   database: Database.Database;
 *   environment: Record<string, string | undefined>;
 *   store?: { put(key: string, body: Uint8Array, contentType: string): Promise<void>; list(prefix: string): Promise<string[]>; delete(keys: string[]): Promise<void> };
 *   now?: Date;
 *   temporaryDirectory?: string;
 * }} options
 */
export async function createConfirmedEncryptedDeletionBackup(options) {
	const prefix = normalizedPrefix(options.environment.S3_PREFIX);
	const store = options.store ?? createBackupStore(options.environment);
	const now = options.now ?? new Date();
	const key = backupObjectKey(now, prefix);
	const checksumKey = `${key}.sha256`;
	const runDirectory = join(
		options.temporaryDirectory ?? options.environment.TMPDIR ?? tmpdir(),
		randomUUID()
	);
	const snapshotPath = join(runDirectory, `${randomUUID()}.snapshot.sqlite`);
	let plaintext;
	let encrypted;
	const uploaded = [];
	let failure;
	try {
		await mkdir(runDirectory, { recursive: true, mode: 0o700 });
		await options.database.backup(snapshotPath);
		await chmod(snapshotPath, 0o600);
		const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
		try {
			if (JSON.stringify(snapshot.pragma('quick_check')) !== '[{"quick_check":"ok"}]') {
				throw new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
			}
		} finally {
			snapshot.close();
		}
		plaintext = await readFile(snapshotPath);
		encrypted = encryptBackup(plaintext, options.environment.BACKUP_ENCRYPTION_KEY_BASE64);
		plaintext.fill(0);
		plaintext = undefined;
		const checksum = createHash('sha256').update(encrypted).digest('hex');
		await store.put(key, encrypted, 'application/octet-stream');
		uploaded.push(key);
		await store.put(
			checksumKey,
			Buffer.from(`${checksum}\n`, 'ascii'),
			'text/plain; charset=utf-8'
		);
		uploaded.push(checksumKey);
		const listing = await store.list(`${prefix}/`);
		if (!uploaded.every((expected) => listing.includes(expected))) {
			throw new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
		}
	} catch {
		if (uploaded.length > 0) {
			try {
				await store.delete(uploaded);
			} catch {
				// The stable backup failure takes precedence over remote cleanup details.
			}
		}
		failure = new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
	} finally {
		plaintext?.fill(0);
		encrypted?.fill(0);
		try {
			await rm(runDirectory, { force: true, recursive: true });
		} catch {
			failure = new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
		}
	}
	if (failure) throw failure;
}

/** @param {string[]} args */
export function parseDeleteLocalOrderArguments(args) {
	let orderId;
	let confirmed = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--order-id' && orderId === undefined) {
			const candidate = args[index + 1];
			if (typeof candidate !== 'string' || !UUID_PATTERN.test(candidate)) {
				throw new Error('LOCAL_ORDER_DELETE_ARGUMENTS_INVALID');
			}
			orderId = candidate;
			index += 1;
		} else if (argument === '--confirm-reviewed-deletion' && !confirmed) {
			confirmed = true;
		} else {
			throw new Error('LOCAL_ORDER_DELETE_ARGUMENTS_INVALID');
		}
	}
	if (!orderId) throw new Error('LOCAL_ORDER_DELETE_ARGUMENTS_INVALID');
	if (!confirmed) throw new Error('LOCAL_ORDER_DELETE_CONFIRMATION_REQUIRED');
	return { orderId };
}

/** @param {Database.Database} database */
function assertQuickCheck(database) {
	const rows = /** @type {Array<Record<string, unknown>>} */ (database.pragma('quick_check'));
	if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
		throw new Error('LOCAL_ORDER_DELETE_FAILED');
	}
}

/**
 * @param {{
 *   database: Database.Database;
 *   orderId: string;
 *   createBackup: () => Promise<void>;
 * }} options
 */
export async function deleteLocalOrder(options) {
	const relation =
		/** @type {{ id: string; checkout_draft_id: string; order_checkout_session_id: string; draft_checkout_session_id: string | null; stripe_payment_intent_id: string } | undefined} */ (
			options.database
				.prepare(
					`SELECT o.id, o.checkout_draft_id,
			        o.stripe_checkout_session_id AS order_checkout_session_id,
			        d.stripe_checkout_session_id AS draft_checkout_session_id,
			        o.stripe_payment_intent_id
			 FROM orders o
			 JOIN checkout_drafts d ON d.id = o.checkout_draft_id
			 WHERE o.id = ?`
				)
				.get(options.orderId)
		);
	if (!relation) throw new Error('LOCAL_ORDER_DELETE_NOT_FOUND');

	try {
		await options.createBackup();
	} catch {
		throw new Error('LOCAL_ORDER_DELETE_BACKUP_FAILED');
	}

	/** @type {Record<string, number>} */
	const counts = Object.fromEntries(DELETION_TABLES.map((table) => [table, 0]));
	try {
		options.database.exec('BEGIN IMMEDIATE');
		const current = /** @type {typeof relation} */ (
			options.database
				.prepare(
					`SELECT o.id, o.checkout_draft_id,
				        o.stripe_checkout_session_id AS order_checkout_session_id,
				        d.stripe_checkout_session_id AS draft_checkout_session_id,
				        o.stripe_payment_intent_id
				 FROM orders o
				 JOIN checkout_drafts d ON d.id = o.checkout_draft_id
				 WHERE o.id = ?`
				)
				.get(options.orderId)
		);
		if (!current || JSON.stringify(current) !== JSON.stringify(relation)) {
			throw new Error('LOCAL_ORDER_DELETE_FAILED');
		}

		counts.stripe_events = options.database
			.prepare(
				`DELETE FROM stripe_events
				 WHERE stripe_checkout_session_id = ?
				    OR stripe_checkout_session_id = ?
				    OR stripe_payment_intent_id = ?`
			)
			.run(
				relation.order_checkout_session_id,
				relation.draft_checkout_session_id,
				relation.stripe_payment_intent_id
			).changes;
		counts.support_notes = options.database
			.prepare('DELETE FROM support_notes WHERE order_id = ?')
			.run(options.orderId).changes;
		counts.email_deliveries = options.database
			.prepare('DELETE FROM email_deliveries WHERE order_id = ?')
			.run(options.orderId).changes;
		counts.outbox_jobs = options.database
			.prepare(
				`DELETE FROM outbox_jobs
				 WHERE order_id = ?
				    OR (alert_subject_id = ? AND alert_code IN (?, ?, ?))`
			)
			.run(options.orderId, options.orderId, ...ORDER_ALERT_CODES).changes;
		counts.submission_approvals = options.database
			.prepare('DELETE FROM submission_approvals WHERE order_id = ?')
			.run(options.orderId).changes;
		counts.order_events = options.database
			.prepare('DELETE FROM order_events WHERE order_id = ?')
			.run(options.orderId).changes;
		counts.order_lines = options.database
			.prepare('DELETE FROM order_lines WHERE order_id = ?')
			.run(options.orderId).changes;
		counts.orders = options.database
			.prepare('DELETE FROM orders WHERE id = ?')
			.run(options.orderId).changes;
		counts.checkout_draft_lines = options.database
			.prepare('DELETE FROM checkout_draft_lines WHERE draft_id = ?')
			.run(relation.checkout_draft_id).changes;
		counts.checkout_drafts = options.database
			.prepare('DELETE FROM checkout_drafts WHERE id = ?')
			.run(relation.checkout_draft_id).changes;
		if (counts.orders !== 1 || counts.checkout_drafts !== 1) {
			throw new Error('LOCAL_ORDER_DELETE_FAILED');
		}
		assertQuickCheck(options.database);
		options.database.exec('COMMIT');
		return counts;
	} catch {
		if (options.database.inTransaction) {
			try {
				options.database.exec('ROLLBACK');
			} catch {
				// The stable deletion failure does not expose database details.
			}
		}
		throw new Error('LOCAL_ORDER_DELETE_FAILED');
	}
}

/** @param {unknown} error */
function stableErrorCode(error) {
	return error instanceof Error && SAFE_ERROR_CODES.has(error.message)
		? error.message
		: 'LOCAL_ORDER_DELETE_FAILED';
}

/**
 * @param {{
 *   args?: string[];
 *   environment?: Record<string, string | undefined>;
 *   output?: Pick<Console, 'log' | 'error'>;
 *   openDatabase?: (path: string) => Database.Database;
 *   closeDatabase?: (database: Database.Database) => void;
 *   createBackup?: (database: Database.Database, environment: Record<string, string | undefined>) => Promise<void>;
 * }} [options]
 */
export async function runDeleteLocalOrderCommand(options = {}) {
	const args = options.args ?? process.argv.slice(2);
	const environment = options.environment ?? process.env;
	const output = options.output ?? console;
	/** @type {Database.Database | undefined} */
	let database;
	try {
		const { orderId } = parseDeleteLocalOrderArguments(args);
		if (environment.CHECKOUT_ENABLED !== 'false' || environment.SCHEDULER_ENABLED !== 'false') {
			throw new Error('LOCAL_ORDER_DELETE_MAINTENANCE_REQUIRED');
		}
		if (!exactValue(environment.DATABASE_PATH) || !isAbsolute(environment.DATABASE_PATH)) {
			throw new Error('LOCAL_ORDER_DELETE_CONFIG_INVALID');
		}
		database = (options.openDatabase ?? ((path) => new Database(path, { fileMustExist: true })))(
			environment.DATABASE_PATH
		);
		database.pragma('journal_mode = WAL');
		database.pragma('foreign_keys = ON');
		database.pragma('busy_timeout = 5000');
		database.pragma('synchronous = FULL');
		const createBackup =
			options.createBackup ??
			((source, runtimeEnvironment) =>
				createConfirmedEncryptedDeletionBackup({
					database: source,
					environment: runtimeEnvironment
				}));
		const deleted = await deleteLocalOrder({
			database,
			orderId,
			createBackup: () => createBackup(/** @type {Database.Database} */ (database), environment)
		});
		output.log(JSON.stringify({ order_id: orderId, deleted }));
		return 0;
	} catch (error) {
		output.error(JSON.stringify({ error_code: stableErrorCode(error) }));
		return 1;
	} finally {
		if (database?.open) (options.closeDatabase ?? ((source) => source.close()))(database);
	}
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
	process.exitCode = await runDeleteLocalOrderCommand();
}
