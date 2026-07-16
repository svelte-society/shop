import Database from 'better-sqlite3';
import { existsSync, watch, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { RepositoryError } from '$lib/domain/orders';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteFulfillmentRepository } from './repository.server';

type ContenderConfig = {
	role: 'holder' | 'waiter';
	databasePath: string;
	readyPath: string;
	startPath: string;
	attemptPath: string;
	lockPath: string;
	releasePath: string;
	probePath: string;
	resultPath: string;
};

function configFromEnvironment(): ContenderConfig | null {
	if (process.env.FULFILLMENT_APPROVAL_CONTENDER !== 'true') return null;
	const role = process.env.FULFILLMENT_CONTENDER_ROLE;
	const values = {
		databasePath: process.env.FULFILLMENT_DATABASE_PATH,
		readyPath: process.env.FULFILLMENT_READY_PATH,
		startPath: process.env.FULFILLMENT_START_PATH,
		attemptPath: process.env.FULFILLMENT_ATTEMPT_PATH,
		lockPath: process.env.FULFILLMENT_LOCK_PATH,
		releasePath: process.env.FULFILLMENT_RELEASE_PATH,
		probePath: process.env.FULFILLMENT_PROBE_PATH,
		resultPath: process.env.FULFILLMENT_RESULT_PATH
	};
	if (
		(role !== 'holder' && role !== 'waiter') ||
		Object.values(values).some((value) => typeof value !== 'string' || value.length === 0)
	) {
		throw new Error('FULFILLMENT_CONTENDER_CONFIG_INVALID');
	}
	return { role, ...(values as Record<keyof typeof values, string>) };
}

function configure(database: ShopDatabase): void {
	database.pragma('journal_mode = WAL');
	database.pragma('foreign_keys = ON');
	database.pragma('busy_timeout = 5000');
	database.pragma('synchronous = FULL');
}

function waitForPath(path: string, timeoutMilliseconds = 10_000): Promise<void> {
	if (existsSync(path)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		let settled = false;
		const watcher = watch(dirname(path), check);
		const timeout = setTimeout(
			() => finish(new Error('CONTENDER_BARRIER_TIMEOUT')),
			timeoutMilliseconds
		);

		function finish(error?: Error): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			watcher.close();
			if (error) reject(error);
			else resolve();
		}

		function check(): void {
			if (existsSync(path)) finish();
		}

		check();
	});
}

function waitForPathSynchronously(path: string, timeoutMilliseconds = 10_000): void {
	const deadline = Date.now() + timeoutMilliseconds;
	const waitState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error('CONTENDER_LOCK_RELEASE_TIMEOUT');
		Atomics.wait(waitState, 0, 0, 2);
	}
}

function startBlockedCallProbe(path: string): {
	state: Int32Array<SharedArrayBuffer>;
	completion: Promise<void>;
} {
	const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
	const state = new Int32Array(buffer);
	const worker = new Worker(
		`const { writeFileSync } = require('node:fs');
		const { workerData } = require('node:worker_threads');
		const state = new Int32Array(workerData.buffer);
		if (Atomics.wait(state, 0, 0, 250) === 'timed-out') {
			writeFileSync(workerData.path, 'blocked');
		}`,
		{ eval: true, workerData: { buffer, path } }
	);
	const completion = new Promise<void>((resolve, reject) => {
		worker.once('error', reject);
		worker.once('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`CONTENDER_PROBE_FAILED:${code}`));
		});
	});
	return { state, completion };
}

const config = configFromEnvironment();

it('stays dormant without coordination or executes one independent approval contender', async () => {
	if (config === null) {
		expect(config).toBeNull();
		return;
	}
	const database = new Database(config.databasePath);
	configure(database);
	database.function('hold_approval_lock', () => {
		if (config.role !== 'holder') return 0;
		writeFileSync(config.lockPath, 'locked');
		waitForPathSynchronously(config.releasePath);
		return 0;
	});

	try {
		writeFileSync(config.readyPath, 'ready');
		await waitForPath(config.startPath);
		const probe = config.role === 'waiter' ? startBlockedCallProbe(config.probePath) : null;
		writeFileSync(config.attemptPath, 'attempting');
		let outcome: 'succeeded' | string;
		try {
			new SqliteFulfillmentRepository(database).beginSubmission(
				'order_one',
				'approval_one',
				'payload-hash-one',
				new Date('2026-07-16T08:30:00.000Z')
			);
			outcome = 'succeeded';
		} catch (error) {
			if (!(error instanceof RepositoryError)) throw error;
			outcome = error.code;
		} finally {
			if (probe) {
				Atomics.store(probe.state, 0, 1);
				Atomics.notify(probe.state, 0);
				await probe.completion;
			}
		}
		writeFileSync(config.resultPath, JSON.stringify({ role: config.role, outcome }));
		expect(outcome).toBe(config.role === 'holder' ? 'succeeded' : 'SUBMISSION_APPROVAL_USED');
	} finally {
		database.close();
	}
}, 15_000);
