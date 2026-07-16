import Database from 'better-sqlite3';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createJiti } from 'jiti';

const required = [
	'SHOP_DB_PATH',
	'CLAIM_READY_PATH',
	'CLAIM_START_PATH',
	'CLAIM_ATTEMPT_PATH',
	'CLAIM_RESULT_PATH',
	'CLAIM_NOW'
];

for (const name of required) {
	if (!process.env[name]) throw new Error(`MISSING_${name}`);
}

const jiti = createJiti(import.meta.url, {
	alias: { $lib: fileURLToPath(new URL('../../', import.meta.url)) }
});
const { SqliteOutboxRepository } = await jiti.import('./outbox.server.ts');
const database = new Database(process.env.SHOP_DB_PATH);

try {
	database.pragma('foreign_keys = ON');
	database.pragma('busy_timeout = 5000');
	const repository = new SqliteOutboxRepository(database);
	writeFileSync(process.env.CLAIM_READY_PATH, 'ready', { flag: 'wx' });

	const deadline = Date.now() + 5_000;
	while (!existsSync(process.env.CLAIM_START_PATH)) {
		if (Date.now() >= deadline) throw new Error('CLAIM_BARRIER_TIMEOUT');
		await delay(2);
	}

	writeFileSync(process.env.CLAIM_ATTEMPT_PATH, 'attempting', { flag: 'wx' });
	const claimed = repository.claimDue(new Date(process.env.CLAIM_NOW), 1);
	writeFileSync(
		process.env.CLAIM_RESULT_PATH,
		JSON.stringify(claimed.map((job) => job.idempotencyKey)),
		{ flag: 'wx' }
	);
} finally {
	database.close();
}
