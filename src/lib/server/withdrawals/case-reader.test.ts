import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WithdrawalPayloadV1 } from '$lib/domain/withdrawals';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteAlertService, type AlertService } from '$lib/server/monitoring/alerts.server';
import { WithdrawalCaseReader } from './case-reader.server';
import { encryptWithdrawalPayload } from './crypto.server';
import { SqliteWithdrawalRepository } from './repository.server';

const migrationsDirectory = resolve('migrations');
const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const wrongKey = Buffer.alloc(32, 255);
const now = new Date('2026-07-17T08:30:00.000Z');
const payload: WithdrawalPayloadV1 = {
	fullName: 'Private Test Name',
	receiptEmail: 'private.customer@example.com',
	enteredOrderReference: 'PRIVATE-ORDER-42',
	items: [{ description: 'Private orange hoodie', quantity: 2 }],
	reconciliation: null
};

let database: ShopDatabase;
let repository: SqliteWithdrawalRepository;
let alerts: SqliteAlertService;

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, migrationsDirectory);
	repository = new SqliteWithdrawalRepository(database);
	alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
	repository.createSubmission({
		id: 'case_123',
		reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
		scope: 'specific_items',
		encryptedPayload: encryptWithdrawalPayload(payload, 'case_123', key),
		dedupeFingerprint: 'a'.repeat(64),
		createdAt: now
	});
});

afterEach(() => closeDatabase());

function operationalSnapshot(): unknown {
	return {
		case: database.prepare('SELECT * FROM withdrawal_cases').all(),
		events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
		messages: database.prepare('SELECT * FROM withdrawal_messages').all()
	};
}

function unreadableAlerts(): unknown[] {
	return database
		.prepare(
			`SELECT alert_code, alert_subject_id, alert_observed_at
			 FROM outbox_jobs WHERE alert_code = 'WITHDRAWAL_DATA_UNREADABLE'`
		)
		.all();
}

describe('WithdrawalCaseReader', () => {
	it('decrypts and inspects an active case by public reference or claimed internal ID', () => {
		const reader = new WithdrawalCaseReader({ repository, dataKey: key, alerts });

		expect(reader.inspectActive('WDR-AAAAAAAAAAAAAAAAAAAAAA', now)).toMatchObject({
			id: 'case_123',
			reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
			payload
		});
		expect(reader.inspectActiveById('case_123', now)).toMatchObject({ payload });
		expect(unreadableAlerts()).toEqual([]);
	});

	it('alerts exactly once with public metadata after wrong-key decryption unwinds', () => {
		const before = operationalSnapshot();
		const reader = new WithdrawalCaseReader({ repository, dataKey: wrongKey, alerts });

		expect(() => reader.inspectActiveById('case_123', now)).toThrowError(
			'WITHDRAWAL_DECRYPT_FAILED'
		);
		expect(operationalSnapshot()).toEqual(before);
		expect(unreadableAlerts()).toEqual([
			{
				alert_code: 'WITHDRAWAL_DATA_UNREADABLE',
				alert_subject_id: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				alert_observed_at: now.toISOString()
			}
		]);
		expect(JSON.stringify(unreadableAlerts())).not.toContain('private.customer@example.com');
		expect(JSON.stringify(unreadableAlerts())).not.toContain('PRIVATE-ORDER-42');
	});

	it.each(['payload_tag', 'encrypted_payload'] as const)(
		'returns one stable decrypt failure for tampered %s without partial mutations',
		(column) => {
			const current = database
				.prepare(`SELECT ${column} AS value FROM withdrawal_cases WHERE id = 'case_123'`)
				.get() as { value: Buffer };
			const tampered = Buffer.from(current.value);
			tampered[0] ^= 255;
			database
				.prepare(`UPDATE withdrawal_cases SET ${column} = ? WHERE id = 'case_123'`)
				.run(tampered);
			const before = operationalSnapshot();
			const reader = new WithdrawalCaseReader({ repository, dataKey: key, alerts });

			expect(() => reader.inspectActive('WDR-AAAAAAAAAAAAAAAAAAAAAA', now)).toThrowError(
				'WITHDRAWAL_DECRYPT_FAILED'
			);
			expect(operationalSnapshot()).toEqual(before);
			expect(unreadableAlerts()).toHaveLength(1);
		}
	);

	it('treats purged cases as unavailable without reporting ciphertext corruption', () => {
		database
			.prepare(
				`UPDATE withdrawal_cases SET schema_version = NULL, encryption_key_version = NULL,
				 encrypted_payload = NULL, payload_nonce = NULL, payload_tag = NULL,
				 dedupe_fingerprint = NULL, purged_at = ? WHERE id = 'case_123'`
			)
			.run(now.toISOString());
		const reader = new WithdrawalCaseReader({ repository, dataKey: key, alerts });

		expect(() => reader.inspectActive('WDR-AAAAAAAAAAAAAAAAAAAAAA', now)).toThrowError(
			'WITHDRAWAL_CASE_NOT_FOUND'
		);
		expect(unreadableAlerts()).toEqual([]);
	});

	it('preserves the stable decrypt failure when unreadable-alert persistence fails', () => {
		const failingAlerts: AlertService = {
			enqueueAlert: vi.fn(() => {
				throw new Error('private database failure');
			})
		};
		const reader = new WithdrawalCaseReader({
			repository,
			dataKey: wrongKey,
			alerts: failingAlerts
		});

		expect(() => reader.inspectActive('WDR-AAAAAAAAAAAAAAAAAAAAAA', now)).toThrowError(
			'WITHDRAWAL_DECRYPT_FAILED'
		);
		expect(failingAlerts.enqueueAlert).toHaveBeenCalledOnce();
		expect(failingAlerts.enqueueAlert).toHaveBeenCalledWith(
			'WITHDRAWAL_DATA_UNREADABLE',
			'WDR-AAAAAAAAAAAAAAAAAAAAAA',
			now
		);
	});

	it('emits only after a failing mutation transaction has rolled back', () => {
		const observations: number[] = [];
		const observingAlerts: AlertService = {
			enqueueAlert() {
				observations.push(
					(
						database
							.prepare("SELECT revision FROM withdrawal_cases WHERE id = 'case_123'")
							.get() as {
							revision: number;
						}
					).revision
				);
			}
		};
		const reader = new WithdrawalCaseReader({ repository, dataKey: key, alerts: observingAlerts });
		const mutation = database.transaction(() => {
			database.prepare("UPDATE withdrawal_cases SET revision = 2 WHERE id = 'case_123'").run();
			throw new Error('WITHDRAWAL_DECRYPT_FAILED');
		});

		expect(() =>
			reader.withDecryptAlert('WDR-AAAAAAAAAAAAAAAAAAAAAA', now, () => mutation.immediate())
		).toThrowError('WITHDRAWAL_DECRYPT_FAILED');
		expect(observations).toEqual([1]);
	});
});
