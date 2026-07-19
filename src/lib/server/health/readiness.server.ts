import { env } from '$env/dynamic/private';
import { parsePublicConfig } from '$lib/config/public';
import { parseStyriaSupportedCountries } from '$lib/domain/destinations';
import { backupEncryptionKeyIsValid } from '$lib/server/backups/format';
import { s3BackupStoreOptionsAreValid } from '$lib/server/backups/s3.server';
import { applicationLifecycle, type ApplicationRuntime } from '$lib/server/app.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { enqueueAlert, type AlertService } from '$lib/server/monitoring/alerts.server';
import * as v from 'valibot';
import {
	open as openFile,
	readdir as readDirectory,
	stat as statPath,
	statfs as statFileSystem,
	unlink as unlinkFile
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MINIMUM_FREE_BYTES = 256n * 1024n * 1024n;
const MCP_BEARER_PATTERN = /^[a-f0-9]{64}$/;
const boundedEmailSchema = v.pipe(v.string(), v.maxLength(254), v.email());

export type ReadinessResult = {
	ready: boolean;
	checks: {
		configuration: 'ok' | 'failed';
		database: 'ok' | 'failed';
		migrations: 'ok' | 'failed';
		volume: 'ok' | 'failed';
		disk: 'ok' | 'low' | 'failed';
	};
};

type ReadinessContext = {
	database: ShopDatabase | null;
	databasePath: string;
	environment: Record<string, string | undefined>;
	migrationsDirectory: string;
	scheduler: ApplicationRuntime['scheduler'];
};

export type RuntimeReadinessContext = Omit<ReadinessContext, 'database'> & {
	database: ShopDatabase;
};

export type ReadinessOptions = {
	ignoreSchedulerLatch?: boolean;
};

type ReadinessFileHandle = {
	sync(): Promise<void>;
	close(): Promise<void>;
};

type ReadinessDirectoryEntry = {
	name: string;
	isFile(): boolean;
};

export type ReadinessDependencies = {
	getRuntime: () => ReadinessContext | null;
	validateConfiguration?: (environment: Record<string, string | undefined>) => boolean;
	quickCheck?: (database: ShopDatabase) => boolean;
	writeProbe?: (database: ShopDatabase, id: string) => boolean;
	openFile?: (path: string, flags: 'wx', mode: number) => Promise<ReadinessFileHandle>;
	readDirectory?: (path: string) => Promise<ReadinessDirectoryEntry[]>;
	statPath?: (path: string) => Promise<{ isFile(): boolean }>;
	statFileSystem?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
	unlinkFile?: (path: string) => Promise<void>;
	randomId?: () => string;
	alerts?: AlertService;
	clock?: () => Date;
};

function exactValue(environment: Record<string, string | undefined>, name: string): boolean {
	const value = environment[name];
	return (
		typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\r\n]/.test(value)
	);
}

function exactBoolean(environment: Record<string, string | undefined>, name: string): boolean {
	return environment[name] === 'true' || environment[name] === 'false';
}

function boundedExactValue(
	environment: Record<string, string | undefined>,
	name: string,
	maximum: number
): boolean {
	return exactValue(environment, name) && (environment[name]?.length ?? maximum + 1) <= maximum;
}

function validEmailValue(environment: Record<string, string | undefined>, name: string): boolean {
	const value = environment[name];
	return exactValue(environment, name) && v.safeParse(boundedEmailSchema, value).success;
}

function optionalHttpsUrl(environment: Record<string, string | undefined>, name: string): boolean {
	const value = environment[name];
	if (value === undefined) return true;
	try {
		return exactValue(environment, name) && new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

function validStyriaTimeout(environment: Record<string, string | undefined>): boolean {
	const value = environment.STYRIA_TIMEOUT_MS;
	if (value === undefined) return true;
	if (!/^[1-9]\d*$/.test(value)) return false;
	const timeout = Number(value);
	return Number.isSafeInteger(timeout) && timeout <= 10_000;
}

function validBackupConfiguration(environment: Record<string, string | undefined>): boolean {
	const forcePathStyle = environment.S3_FORCE_PATH_STYLE;
	if (forcePathStyle !== 'true' && forcePathStyle !== 'false') return false;
	const prefix = environment.S3_PREFIX;
	if (
		!exactValue(environment, 'S3_PREFIX') ||
		prefix?.split('/').some((part) => part === '.' || part === '..')
	) {
		return false;
	}
	return (
		backupEncryptionKeyIsValid(environment.BACKUP_ENCRYPTION_KEY_BASE64) &&
		s3BackupStoreOptionsAreValid({
			endpoint: environment.S3_ENDPOINT ?? '',
			region: environment.S3_REGION ?? '',
			bucket: environment.S3_BUCKET ?? '',
			accessKeyId: environment.S3_ACCESS_KEY_ID ?? '',
			secretAccessKey: environment.S3_SECRET_ACCESS_KEY ?? '',
			forcePathStyle: forcePathStyle === 'true'
		})
	);
}

function productionConfigurationIsValid(environment: Record<string, string | undefined>): boolean {
	try {
		const publicConfig = parsePublicConfig(environment);
		parseStyriaSupportedCountries(environment.STYRIA_SUPPORTED_COUNTRIES);
		if (
			!exactBoolean(environment, 'MCP_ENABLED') ||
			!exactBoolean(environment, 'SCHEDULER_ENABLED') ||
			environment.DATABASE_BOOTSTRAP !== 'false' ||
			!exactValue(environment, 'DATABASE_PATH') ||
			!isAbsolute(environment.DATABASE_PATH as string) ||
			!exactValue(environment, 'STRIPE_WEBHOOK_SECRET') ||
			!validEmailValue(environment, 'SUPPORT_EMAIL')
		) {
			return false;
		}

		const commerceEnabled = publicConfig.storefrontEnabled || publicConfig.checkoutEnabled;
		if (
			commerceEnabled &&
			(!exactValue(environment, 'STRIPE_SECRET_KEY') ||
				!exactValue(environment, 'STRIPE_PAID_SHIPPING_RATE_ID') ||
				!exactValue(environment, 'STRIPE_FREE_SHIPPING_RATE_ID'))
		) {
			return false;
		}
		if (publicConfig.checkoutEnabled && !publicConfig.storefrontEnabled) return false;

		const fulfillmentEnabled =
			environment.MCP_ENABLED === 'true' || environment.SCHEDULER_ENABLED === 'true';
		if (
			fulfillmentEnabled &&
			(!exactValue(environment, 'STRIPE_SECRET_KEY') ||
				!exactValue(environment, 'STYRIA_APP_ID') ||
				!exactValue(environment, 'STYRIA_SECRET_KEY') ||
				!exactValue(environment, 'PLUNK_SECRET_KEY') ||
				!boundedExactValue(environment, 'PLUNK_FROM_NAME', 200) ||
				!validEmailValue(environment, 'PLUNK_FROM_EMAIL') ||
				!optionalHttpsUrl(environment, 'STYRIA_BASE_URL') ||
				!optionalHttpsUrl(environment, 'PLUNK_BASE_URL') ||
				!validStyriaTimeout(environment))
		) {
			return false;
		}

		if (
			environment.MCP_ENABLED === 'true' &&
			(!MCP_BEARER_PATTERN.test(environment.MCP_BEARER_TOKEN ?? '') ||
				!exactValue(environment, 'STYRIA_BRAND_NAME'))
		) {
			return false;
		}
		if (
			environment.SCHEDULER_ENABLED === 'true' &&
			(!validEmailValue(environment, 'ADMIN_EMAIL') || !validBackupConfiguration(environment))
		) {
			return false;
		}

		return true;
	} catch {
		return false;
	}
}

function defaultQuickCheck(database: ShopDatabase): boolean {
	const rows = database.pragma('quick_check') as Array<Record<string, unknown>>;
	return rows.length === 1 && rows[0]?.quick_check === 'ok';
}

function defaultWriteProbe(database: ShopDatabase, id: string): boolean {
	const suffix = id.replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
	if (suffix.length === 0) return false;
	const table = `_readiness_write_probe_${suffix}`;
	let transactionStarted = false;

	try {
		database.exec('BEGIN IMMEDIATE');
		transactionStarted = true;
		database.exec(
			`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
			 INSERT INTO "${table}" (value) VALUES ('probe')`
		);
		database.exec('ROLLBACK');
		transactionStarted = false;
		return true;
	} catch {
		if (transactionStarted) {
			try {
				database.exec('ROLLBACK');
			} catch {
				// The stable failed database check takes precedence over cleanup detail.
			}
		}
		return false;
	}
}

function defaultRuntime(): ReadinessContext {
	const runtime: ApplicationRuntime | null = applicationLifecycle.current();
	if (runtime) {
		return {
			database: runtime.database,
			databasePath: runtime.databasePath,
			environment: runtime.environment,
			migrationsDirectory: runtime.migrationsDirectory,
			scheduler: runtime.scheduler
		};
	}
	return {
		database: null,
		databasePath: env.DATABASE_PATH ?? '',
		environment: env,
		migrationsDirectory: resolve('migrations'),
		scheduler: null
	};
}

function databaseDirectory(databasePath: string): string | null {
	return isAbsolute(databasePath) ? dirname(databasePath) : null;
}

export function createReadinessChecker(
	dependencies: ReadinessDependencies,
	options: ReadinessOptions = {}
): () => Promise<ReadinessResult> {
	const validateConfiguration =
		dependencies.validateConfiguration ?? productionConfigurationIsValid;
	const runQuickCheck = dependencies.quickCheck ?? defaultQuickCheck;
	const runWriteProbe = dependencies.writeProbe ?? defaultWriteProbe;
	const open =
		dependencies.openFile ??
		((path: string, flags: 'wx', mode: number) => openFile(path, flags, mode));
	const read =
		dependencies.readDirectory ?? ((path: string) => readDirectory(path, { withFileTypes: true }));
	const inspectPath = dependencies.statPath ?? ((path: string) => statPath(path));
	const inspectFileSystem = dependencies.statFileSystem ?? ((path: string) => statFileSystem(path));
	const remove = dependencies.unlinkFile ?? ((path: string) => unlinkFile(path));
	const randomId = dependencies.randomId ?? randomUUID;
	const alerts = dependencies.alerts ?? { enqueueAlert };
	const clock = dependencies.clock ?? (() => new Date());

	function notifyLocalFailure(
		code: 'DISK_LOW' | 'SQLITE_NOT_READY',
		subjectId: 'data-volume' | 'shop-database'
	): void {
		try {
			alerts.enqueueAlert(code, subjectId, clock());
		} catch {
			// Readiness is local-only and must never depend on outbox or Plunk availability.
		}
	}

	return async (): Promise<ReadinessResult> => {
		const context = dependencies.getRuntime();
		if (!context) {
			return {
				ready: false,
				checks: {
					configuration: 'failed',
					database: 'failed',
					migrations: 'failed',
					volume: 'failed',
					disk: 'failed'
				}
			};
		}

		const configuration = validateConfiguration(context.environment) ? 'ok' : 'failed';
		const directory = databaseDirectory(context.databasePath);

		let databaseCheck: 'ok' | 'failed' = 'failed';
		if (context.database?.open && directory !== null) {
			try {
				const databaseFile = await inspectPath(context.databasePath);
				if (
					databaseFile.isFile() &&
					runQuickCheck(context.database) &&
					runWriteProbe(context.database, randomId())
				) {
					databaseCheck = 'ok';
				}
			} catch {
				databaseCheck = 'failed';
			}
		}

		let migrations: 'ok' | 'failed' = 'failed';
		if (context.database?.open) {
			try {
				const committed = (await read(context.migrationsDirectory))
					.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
					.map((entry) => entry.name)
					.sort();
				const applied = (
					context.database.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{
						name: unknown;
					}>
				).map((row) => row.name);
				if (
					committed.length === applied.length &&
					committed.every((name, index) => name === applied[index])
				) {
					migrations = 'ok';
				}
			} catch {
				migrations = 'failed';
			}
		}

		let volume: 'ok' | 'failed' = 'failed';
		if (directory !== null) {
			const sentinel = `${context.databasePath}.readiness-${randomId()}`;
			let handle: ReadinessFileHandle | undefined;
			let created = false;
			try {
				handle = await open(sentinel, 'wx', 0o600);
				created = true;
				await handle.sync();
				await handle.close();
				handle = undefined;
				await remove(sentinel);
				created = false;
				volume = 'ok';
			} catch {
				try {
					await handle?.close();
				} catch {
					// A failed close is part of the failed volume check.
				}
				if (created) {
					try {
						await remove(sentinel);
					} catch {
						// Best-effort cleanup must not replace the stable readiness result.
					}
				}
			}
		}

		let disk: 'ok' | 'low' | 'failed' = 'failed';
		if (directory !== null) {
			try {
				const filesystem = await inspectFileSystem(directory);
				const available = BigInt(filesystem.bavail) * BigInt(filesystem.bsize);
				disk = available < MINIMUM_FREE_BYTES ? 'low' : 'ok';
			} catch {
				disk = 'failed';
			}
		}

		const checks: ReadinessResult['checks'] = {
			configuration,
			database: databaseCheck,
			migrations,
			volume,
			disk
		};
		if (disk === 'low') notifyLocalFailure('DISK_LOW', 'data-volume');
		if (databaseCheck !== 'ok' || migrations !== 'ok' || volume !== 'ok') {
			notifyLocalFailure('SQLITE_NOT_READY', 'shop-database');
		}
		return {
			ready:
				Object.values(checks).every((status) => status === 'ok') &&
				(options.ignoreSchedulerLatch ||
					context.environment.SCHEDULER_ENABLED !== 'true' ||
					Boolean(context.scheduler)),
			checks
		};
	};
}

const defaultChecker = createReadinessChecker({ getRuntime: defaultRuntime });

export function checkRuntimeReadiness(
	runtime: RuntimeReadinessContext,
	options: ReadinessOptions = {}
): Promise<ReadinessResult> {
	return createReadinessChecker(
		{
			getRuntime: () => ({
				database: runtime.database,
				databasePath: runtime.databasePath,
				environment: runtime.environment,
				migrationsDirectory: runtime.migrationsDirectory,
				scheduler: runtime.scheduler
			})
		},
		options
	)();
}

export function checkReadiness(): Promise<ReadinessResult> {
	return defaultChecker();
}
