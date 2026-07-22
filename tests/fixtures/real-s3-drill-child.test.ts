import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { SqliteBackupService } from '$lib/server/backups/service.server';
import { createS3BackupStore } from '$lib/server/backups/s3.server';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { checkRuntimeReadiness } from '$lib/server/health/readiness.server';
import { createRestoreStoreFromEnvironment, restoreBackup } from '../../scripts/restore-backup.mjs';

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`TEST_CHILD_ENV_MISSING:${name}`);
	return value;
}

const root = required('REAL_S3_DRILL_ROOT');
const endpoint = required('REAL_S3_ENDPOINT');
const encryptionKey = required('REAL_S3_ENCRYPTION_KEY');
const bucket = 'restore-backups';
const prefix = 'drill-bucket';
const dataDirectory = join(root, 'data');
const databasePath = join(dataDirectory, 'shop.sqlite');
const migrationsDirectory = resolve('migrations');

afterAll(() => {
	closeDatabase();
});

it('runs production backup and restore clients against the parent HTTPS fixture', async () => {
	rmSync(dataDirectory, { recursive: true, force: true });
	mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
	const sourcePath = join(root, 'source.sqlite');
	const source = openDatabase(sourcePath);
	migrate(source, migrationsDirectory);
	source.exec('CREATE TABLE restore_proof (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)');
	const insert = source.prepare('INSERT INTO restore_proof (marker) VALUES (?)');
	insert.run('first recovered row');
	insert.run('second recovered row');
	insert.run('third recovered row');

	const configuration = {
		endpoint,
		region: 'eu-north-1',
		bucket,
		accessKeyId: 'fixture-access-key',
		secretAccessKey: 'fixture-secret-key',
		forcePathStyle: true
	};
	const service = new SqliteBackupService({
		database: source,
		store: createS3BackupStore(configuration),
		encryptionKeyBase64: encryptionKey,
		prefix,
		temporaryDirectory: join(root, 'backup-temp')
	});
	const { objectKey: key } = await service.run(new Date('2026-07-17T02:30:45.000Z'));
	closeDatabase();

	const current = openDatabase(databasePath);
	migrate(current, migrationsDirectory);
	current.exec('CREATE TABLE current_only (marker TEXT NOT NULL)');
	current.prepare('INSERT INTO current_only (marker) VALUES (?)').run('pre-restore current row');
	closeDatabase();

	const restoreStore = createRestoreStoreFromEnvironment({
		S3_ENDPOINT: endpoint,
		S3_BUCKET: bucket,
		S3_REGION: configuration.region,
		S3_ACCESS_KEY_ID: configuration.accessKeyId,
		S3_SECRET_ACCESS_KEY: configuration.secretAccessKey,
		S3_FORCE_PATH_STYLE: 'true'
	});
	await restoreBackup({
		key,
		encryptionKeyBase64: encryptionKey,
		dataDirectory,
		store: restoreStore,
		now: () => new Date('2026-07-17T04:05:06.000Z')
	});

	const restored = new Database(databasePath, { fileMustExist: true });
	try {
		migrate(restored, migrationsDirectory);
		expect(restored.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
		expect(restored.prepare('SELECT COUNT(*) AS count FROM restore_proof').get()).toEqual({
			count: 3
		});
		expect(restored.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({
			count: 6
		});
		const readiness = await checkRuntimeReadiness({
			database: restored,
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
				STRIPE_WEBHOOK_SECRET: 'whsec_real_s3_drill',
				STYRIA_SUPPORTED_COUNTRIES: 'SE,JP,TW',
				DATABASE_PATH: databasePath
			}
		});
		expect(readiness.ready).toBe(true);
	} finally {
		restored.close();
	}
});
