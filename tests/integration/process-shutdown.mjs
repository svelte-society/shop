import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const root = resolve(import.meta.dirname, '../..');
const migrationsDirectory = resolve(root, 'migrations');
const certificatePath = resolve(root, 'tests/fixtures/provider-cert.pem');
const privateKeyPath = resolve(root, 'tests/fixtures/provider-key.pem');
const shutdownDeadlineMs = 5_000;
const startupDeadlineMs = 15_000;

function deferred() {
	let resolvePromise;
	const promise = new Promise((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function withTimeout(promise, timeoutMs, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(label)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function reservePort() {
	const server = createTcpServer();
	await new Promise((resolvePromise, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolvePromise);
	});
	const address = server.address();
	assert(address && typeof address !== 'string');
	await new Promise((resolvePromise, reject) => {
		server.close((error) => (error ? reject(error) : resolvePromise()));
	});
	return address.port;
}

function prepareDatabase(databasePath) {
	const database = new Database(databasePath);
	database.pragma('journal_mode = WAL');
	database.pragma('foreign_keys = ON');
	database.pragma('synchronous = FULL');
	database.exec(`
		CREATE TABLE _migrations (
			name TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL
		)
	`);
	const recordMigration = database.prepare(
		'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)'
	);
	for (const name of readdirSync(migrationsDirectory)
		.filter((entry) => entry.endsWith('.sql'))
		.sort()) {
		const apply = database.transaction(() => {
			database.exec(readFileSync(join(migrationsDirectory, name), 'utf8'));
			recordMigration.run(name, '2026-07-17T00:00:00.000Z');
		});
		apply.immediate();
	}

	const seed = database.transaction(() => {
		database
			.prepare(
				`INSERT INTO checkout_drafts (
					id, stripe_checkout_session_id, contract_version, currency, total_unit_count,
					shipping_mode, created_at, expires_at, completed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				'draft_process_shutdown',
				'cs_process_shutdown',
				1,
				'eur',
				1,
				'paid',
				'2026-07-17T00:00:00.000Z',
				'2026-07-18T00:00:00.000Z',
				'2026-07-17T00:00:00.000Z'
			);
		database
			.prepare(
				`INSERT INTO orders (
					id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
					checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
					tax_amount, total_amount, destination_country, payment_status,
					fulfillment_status, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				'ord_process_shutdown',
				'cs_process_shutdown',
				'pi_process_shutdown',
				'cus_process_shutdown',
				'draft_process_shutdown',
				'eur',
				2500,
				0,
				500,
				625,
				3625,
				'SE',
				'paid',
				'pending_review',
				'2026-07-17T00:00:00.000Z'
			);
		database
			.prepare(
				`INSERT INTO order_lines (
					order_id, line_index, stripe_product_id, stripe_price_id, product_name,
					variant_label, sku, styria_product_number, design_reference, design_json,
					quantity, unit_amount, currency
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				'ord_process_shutdown',
				0,
				'prod_process_shutdown',
				'price_process_shutdown',
				'Svelte Society Tee',
				'M',
				'TEE-M',
				'STYRIA-TEE',
				'design-process-shutdown',
				'{}',
				1,
				2500,
				'eur'
			);
		database
			.prepare(
				`INSERT INTO outbox_jobs (kind, idempotency_key, order_id, next_attempt_at)
				VALUES (?, ?, ?, ?)`
			)
			.run(
				'paid-order-alert',
				'paid-order-alert:ord_process_shutdown',
				'ord_process_shutdown',
				'2020-01-01T00:00:00.000Z'
			);
	});
	seed.immediate();
	database.close();
}

async function waitForReady(port, childExit) {
	const deadline = Date.now() + startupDeadlineMs;
	let lastStatus = 0;
	let lastBody = '';
	while (Date.now() < deadline) {
		const exited = await Promise.race([
			childExit.then((result) => ({ exited: true, result })),
			new Promise((resolvePromise) => setTimeout(() => resolvePromise({ exited: false }), 50))
		]);
		if (exited.exited)
			throw new Error(`APPLICATION_EXITED_DURING_STARTUP:${JSON.stringify(exited.result)}`);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
				signal: AbortSignal.timeout(1_000)
			});
			lastStatus = response.status;
			lastBody = await response.text();
			if (lastStatus === 200) return;
		} catch {
			// The adapter may not have bound its socket yet.
		}
	}
	throw new Error(`APPLICATION_NOT_READY:${lastStatus}:${lastBody}`);
}

function assertDatabaseSettlement(databasePath) {
	const database = new Database(databasePath, { readonly: true, fileMustExist: true });
	try {
		const job = database
			.prepare(
				`SELECT attempt_count, completed_at, last_error_code, next_attempt_at
				FROM outbox_jobs WHERE idempotency_key = ?`
			)
			.get('paid-order-alert:ord_process_shutdown');
		assert.deepEqual(
			{
				attempt_count: job?.attempt_count,
				completed_at: job?.completed_at,
				last_error_code: job?.last_error_code
			},
			{ attempt_count: 1, completed_at: null, last_error_code: 'PLUNK_UNAVAILABLE' }
		);
		assert.equal(typeof job.next_attempt_at, 'string');
		assert(Date.parse(job.next_attempt_at) > Date.parse('2026-07-17T00:00:00.000Z'));
		assert.deepEqual(database.prepare('SELECT COUNT(*) AS count FROM job_leases').get(), {
			count: 0
		});
		const run = database
			.prepare(
				`SELECT result, finished_at, error_code FROM job_runs
				WHERE name = 'outbox' ORDER BY id DESC LIMIT 1`
			)
			.get();
		assert.equal(run?.result, 'completed');
		assert.equal(typeof run?.finished_at, 'string');
		assert.equal(run?.error_code, null);
		assert.deepEqual(database.pragma('quick_check'), [{ quick_check: 'ok' }]);
	} finally {
		database.close();
	}
}

const directory = mkdtempSync(join(tmpdir(), 'svelte-society-shop-shutdown-'));
const databasePath = join(directory, 'shop.sqlite');
const accepted = deferred();
const aborted = deferred();
let acceptedRequest;
let child;
let childExit;
let childExited = false;
let provider;
let output = '';

try {
	prepareDatabase(databasePath);
	provider = createHttpsServer(
		{
			key: readFileSync(privateKeyPath),
			cert: readFileSync(certificatePath)
		},
		(request) => {
			acceptedRequest ??= { method: request.method, url: request.url };
			accepted.resolve();
			request.socket.once('close', () => aborted.resolve(performance.now()));
			request.socket.on('error', () => undefined);
			// The host-only provider deliberately withholds response headers until SIGTERM aborts the client.
		}
	);
	await new Promise((resolvePromise, reject) => {
		provider.once('error', reject);
		provider.listen(0, '127.0.0.1', resolvePromise);
	});
	const providerAddress = provider.address();
	assert(providerAddress && typeof providerAddress !== 'string');
	const applicationPort = await reservePort();

	child = spawn(process.execPath, ['build'], {
		cwd: root,
		env: {
			...process.env,
			NODE_ENV: 'production',
			HOST: '127.0.0.1',
			PORT: String(applicationPort),
			ORIGIN: 'https://shop.sveltesociety.dev',
			PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
			HOST_ALLOWLIST: `shop.sveltesociety.dev,127.0.0.1:${applicationPort}`,
			DATABASE_PATH: databasePath,
			DATABASE_BOOTSTRAP: 'false',
			SCHEDULER_ENABLED: 'true',
			SHUTDOWN_TIMEOUT: '30',
			STOREFRONT_ENABLED: 'false',
			CHECKOUT_ENABLED: 'false',
			MCP_ENABLED: 'false',
			SUPPORT_EMAIL: 'merch@sveltesociety.dev',
			WITHDRAWAL_DATA_KEY: Buffer.alloc(32, 13).toString('base64'),
			SELLER_LEGAL_NAME: 'Svelte Summit AB',
			SELLER_REGISTRATION_NUMBER: 'PROCESS-SHUTDOWN',
			SELLER_VAT_NUMBER: 'PROCESS-SHUTDOWN',
			SELLER_ADDRESS_LINE1: 'Process shutdown fixture',
			SELLER_POSTAL_CODE: '00000',
			SELLER_CITY: 'Stockholm',
			SELLER_COUNTRY: 'Sweden',
			SELLER_EMAIL: 'merch@sveltesociety.dev',
			DELIVERY_ESTIMATE_EU: 'Process shutdown fixture',
			DELIVERY_ESTIMATE_US: 'Process shutdown fixture',
			POLICY_EFFECTIVE_DATE: '2026-07-17',
			STRIPE_WEBHOOK_SECRET: 'whsec_process_shutdown',
			STRIPE_SECRET_KEY: 'sk_test_process_shutdown',
			STYRIA_APP_ID: 'process-shutdown',
			STYRIA_SECRET_KEY: 'process-shutdown',
			STYRIA_BASE_URL: `https://127.0.0.1:${providerAddress.port}`,
			PLUNK_SECRET_KEY: 'process-shutdown',
			PLUNK_BASE_URL: `https://127.0.0.1:${providerAddress.port}`,
			PLUNK_FROM_NAME: 'Svelte Society Shop',
			PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
			ADMIN_EMAIL: 'merch@sveltesociety.dev',
			S3_ENDPOINT: 'https://s3.process-shutdown.test',
			S3_BUCKET: 'process-shutdown-backups',
			S3_REGION: 'eu-north-1',
			S3_ACCESS_KEY_ID: 'process-shutdown-access',
			S3_SECRET_ACCESS_KEY: 'process-shutdown-private',
			S3_PREFIX: 'shop-backups',
			S3_FORCE_PATH_STYLE: 'true',
			BACKUP_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 12).toString('base64'),
			NODE_EXTRA_CA_CERTS: certificatePath
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => (output += chunk));
	child.stderr.on('data', (chunk) => (output += chunk));
	childExit = new Promise((resolvePromise, reject) => {
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			childExited = true;
			resolvePromise({ code, signal });
		});
	});

	await waitForReady(applicationPort, childExit);
	await withTimeout(accepted.promise, startupDeadlineMs, 'PROVIDER_REQUEST_NOT_ACCEPTED');
	assert.deepEqual(acceptedRequest, { method: 'POST', url: '/v1/send' });
	const shutdownStarted = performance.now();
	assert.equal(child.kill('SIGTERM'), true);
	const [exit, providerClosedAt] = await withTimeout(
		Promise.all([childExit, aborted.promise]),
		shutdownDeadlineMs,
		'APPLICATION_SHUTDOWN_DEADLINE_EXCEEDED'
	);
	const shutdownDurationMs = performance.now() - shutdownStarted;

	assert.deepEqual(exit, { code: 0, signal: null });
	assert(providerClosedAt >= shutdownStarted);
	assert(shutdownDurationMs < shutdownDeadlineMs);
	const schedulerLine = output.indexOf('APPLICATION_SCHEDULER_STOPPED');
	const databaseLine = output.indexOf('APPLICATION_DATABASE_CLOSED');
	assert(schedulerLine >= 0, `Missing scheduler shutdown log:\n${output}`);
	assert(databaseLine > schedulerLine, `Shutdown logs out of order:\n${output}`);
	assert.match(output, /"scheduler_count":1[^\n]*"code":"APPLICATION_SCHEDULER_STOPPED"/u);
	assert.match(output, /"scheduler_count":1[^\n]*"code":"APPLICATION_DATABASE_CLOSED"/u);
	assertDatabaseSettlement(databasePath);
	console.log(`Host process SIGTERM proof passed in ${Math.round(shutdownDurationMs)}ms.`);
} catch (error) {
	if (output) console.error(output);
	throw error;
} finally {
	if (child && !childExited) {
		child.kill('SIGTERM');
		try {
			await withTimeout(childExit, 2_000, 'APPLICATION_CLEANUP_TERM_TIMEOUT');
		} catch {
			child.kill('SIGKILL');
			await withTimeout(childExit, 2_000, 'APPLICATION_CLEANUP_KILL_TIMEOUT');
		}
	}
	if (provider) {
		provider.closeAllConnections();
		await new Promise((resolvePromise) => provider.close(() => resolvePromise()));
	}
	rmSync(directory, { recursive: true, force: true });
}
