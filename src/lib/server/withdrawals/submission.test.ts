import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeWithdrawalInput, type CanonicalWithdrawalInput } from '$lib/domain/withdrawals';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { decryptWithdrawalPayload } from './crypto.server';
import { SqliteWithdrawalRepository } from './repository.server';
import { WithdrawalSubmissionService, type WithdrawalReceiptDispatcher } from './submission.server';

const migrationsDirectory = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const now = new Date('2026-07-17T08:30:00.000Z');

function input(overrides: Partial<CanonicalWithdrawalInput> = {}): CanonicalWithdrawalInput {
	return {
		fullName: 'Zoë Ångström',
		receiptEmail: 'zoe@example.com',
		enteredOrderReference: 'ORDER-123',
		scope: 'specific_items',
		items: [{ description: 'Orange hoodie', quantity: 2 }],
		...overrides
	};
}

type DispatchMode = 'delivered' | 'queued' | 'failed' | 'throw';

class PersistingDispatcher implements WithdrawalReceiptDispatcher {
	readonly calls: Array<{
		messageId: number;
		now: Date;
		signal: AbortSignal | undefined;
		committedCaseCount: number;
	}> = [];

	constructor(
		private readonly mode: DispatchMode,
		private readonly repository: SqliteWithdrawalRepository,
		private readonly database: ShopDatabase
	) {}

	async attemptReceipt(
		messageId: number,
		attemptedAt: Date,
		signal?: AbortSignal
	): Promise<'delivered' | 'queued' | 'failed'> {
		this.calls.push({
			messageId,
			now: attemptedAt,
			signal,
			committedCaseCount: (
				this.database.prepare('SELECT COUNT(*) AS count FROM withdrawal_cases').get() as {
					count: number;
				}
			).count
		});
		if (this.mode === 'throw') throw new Error('PLUNK_UNAVAILABLE');
		if (this.mode === 'queued') return 'queued';
		const claimed = this.repository.claimMessage(messageId, attemptedAt);
		if (!claimed) throw new Error('TEST_MESSAGE_NOT_CLAIMED');
		if (this.mode === 'delivered') {
			this.repository.completeMessage(messageId, claimed.attemptCount, 'delivery_123', attemptedAt);
			return 'delivered';
		}
		this.repository.failMessagePermanently(
			messageId,
			claimed.attemptCount,
			'PLUNK_RECIPIENT_REJECTED',
			attemptedAt
		);
		return 'failed';
	}
}

let database: ShopDatabase;
let repository: SqliteWithdrawalRepository;

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, migrationsDirectory);
	repository = new SqliteWithdrawalRepository(database);
});

afterEach(() => {
	closeDatabase();
});

function service(dispatcher: WithdrawalReceiptDispatcher, dataKey = key) {
	return new WithdrawalSubmissionService({ repository, dispatcher, dataKey });
}

function rowCount(table: string): number {
	return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
		.count;
}

describe('WithdrawalSubmissionService', () => {
	it('canonicalizes before encryption and returns only the committed public result fields', async () => {
		const dispatcher = new PersistingDispatcher('queued', repository, database);
		const raw = {
			fullName: '  Zoe\u0308   A\u030Angstro\u0308m  ',
			receiptEmail: '  Zoe@example.COM  ',
			enteredOrderReference: '  ORDER-123   EU  ',
			scope: 'specific_items',
			items: [{ description: '  Orange   hoodie  ', quantity: 2 }]
		} as CanonicalWithdrawalInput;

		const result = await service(dispatcher).submit(raw, now);

		expect(result).toEqual({
			reference: expect.stringMatching(/^WDR-[A-Za-z0-9_-]{22}$/u),
			createdAt: now,
			scope: 'specific_items',
			enteredOrderReference: 'ORDER-123 EU',
			deliveryState: 'queued'
		});
		expect(Object.keys(result).sort()).toEqual([
			'createdAt',
			'deliveryState',
			'enteredOrderReference',
			'reference',
			'scope'
		]);
		const stored = repository.loadEncryptedByReference(result.reference);
		expect(stored).not.toBeNull();
		const { scope: _scope, ...canonicalPayload } = normalizeWithdrawalInput(raw);
		expect(_scope).toBe('specific_items');
		expect(decryptWithdrawalPayload(stored!.encryptedPayload, stored!.id, key)).toEqual({
			...canonicalPayload,
			reconciliation: null
		});
		expect(dispatcher.calls).toEqual([
			{ messageId: 1, now, signal: undefined, committedCaseCount: 1 }
		]);
	});

	it.each(['delivered', 'queued', 'failed'] as const)(
		'commits before dispatch and returns the %s receipt state',
		async (mode) => {
			const dispatcher = new PersistingDispatcher(mode, repository, database);
			const controller = new AbortController();

			const result = await service(dispatcher).submit(input(), now, controller.signal);

			expect(result.deliveryState).toBe(mode);
			expect(dispatcher.calls).toEqual([
				{ messageId: 1, now, signal: controller.signal, committedCaseCount: 1 }
			]);
			const message = repository.getMessage(1);
			if (mode === 'delivered') {
				expect(message).toMatchObject({
					providerDeliveryId: 'delivery_123',
					completedAt: now,
					lastErrorCode: null
				});
			} else if (mode === 'failed') {
				expect(message).toMatchObject({
					providerDeliveryId: null,
					completedAt: now,
					lastErrorCode: 'PLUNK_RECIPIENT_REJECTED'
				});
			} else {
				expect(message).toMatchObject({ completedAt: null, providerDeliveryId: null });
			}
		}
	);

	it('returns a committed queued case when the dispatcher throws after commit', async () => {
		const dispatcher = new PersistingDispatcher('throw', repository, database);

		await expect(service(dispatcher).submit(input(), now)).resolves.toMatchObject({
			deliveryState: 'queued',
			createdAt: now
		});
		expect(rowCount('withdrawal_cases')).toBe(1);
		expect(repository.getMessage(1)).toMatchObject({ completedAt: null });
	});

	it.each(['delivered', 'queued', 'failed'] as const)(
		'returns the persisted duplicate %s state without redispatch',
		async (mode) => {
			const dispatcher = new PersistingDispatcher(mode, repository, database);
			const submission = service(dispatcher);
			const first = await submission.submit(input(), now);

			const duplicate = await submission.submit(input(), new Date(now.getTime() + 60_000));

			expect(duplicate).toEqual(first);
			expect(dispatcher.calls).toHaveLength(1);
			expect(rowCount('withdrawal_cases')).toBe(1);
			expect(rowCount('withdrawal_messages')).toBe(1);
		}
	);

	it('propagates encryption failure without creating a case or dispatching', async () => {
		const dispatcher = new PersistingDispatcher('queued', repository, database);

		await expect(service(dispatcher, Buffer.alloc(31)).submit(input(), now)).rejects.toThrowError(
			'WITHDRAWAL_ENCRYPT_FAILED'
		);
		expect(rowCount('withdrawal_cases')).toBe(0);
		expect(dispatcher.calls).toEqual([]);
	});

	it('propagates repository failure and leaves the atomic submission absent', async () => {
		database.exec(`
			CREATE TRIGGER reject_withdrawal_event BEFORE INSERT ON withdrawal_case_events
			BEGIN
				SELECT RAISE(ABORT, 'test late failure');
			END
		`);
		const dispatcher = new PersistingDispatcher('queued', repository, database);

		await expect(service(dispatcher).submit(input(), now)).rejects.toThrowError(
			'WITHDRAWAL_SUBMISSION_FAILED'
		);
		for (const table of [
			'withdrawal_cases',
			'withdrawal_messages',
			'withdrawal_case_events',
			'outbox_jobs'
		]) {
			expect(rowCount(table), table).toBe(0);
		}
		expect(dispatcher.calls).toEqual([]);
	});
});
