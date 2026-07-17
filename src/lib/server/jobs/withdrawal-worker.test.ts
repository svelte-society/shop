import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WithdrawalPayloadV1 } from '$lib/domain/withdrawals';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteAlertService } from '$lib/server/monitoring/alerts.server';
import { PlunkError, type PlunkGateway, type PlunkSendInput } from '$lib/server/plunk/gateway';
import { WithdrawalCaseReader } from '$lib/server/withdrawals/case-reader.server';
import { encryptWithdrawalPayload } from '$lib/server/withdrawals/crypto.server';
import {
	SqliteWithdrawalRepository,
	type WithdrawalMessageKind
} from '$lib/server/withdrawals/repository.server';
import { WithdrawalMessageWorker } from './withdrawal-worker.server';

const migrationsDirectory = resolve('migrations');
const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const start = new Date('2026-07-17T08:30:00.000Z');
const payload: WithdrawalPayloadV1 = {
	fullName: 'Private Test Name',
	receiptEmail: 'private.customer@example.com',
	enteredOrderReference: 'PRIVATE-ORDER-42',
	items: [{ description: 'Private orange hoodie', quantity: 2 }],
	reconciliation: {
		internalOrderReference: 'ord_private',
		countryCode: 'SE',
		customerInstructions: 'Use the prepaid label and the address printed on it.',
		returnOutcome: null,
		parcelReference: null
	}
};

let database: ShopDatabase;
let repository: SqliteWithdrawalRepository;
let alerts: SqliteAlertService;
let reader: WithdrawalCaseReader;

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, migrationsDirectory);
	repository = new SqliteWithdrawalRepository(database);
	alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
	reader = new WithdrawalCaseReader({ repository, dataKey: key, alerts });
	repository.createSubmission({
		id: 'case_123',
		reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
		scope: 'specific_items',
		encryptedPayload: encryptWithdrawalPayload(payload, 'case_123', key),
		dedupeFingerprint: 'a'.repeat(64),
		createdAt: start
	});
});

afterEach(() => closeDatabase());

function insertMessage(kind: Exclude<WithdrawalMessageKind, 'receipt'>, attemptCount = 0): number {
	let resendOf: number | null = null;
	if (kind === 'resend') {
		const original = database
			.prepare(
				`INSERT INTO withdrawal_messages
				 (case_id, kind, resend_of_message_id, idempotency_key, attempt_count, next_attempt_at,
				  provider_delivery_id, completed_at)
				 VALUES ('case_123', 'eligible_instructions', NULL, ?, 0, ?, 'setup_delivery', ?)`
			)
			.run(
				`withdrawal:eligible:original:${attemptCount}`,
				start.toISOString(),
				start.toISOString()
			);
		resendOf = Number(original.lastInsertRowid);
	}
	const result = database
		.prepare(
			`INSERT INTO withdrawal_messages
			 (case_id, kind, resend_of_message_id, idempotency_key, attempt_count, next_attempt_at)
			 VALUES ('case_123', ?, ?, ?, ?, ?)`
		)
		.run(kind, resendOf, `withdrawal:${kind}:${attemptCount}`, attemptCount, start.toISOString());
	return Number(result.lastInsertRowid);
}

function messageId(kind: WithdrawalMessageKind, attemptCount = 0): number {
	if (kind === 'receipt') {
		database
			.prepare('UPDATE withdrawal_messages SET attempt_count = ?, next_attempt_at = ? WHERE id = 1')
			.run(attemptCount, start.toISOString());
		return 1;
	}
	database
		.prepare(
			"UPDATE withdrawal_messages SET provider_delivery_id = 'setup_receipt', completed_at = ? WHERE id = 1"
		)
		.run(start.toISOString());
	return insertMessage(kind, attemptCount);
}

function worker(plunk: PlunkGateway, caseReader = reader): WithdrawalMessageWorker {
	return new WithdrawalMessageWorker({
		repository,
		reader: caseReader,
		plunk,
		alerts,
		from: { name: 'Svelte Society Shop', email: 'merch@sveltesociety.dev' },
		supportEmail: 'merch@sveltesociety.dev',
		productionOrigin: new URL('https://merch.sveltesociety.dev'),
		seller: {
			legalName: 'Svelte Society Merch AB',
			registrationNumber: '559999-0000',
			addressLine1: 'Registered Street 1',
			postalCode: '111 11',
			city: 'Stockholm',
			country: 'Sweden',
			email: 'merch@sveltesociety.dev'
		}
	});
}

function alertRows(code: string): unknown[] {
	return database
		.prepare(
			`SELECT alert_code, alert_subject_id, alert_observed_at
			 FROM outbox_jobs WHERE alert_code = ? ORDER BY id`
		)
		.all(code);
}

describe('WithdrawalMessageWorker', () => {
	it('claims before asking the centralized reader to decrypt and persists Plunk acceptance', async () => {
		const inspectActiveById = reader.inspectActiveById.bind(reader);
		const inspect = vi.spyOn(reader, 'inspectActiveById');
		const send = vi.fn(async (message: PlunkSendInput) => {
			expect(message.to).toBe('private.customer@example.com');
			expect(message.subject).toBe('Withdrawal notice received — WDR-AAAAAAAAAAAAAAAAAAAAAA');
			return { deliveryId: 'delivery_accepted_123' };
		});
		inspect.mockImplementationOnce((caseId, now) => {
			expect(repository.getMessage(1)?.attemptCount).toBe(1);
			return inspectActiveById(caseId, now);
		});

		await expect(worker({ send }).attemptReceipt(1, start)).resolves.toBe('delivered');
		expect(inspect).toHaveBeenCalledWith('case_123', start);
		expect(repository.getMessage(1)).toMatchObject({
			attemptCount: 1,
			providerDeliveryId: 'delivery_accepted_123',
			completedAt: start,
			lastErrorCode: null
		});
	});

	it('settles an accepted response exactly once when shutdown aborts after provider resolution', async () => {
		const controller = new AbortController();
		const send = vi.fn(
			() =>
				new Promise<{ deliveryId: string }>((resolve) => {
					resolve({ deliveryId: 'delivery_accepted_before_abort' });
					controller.abort(new Error('late scheduler shutdown'));
				})
		);

		await expect(worker({ send }).attemptReceipt(1, start, controller.signal)).resolves.toBe(
			'delivered'
		);

		expect(send).toHaveBeenCalledOnce();
		expect(repository.getMessage(1)).toMatchObject({
			attemptCount: 1,
			providerDeliveryId: 'delivery_accepted_before_abort',
			completedAt: start,
			lastErrorCode: null
		});
		expect(repository.claimMessage(1, new Date(start.getTime() + 5 * 60_000))).toBeNull();
		expect(database.prepare('SELECT COUNT(*) AS count FROM withdrawal_messages').get()).toEqual({
			count: 1
		});
	});

	it('treats a malformed accepted delivery ID as a first-attempt invalid response', async () => {
		const send = vi.fn(async () => ({ deliveryId: 'malformed delivery id' }));

		await expect(worker({ send }).attemptReceipt(1, start)).resolves.toBe('queued');

		expect(repository.getMessage(1)).toMatchObject({
			attemptCount: 1,
			providerDeliveryId: null,
			completedAt: null,
			lastErrorCode: 'PLUNK_RESPONSE_INVALID',
			nextAttemptAt: new Date(start.getTime() + 60_000)
		});
		expect(alertRows('WITHDRAWAL_MESSAGE_UNSENT')).toEqual([]);
	});

	it('keeps a fifth malformed delivery ID retryable and emits the generic unsent alert', async () => {
		messageId('receipt', 4);
		const send = vi.fn(async () => ({ deliveryId: '<malformed-delivery-id>' }));

		await expect(worker({ send }).attemptReceipt(1, start)).resolves.toBe('queued');

		expect(repository.getMessage(1)).toMatchObject({
			attemptCount: 5,
			providerDeliveryId: null,
			completedAt: null,
			lastErrorCode: 'PLUNK_RESPONSE_INVALID',
			nextAttemptAt: new Date(start.getTime() + 60 * 60_000)
		});
		expect(alertRows('WITHDRAWAL_MESSAGE_UNSENT')).toEqual([
			{
				alert_code: 'WITHDRAWAL_MESSAGE_UNSENT',
				alert_subject_id: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				alert_observed_at: start.toISOString()
			}
		]);
	});

	it('backs transient Plunk failures off by 1, 5, 15, then 60 minutes capped at 60', async () => {
		const send = vi.fn(async () => {
			throw new PlunkError('PLUNK_TIMEOUT');
		});
		const delivery = worker({ send });
		const delays = [1, 5, 15, 60, 60];
		let attemptedAt = start;

		for (const [index, minutes] of delays.entries()) {
			await expect(delivery.attemptReceipt(1, attemptedAt)).resolves.toBe('queued');
			const persisted = repository.getMessage(1);
			expect(persisted?.attemptCount).toBe(index + 1);
			expect(persisted?.nextAttemptAt).toEqual(new Date(attemptedAt.getTime() + minutes * 60_000));
			expect(persisted?.lastErrorCode).toBe('PLUNK_TIMEOUT');
			attemptedAt = persisted!.nextAttemptAt;
		}
	});

	it.each([
		'receipt',
		'eligible_instructions',
		'ineligible_decision',
		'support_handoff',
		'resend'
	] as const)('permanently settles and immediately alerts a rejected %s', async (kind) => {
		const id = messageId(kind);
		const send = vi.fn(async () => {
			throw new PlunkError('PLUNK_REQUEST_REJECTED');
		});
		const delivery = worker({ send });

		if (kind === 'receipt') {
			await expect(delivery.attemptReceipt(id, start)).resolves.toBe('failed');
		} else {
			await delivery.drain(start, 10);
		}
		expect(repository.getMessage(id)).toMatchObject({
			attemptCount: 1,
			providerDeliveryId: null,
			completedAt: start,
			lastErrorCode: 'PLUNK_REQUEST_REJECTED'
		});
		expect(alertRows('WITHDRAWAL_MESSAGE_UNSENT')).toEqual([
			{
				alert_code: 'WITHDRAWAL_MESSAGE_UNSENT',
				alert_subject_id: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				alert_observed_at: start.toISOString()
			}
		]);
	});

	it.each([
		'receipt',
		'eligible_instructions',
		'ineligible_decision',
		'support_handoff',
		'resend'
	] as const)('alerts the fifth transient %s attempt while keeping it retryable', async (kind) => {
		const id = messageId(kind, 4);
		const send = vi.fn(async () => {
			throw new PlunkError('PLUNK_UNAVAILABLE');
		});

		await worker({ send }).drain(start, 10);

		expect(repository.getMessage(id)).toMatchObject({
			attemptCount: 5,
			providerDeliveryId: null,
			completedAt: null,
			lastErrorCode: 'PLUNK_UNAVAILABLE',
			nextAttemptAt: new Date(start.getTime() + 60 * 60_000)
		});
		expect(alertRows('WITHDRAWAL_MESSAGE_UNSENT')).toHaveLength(1);
	});

	it('rejects a stale expected-attempt settlement instead of overwriting a newer claim', async () => {
		const send = vi.fn(async () => {
			database.prepare('UPDATE withdrawal_messages SET attempt_count = 2 WHERE id = 1').run();
			return { deliveryId: 'delivery_stale' };
		});

		await expect(worker({ send }).attemptReceipt(1, start)).rejects.toThrowError(
			'WITHDRAWAL_MESSAGE_SETTLEMENT_CONFLICT'
		);
		expect(repository.getMessage(1)).toMatchObject({
			attemptCount: 2,
			completedAt: null,
			providerDeliveryId: null
		});
	});

	it('leaves an aborted provider call unsettled and claimable after the five-minute lease', async () => {
		const controller = new AbortController();
		const send = vi.fn(
			(_message: PlunkSendInput, signal?: AbortSignal): Promise<{ deliveryId: string }> =>
				new Promise((_, reject) => {
					signal?.addEventListener('abort', () => reject(new PlunkError('PLUNK_UNAVAILABLE')), {
						once: true
					});
				})
		);
		const attempt = worker({ send }).attemptReceipt(1, start, controller.signal);
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
		controller.abort(new Error('scheduler stopping'));

		await expect(attempt).rejects.toThrow('scheduler stopping');
		expect(repository.getMessage(1)).toMatchObject({
			attemptCount: 1,
			completedAt: null,
			lastErrorCode: null,
			nextAttemptAt: new Date(start.getTime() + 5 * 60_000)
		});
		expect(repository.claimMessage(1, new Date(start.getTime() + 5 * 60_000))?.attemptCount).toBe(
			2
		);
	});

	it('never persists recipient, rendered content, or provider error bodies in message rows', async () => {
		const send = vi.fn(async () => {
			throw new Error('private.customer@example.com <p>rendered private body</p>');
		});

		await expect(worker({ send }).attemptReceipt(1, start)).resolves.toBe('queued');
		const columns = (
			database.prepare("PRAGMA table_info('withdrawal_messages')").all() as Array<{ name: string }>
		).map((column) => column.name);
		const serialized = JSON.stringify(database.prepare('SELECT * FROM withdrawal_messages').all());
		expect(columns).not.toContain('recipient');
		expect(columns).not.toContain('body');
		expect(serialized).not.toContain('private.customer@example.com');
		expect(serialized).not.toContain('rendered private body');
		expect(repository.getMessage(1)?.lastErrorCode).toBe('WITHDRAWAL_MESSAGE_FAILED');
	});
});
