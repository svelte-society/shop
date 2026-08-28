import { env } from '$env/dynamic/private';
import {
	inspectDeploymentReadiness,
	type DeploymentReadinessConfig,
	type RuntimeEnvironment
} from '$lib/config/deployment.server';
import { applicationLifecycle, type ApplicationRuntime } from '$lib/server/app.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { enqueueAlert, type AlertService } from '$lib/server/monitoring/alerts.server';
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
	configuration?: DeploymentReadinessConfig;
	/** @deprecated Pass a redacted `configuration` snapshot for long-lived runtimes. */
	environment?: RuntimeEnvironment;
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
	validateConfiguration?: (configuration: DeploymentReadinessConfig) => boolean;
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

function productionConfigurationIsValid(configuration: DeploymentReadinessConfig): boolean {
	return configuration.productionReady;
}

function readinessConfiguration(context: ReadinessContext): DeploymentReadinessConfig {
	return context.configuration ?? inspectDeploymentReadiness(context.environment ?? {});
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
			configuration: runtime.configuration,
			migrationsDirectory: runtime.migrationsDirectory,
			scheduler: runtime.scheduler
		};
	}
	return {
		database: null,
		databasePath: env.DATABASE_PATH ?? '',
		configuration: inspectDeploymentReadiness(env),
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
			// Readiness is local-only and must never depend on outbox or Resend availability.
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

		const deployment = readinessConfiguration(context);
		const configuration = validateConfiguration(deployment) ? 'ok' : 'failed';
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
					!deployment.features.schedulerEnabled ||
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
				configuration: readinessConfiguration(runtime),
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
