import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteAlertService } from '$lib/server/monitoring/alerts.server';
import { createLogger } from '$lib/server/logging/logger.server';
import { WithdrawalCaseReader } from './case-reader.server';
import { encryptWithdrawalPayload } from './crypto.server';
import { SqliteWithdrawalRepository } from './repository.server';
import { WithdrawalWorkflowService } from './workflow.server';

const migrationsDirectory = resolve('migrations');
const dataKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const submittedAt = new Date('2026-07-17T08:30:00.000Z');
const actionAt = new Date('2026-07-17T10:00:00.000Z');
const reference = 'WDR-AAAAAAAAAAAAAAAAAAAAAA';
const seller = {
	legalName: 'Svelte Society Merch AB',
	registrationNumber: '559999-0000',
	addressLine1: 'Registered Street 1',
	postalCode: '111 11',
	city: 'Stockholm',
	country: 'Sweden',
	email: 'merch@sveltesociety.dev'
};

let database: ShopDatabase;
let repository: SqliteWithdrawalRepository;
let reader: WithdrawalCaseReader;
let workflow: WithdrawalWorkflowService;

function seedSubmittedCase(): void {
	repository.createSubmission({
		id: 'case_123',
		reference,
		scope: 'specific_items',
		encryptedPayload: encryptWithdrawalPayload(
			{
				fullName: 'Private Test Name',
				receiptEmail: 'private.customer@example.com',
				enteredOrderReference: 'PRIVATE-ORDER-42',
				items: [{ description: 'Private orange hoodie', quantity: 2 }],
				reconciliation: null
			},
			'case_123',
			dataKey
		),
		dedupeFingerprint: 'a'.repeat(64),
		createdAt: submittedAt
	});
}

function advanceToAwaitingReturn(): void {
	workflow.beginReview({
		reference,
		expectedStatus: 'submitted',
		expectedRevision: 1,
		now: actionAt
	});
	workflow.recordEligibility({
		reference,
		expectedStatus: 'reviewing',
		expectedRevision: 2,
		decision: 'eligible_eu',
		internalOrderReference: 'internal-order-42',
		countryCode: 'SE',
		customerInstructions: 'Use the prepaid label and the address printed on it.',
		now: new Date('2026-07-17T10:05:00.000Z')
	});
}

function advanceToDecision(decision: 'ineligible_non_eu' | 'support_handling'): void {
	workflow.beginReview({
		reference,
		expectedStatus: 'submitted',
		expectedRevision: 1,
		now: actionAt
	});
	workflow.recordEligibility({
		reference,
		expectedStatus: 'reviewing',
		expectedRevision: 2,
		decision,
		internalOrderReference: 'internal-order-42',
		countryCode: decision === 'ineligible_non_eu' ? 'US' : 'SE',
		now: new Date('2026-07-17T10:05:00.000Z')
	});
}

function advanceToStatus(
	status:
		'submitted' | 'reviewing' | 'awaiting_return' | 'ineligible' | 'support_handling' | 'closed'
): void {
	if (status === 'submitted') return;
	if (status === 'reviewing') {
		workflow.beginReview({
			reference,
			expectedStatus: 'submitted',
			expectedRevision: 1,
			now: actionAt
		});
		return;
	}
	if (status === 'awaiting_return') {
		advanceToAwaitingReturn();
		return;
	}
	if (status === 'ineligible' || status === 'support_handling') {
		advanceToDecision(status === 'ineligible' ? 'ineligible_non_eu' : 'support_handling');
		return;
	}
	advanceToDecision('ineligible_non_eu');
	workflow.closeCase({
		reference,
		expectedStatus: 'ineligible',
		expectedRevision: 3,
		outcomeCode: 'ineligible_non_eu',
		now: new Date('2026-07-17T10:15:00.000Z')
	});
}

beforeEach(() => {
	database = new Database(':memory:');
	migrate(database, migrationsDirectory);
	repository = new SqliteWithdrawalRepository(database);
	const alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
	reader = new WithdrawalCaseReader({ repository, dataKey, alerts });
	workflow = new WithdrawalWorkflowService({
		database,
		repository,
		reader,
		dataKey,
		productionOrigin: new URL('https://merch.sveltesociety.dev'),
		supportEmail: 'merch@sveltesociety.dev',
		seller
	});
	seedSubmittedCase();
});

afterEach(() => database.close());

describe('WithdrawalWorkflowService', () => {
	it('moves submitted to reviewing with one revision increment and one admin event', () => {
		const result = workflow.beginReview({
			reference,
			expectedStatus: 'submitted',
			expectedRevision: 1,
			now: actionAt
		});

		expect(result).toEqual({ reference, status: 'reviewing', revision: 2 });
		expect(repository.getByReference(reference)).toMatchObject({
			status: 'reviewing',
			revision: 2,
			updatedAt: actionAt
		});
		expect(
			database
				.prepare(
					`SELECT actor, action, prior_status, next_status, result_code, created_at
					 FROM withdrawal_case_events WHERE case_id = 'case_123' ORDER BY id`
				)
				.all()
		).toEqual([
			expect.objectContaining({ result_code: 'NOTICE_RECEIVED' }),
			{
				actor: 'codex-admin',
				action: 'review_started',
				prior_status: 'submitted',
				next_status: 'reviewing',
				result_code: 'ADMIN_REVIEW_STARTED',
				created_at: actionAt.toISOString()
			}
		]);
	});

	it('records an eligible EU reconciliation with encrypted metadata and one queued message', () => {
		workflow.beginReview({
			reference,
			expectedStatus: 'submitted',
			expectedRevision: 1,
			now: actionAt
		});
		const eligibleAt = new Date('2026-07-17T10:05:00.000Z');

		const result = workflow.recordEligibility({
			reference,
			expectedStatus: 'reviewing',
			expectedRevision: 2,
			decision: 'eligible_eu',
			internalOrderReference: 'internal-order-42',
			countryCode: ' se ',
			customerInstructions: 'Use the prepaid label and the address printed on it.',
			now: eligibleAt
		});

		expect(result).toEqual({ reference, status: 'awaiting_return', revision: 3 });
		expect(repository.getByReference(reference)).toMatchObject({
			status: 'awaiting_return',
			revision: 3,
			eligibility: 'eligible_eu',
			reconciledAt: eligibleAt,
			updatedAt: eligibleAt
		});
		expect(reader.inspectActive(reference, eligibleAt).payload.reconciliation).toEqual({
			internalOrderReference: 'internal-order-42',
			countryCode: 'SE',
			customerInstructions: 'Use the prepaid label and the address printed on it.',
			returnOutcome: null,
			parcelReference: null
		});
		expect(
			database
				.prepare(
					`SELECT actor, action, prior_status, next_status, result_code, created_at
					 FROM withdrawal_case_events WHERE case_id = 'case_123' ORDER BY id DESC LIMIT 1`
				)
				.get()
		).toEqual({
			actor: 'codex-admin',
			action: 'eligibility_recorded',
			prior_status: 'reviewing',
			next_status: 'awaiting_return',
			result_code: 'ELIGIBLE_EU_RECORDED',
			created_at: eligibleAt.toISOString()
		});
		expect(
			database
				.prepare(
					`SELECT kind, resend_of_message_id, attempt_count, next_attempt_at,
					 provider_delivery_id, completed_at, last_error_code
					 FROM withdrawal_messages WHERE case_id = 'case_123' ORDER BY id`
				)
				.all()
		).toEqual([
			expect.objectContaining({ kind: 'receipt' }),
			{
				kind: 'eligible_instructions',
				resend_of_message_id: null,
				attempt_count: 0,
				next_attempt_at: eligibleAt.toISOString(),
				provider_delivery_id: null,
				completed_at: null,
				last_error_code: null
			}
		]);
		const raw = JSON.stringify(database.prepare('SELECT * FROM withdrawal_cases').all());
		expect(raw).not.toContain('internal-order-42');
		expect(raw).not.toContain('prepaid label');
	});

	it.each([
		{
			decision: 'ineligible_non_eu' as const,
			countryCode: ' us ',
			nextStatus: 'ineligible',
			messageKind: 'ineligible_decision',
			resultCode: 'INELIGIBLE_NON_EU_RECORDED'
		},
		{
			decision: 'support_handling' as const,
			countryCode: ' se ',
			nextStatus: 'support_handling',
			messageKind: 'support_handoff',
			resultCode: 'SUPPORT_HANDLING_RECORDED'
		}
	])(
		'records $decision with one event and one queued $messageKind message',
		({ decision, countryCode, nextStatus, messageKind, resultCode }) => {
			workflow.beginReview({
				reference,
				expectedStatus: 'submitted',
				expectedRevision: 1,
				now: actionAt
			});
			const decidedAt = new Date('2026-07-17T10:05:00.000Z');

			const result = workflow.recordEligibility({
				reference,
				expectedStatus: 'reviewing',
				expectedRevision: 2,
				decision,
				internalOrderReference: 'internal-order-42',
				countryCode,
				now: decidedAt
			});

			expect(result).toEqual({ reference, status: nextStatus, revision: 3 });
			expect(repository.getByReference(reference)).toMatchObject({
				status: nextStatus,
				revision: 3,
				eligibility: decision,
				reconciledAt: decidedAt
			});
			expect(reader.inspectActive(reference, decidedAt).payload.reconciliation).toEqual({
				internalOrderReference: 'internal-order-42',
				countryCode: countryCode.trim().toUpperCase(),
				customerInstructions: null,
				returnOutcome: null,
				parcelReference: null
			});
			expect(
				database
					.prepare(
						`SELECT next_status, result_code FROM withdrawal_case_events
						 WHERE case_id = 'case_123' ORDER BY id DESC LIMIT 1`
					)
					.get()
			).toEqual({ next_status: nextStatus, result_code: resultCode });
			expect(
				database
					.prepare(
						`SELECT kind FROM withdrawal_messages
						 WHERE case_id = 'case_123' ORDER BY id DESC LIMIT 1`
					)
					.get()
			).toEqual({ kind: messageKind });
			expect(database.prepare('SELECT COUNT(*) AS count FROM withdrawal_messages').get()).toEqual({
				count: 2
			});
		}
	);

	it.each([
		{
			label: 'invented eligible country',
			decision: 'eligible_eu' as const,
			countryCode: 'ZZ',
			customerInstructions: 'Use the reviewed return address.',
			code: 'WITHDRAWAL_COUNTRY_INVALID'
		},
		{
			label: 'invented non-EU country',
			decision: 'ineligible_non_eu' as const,
			countryCode: 'QQ',
			code: 'WITHDRAWAL_COUNTRY_INVALID'
		},
		{
			label: 'non-ISO support country',
			decision: 'support_handling' as const,
			countryCode: 'XK',
			code: 'WITHDRAWAL_COUNTRY_INVALID'
		},
		{
			label: 'non-EU eligible decision',
			decision: 'eligible_eu' as const,
			countryCode: 'US',
			customerInstructions: 'Use the reviewed return address.',
			code: 'WITHDRAWAL_COUNTRY_INVALID'
		},
		{
			label: 'EU ineligible decision',
			decision: 'ineligible_non_eu' as const,
			countryCode: 'SE',
			code: 'WITHDRAWAL_COUNTRY_INVALID'
		},
		{
			label: 'eligible decision without instructions',
			decision: 'eligible_eu' as const,
			countryCode: 'SE',
			code: 'WITHDRAWAL_ELIGIBILITY_INVALID'
		},
		{
			label: 'non-EU decision with instructions',
			decision: 'ineligible_non_eu' as const,
			countryCode: 'US',
			customerInstructions: 'Unexpected instructions',
			code: 'WITHDRAWAL_ELIGIBILITY_INVALID'
		},
		{
			label: 'support decision with instructions',
			decision: 'support_handling' as const,
			countryCode: 'SE',
			customerInstructions: 'Unexpected instructions',
			code: 'WITHDRAWAL_ELIGIBILITY_INVALID'
		}
	])('rejects $label without mutation', (invalid) => {
		workflow.beginReview({
			reference,
			expectedStatus: 'submitted',
			expectedRevision: 1,
			now: actionAt
		});
		const before = {
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		};

		expect(() =>
			workflow.recordEligibility({
				reference,
				expectedStatus: 'reviewing',
				expectedRevision: 2,
				decision: invalid.decision,
				internalOrderReference: 'internal-order-42',
				countryCode: invalid.countryCode,
				customerInstructions: invalid.customerInstructions,
				now: new Date('2026-07-17T10:05:00.000Z')
			})
		).toThrowError(expect.objectContaining({ code: invalid.code }));
		expect({
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		}).toEqual(before);
	});

	it.each(['AX', 'BQ', 'CI', 'SJ', 'TL'])(
		'allows support handling for valid ISO country %s without an EU gate',
		(countryCode) => {
			workflow.beginReview({
				reference,
				expectedStatus: 'submitted',
				expectedRevision: 1,
				now: actionAt
			});

			expect(
				workflow.recordEligibility({
					reference,
					expectedStatus: 'reviewing',
					expectedRevision: 2,
					decision: 'support_handling',
					internalOrderReference: 'internal-order-42',
					countryCode,
					now: new Date('2026-07-17T10:05:00.000Z')
				})
			).toMatchObject({ status: 'support_handling', revision: 3 });
		}
	);

	it('records a received parcel in encrypted metadata without advancing the status', () => {
		advanceToAwaitingReturn();
		const returnedAt = new Date('2026-07-17T10:10:00.000Z');

		const result = workflow.recordReturn({
			reference,
			expectedStatus: 'awaiting_return',
			expectedRevision: 3,
			outcome: 'parcel_received',
			parcelReference: 'parcel-42',
			now: returnedAt
		});

		expect(result).toEqual({ reference, status: 'awaiting_return', revision: 4 });
		expect(repository.getByReference(reference)).toMatchObject({
			status: 'awaiting_return',
			revision: 4,
			updatedAt: returnedAt
		});
		expect(reader.inspectActive(reference, returnedAt).payload.reconciliation).toMatchObject({
			returnOutcome: 'parcel_received',
			parcelReference: 'parcel-42'
		});
		expect(
			database
				.prepare(
					`SELECT actor, action, prior_status, next_status, result_code, created_at
					 FROM withdrawal_case_events WHERE case_id = 'case_123' ORDER BY id DESC LIMIT 1`
				)
				.get()
		).toEqual({
			actor: 'codex-admin',
			action: 'return_recorded',
			prior_status: 'awaiting_return',
			next_status: 'awaiting_return',
			result_code: 'PARCEL_RECEIVED_RECORDED',
			created_at: returnedAt.toISOString()
		});
	});

	it('refuses to close awaiting_return before a return outcome is recorded', () => {
		advanceToAwaitingReturn();
		const before = database.prepare('SELECT * FROM withdrawal_cases').get();

		expect(() =>
			workflow.closeCase({
				reference,
				expectedStatus: 'awaiting_return',
				expectedRevision: 3,
				outcomeCode: 'eligible_return_received',
				now: new Date('2026-07-17T10:15:00.000Z')
			})
		).toThrowError(expect.objectContaining({ code: 'WITHDRAWAL_CLOSE_INVALID' }));
		expect(database.prepare('SELECT * FROM withdrawal_cases').get()).toEqual(before);
		expect(
			database
				.prepare(
					"SELECT COUNT(*) AS count FROM withdrawal_case_events WHERE action = 'case_closed'"
				)
				.get()
		).toEqual({ count: 0 });
	});

	it.each([
		['parcel_received', 'eligible_return_waived'],
		['parcel_received', 'eligible_return_not_received'],
		['return_waived', 'eligible_return_received'],
		['return_not_received', 'eligible_return_received']
	] as const)(
		'rejects recorded %s with mismatched close outcome %s',
		(returnOutcome, outcomeCode) => {
			advanceToAwaitingReturn();
			workflow.recordReturn({
				reference,
				expectedStatus: 'awaiting_return',
				expectedRevision: 3,
				outcome: returnOutcome,
				now: new Date('2026-07-17T10:10:00.000Z')
			});
			const before = database.prepare('SELECT * FROM withdrawal_cases').get();

			expect(() =>
				workflow.closeCase({
					reference,
					expectedStatus: 'awaiting_return',
					expectedRevision: 4,
					outcomeCode,
					now: new Date('2026-07-17T10:15:00.000Z')
				})
			).toThrowError(expect.objectContaining({ code: 'WITHDRAWAL_CLOSE_INVALID' }));
			expect(database.prepare('SELECT * FROM withdrawal_cases').get()).toEqual(before);
		}
	);

	it.each([
		['return_waived', 'RETURN_WAIVED_RECORDED'],
		['return_not_received', 'RETURN_NOT_RECEIVED_RECORDED']
	] as const)('records %s with its exact audit result', (outcome, resultCode) => {
		advanceToAwaitingReturn();
		const returnedAt = new Date('2026-07-17T10:10:00.000Z');

		expect(
			workflow.recordReturn({
				reference,
				expectedStatus: 'awaiting_return',
				expectedRevision: 3,
				outcome,
				now: returnedAt
			})
		).toEqual({ reference, status: 'awaiting_return', revision: 4 });
		expect(reader.inspectActive(reference, returnedAt).payload.reconciliation).toMatchObject({
			returnOutcome: outcome,
			parcelReference: null
		});
		expect(
			database
				.prepare(
					`SELECT result_code FROM withdrawal_case_events
					 WHERE case_id = 'case_123' ORDER BY id DESC LIMIT 1`
				)
				.get()
		).toEqual({ result_code: resultCode });
	});

	it.each(['', ' parcel-42 ', 'parcel\n42', 'x'.repeat(121)])(
		'rejects unsafe parcel reference %j without mutation',
		(parcelReference) => {
			advanceToAwaitingReturn();
			const before = {
				case: database.prepare('SELECT * FROM withdrawal_cases').get(),
				events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
				messages: database.prepare('SELECT * FROM withdrawal_messages').all()
			};

			expect(() =>
				workflow.recordReturn({
					reference,
					expectedStatus: 'awaiting_return',
					expectedRevision: 3,
					outcome: 'parcel_received',
					parcelReference,
					now: new Date('2026-07-17T10:10:00.000Z')
				})
			).toThrowError(expect.objectContaining({ code: 'WITHDRAWAL_RETURN_INVALID' }));
			expect({
				case: database.prepare('SELECT * FROM withdrawal_cases').get(),
				events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
				messages: database.prepare('SELECT * FROM withdrawal_messages').all()
			}).toEqual(before);
		}
	);

	it('rejects a repeated return write with the current safe status and revision', () => {
		advanceToAwaitingReturn();
		const returnedAt = new Date('2026-07-17T10:10:00.000Z');
		workflow.recordReturn({
			reference,
			expectedStatus: 'awaiting_return',
			expectedRevision: 3,
			outcome: 'parcel_received',
			parcelReference: 'parcel-winner',
			now: returnedAt
		});

		expect(() =>
			workflow.recordReturn({
				reference,
				expectedStatus: 'awaiting_return',
				expectedRevision: 3,
				outcome: 'return_not_received',
				now: new Date('2026-07-17T10:11:00.000Z')
			})
		).toThrowError(
			expect.objectContaining({
				code: 'WITHDRAWAL_CASE_CONFLICT',
				currentStatus: 'awaiting_return',
				currentRevision: 4
			})
		);
		expect(reader.inspectActive(reference, returnedAt).payload.reconciliation).toMatchObject({
			returnOutcome: 'parcel_received',
			parcelReference: 'parcel-winner'
		});
		expect(
			database
				.prepare(
					`SELECT COUNT(*) AS count FROM withdrawal_case_events
					 WHERE case_id = 'case_123' AND action = 'return_recorded'`
				)
				.get()
		).toEqual({ count: 1 });
	});

	it('lets one concurrently scheduled return revision win without overwrite or duplicate event', async () => {
		advanceToAwaitingReturn();
		const returnedAt = new Date('2026-07-17T10:10:00.000Z');
		const attempt = (
			outcome: 'parcel_received' | 'return_not_received',
			parcelReference?: string
		) =>
			Promise.resolve().then(() =>
				workflow.recordReturn({
					reference,
					expectedStatus: 'awaiting_return',
					expectedRevision: 3,
					outcome,
					parcelReference,
					now: returnedAt
				})
			);

		const results = await Promise.allSettled([
			attempt('parcel_received', 'parcel-concurrent'),
			attempt('return_not_received')
		]);

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		const rejected = results.find((result) => result.status === 'rejected');
		expect(rejected).toMatchObject({
			status: 'rejected',
			reason: {
				code: 'WITHDRAWAL_CASE_CONFLICT',
				currentStatus: 'awaiting_return',
				currentRevision: 4
			}
		});
		expect(repository.getByReference(reference)).toMatchObject({
			status: 'awaiting_return',
			revision: 4
		});
		expect(
			database
				.prepare(
					`SELECT COUNT(*) AS count FROM withdrawal_case_events
					 WHERE case_id = 'case_123' AND action = 'return_recorded'`
				)
				.get()
		).toEqual({ count: 1 });
	});

	it('rolls back the case and event when eligibility message insertion fails', () => {
		workflow.beginReview({
			reference,
			expectedStatus: 'submitted',
			expectedRevision: 1,
			now: actionAt
		});
		const before = {
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		};
		database.exec(`
			CREATE TRIGGER inject_withdrawal_message_failure
			BEFORE INSERT ON withdrawal_messages
			WHEN NEW.kind = 'eligible_instructions'
			BEGIN
				SELECT RAISE(ABORT, 'INJECTED_WITHDRAWAL_MESSAGE_FAILURE');
			END;
		`);

		expect(() =>
			workflow.recordEligibility({
				reference,
				expectedStatus: 'reviewing',
				expectedRevision: 2,
				decision: 'eligible_eu',
				internalOrderReference: 'internal-order-42',
				countryCode: 'SE',
				customerInstructions: 'Use the reviewed return address.',
				now: new Date('2026-07-17T10:05:00.000Z')
			})
		).toThrow('INJECTED_WITHDRAWAL_MESSAGE_FAILURE');
		expect({
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		}).toEqual(before);
	});

	it('closes a received eligible return and schedules purge exactly 90 days later', () => {
		advanceToAwaitingReturn();
		workflow.recordReturn({
			reference,
			expectedStatus: 'awaiting_return',
			expectedRevision: 3,
			outcome: 'parcel_received',
			parcelReference: 'parcel-42',
			now: new Date('2026-07-17T10:10:00.000Z')
		});
		const closedAt = new Date('2026-07-17T10:15:00.000Z');

		const result = workflow.closeCase({
			reference,
			expectedStatus: 'awaiting_return',
			expectedRevision: 4,
			outcomeCode: 'eligible_return_received',
			now: closedAt
		});

		expect(result).toEqual({ reference, status: 'closed', revision: 5 });
		expect(repository.getByReference(reference)).toMatchObject({
			status: 'closed',
			revision: 5,
			outcomeCode: 'ELIGIBLE_RETURN_RECEIVED',
			closedAt,
			updatedAt: closedAt,
			piiPurgeDueAt: new Date(closedAt.getTime() + 90 * 24 * 60 * 60_000)
		});
		expect(
			database
				.prepare(
					`SELECT actor, action, prior_status, next_status, result_code, created_at
					 FROM withdrawal_case_events WHERE case_id = 'case_123' ORDER BY id DESC LIMIT 1`
				)
				.get()
		).toEqual({
			actor: 'codex-admin',
			action: 'case_closed',
			prior_status: 'awaiting_return',
			next_status: 'closed',
			result_code: 'ELIGIBLE_RETURN_RECEIVED',
			created_at: closedAt.toISOString()
		});
	});

	it.each([
		['return_waived', 'eligible_return_waived', 'ELIGIBLE_RETURN_WAIVED'],
		['return_not_received', 'eligible_return_not_received', 'ELIGIBLE_RETURN_NOT_RECEIVED']
	] as const)(
		'closes awaiting_return after %s only with %s',
		(returnOutcome, outcomeCode, storedOutcomeCode) => {
			advanceToAwaitingReturn();
			workflow.recordReturn({
				reference,
				expectedStatus: 'awaiting_return',
				expectedRevision: 3,
				outcome: returnOutcome,
				now: new Date('2026-07-17T10:10:00.000Z')
			});
			const closedAt = new Date('2026-07-17T10:15:00.000Z');

			expect(
				workflow.closeCase({
					reference,
					expectedStatus: 'awaiting_return',
					expectedRevision: 4,
					outcomeCode,
					now: closedAt
				})
			).toEqual({ reference, status: 'closed', revision: 5 });
			expect(repository.getByReference(reference)).toMatchObject({
				status: 'closed',
				revision: 5,
				outcomeCode: storedOutcomeCode
			});
		}
	);

	it.each([
		{
			decision: 'ineligible_non_eu' as const,
			countryCode: 'US',
			status: 'ineligible' as const,
			outcomeCode: 'ineligible_non_eu' as const,
			storedOutcomeCode: 'INELIGIBLE_NON_EU'
		},
		{
			decision: 'support_handling' as const,
			countryCode: 'SE',
			status: 'support_handling' as const,
			outcomeCode: 'support_handling_completed' as const,
			storedOutcomeCode: 'SUPPORT_HANDLING_COMPLETED'
		}
	])('closes $status only with $outcomeCode', (entry) => {
		workflow.beginReview({
			reference,
			expectedStatus: 'submitted',
			expectedRevision: 1,
			now: actionAt
		});
		workflow.recordEligibility({
			reference,
			expectedStatus: 'reviewing',
			expectedRevision: 2,
			decision: entry.decision,
			internalOrderReference: 'internal-order-42',
			countryCode: entry.countryCode,
			now: new Date('2026-07-17T10:05:00.000Z')
		});
		const closedAt = new Date('2026-07-17T10:15:00.000Z');

		expect(
			workflow.closeCase({
				reference,
				expectedStatus: entry.status,
				expectedRevision: 3,
				outcomeCode: entry.outcomeCode,
				now: closedAt
			})
		).toEqual({ reference, status: 'closed', revision: 4 });
		expect(repository.getByReference(reference)).toMatchObject({
			status: 'closed',
			revision: 4,
			outcomeCode: entry.storedOutcomeCode,
			closedAt,
			piiPurgeDueAt: new Date(closedAt.getTime() + 90 * 24 * 60 * 60_000)
		});
	});

	it.each([
		['submitted', 'recordEligibility'],
		['submitted', 'recordReturn'],
		['submitted', 'closeCase'],
		['reviewing', 'beginReview'],
		['reviewing', 'recordReturn'],
		['reviewing', 'closeCase'],
		['awaiting_return', 'beginReview'],
		['awaiting_return', 'recordEligibility'],
		['ineligible', 'beginReview'],
		['ineligible', 'recordEligibility'],
		['ineligible', 'recordReturn'],
		['support_handling', 'beginReview'],
		['support_handling', 'recordEligibility'],
		['support_handling', 'recordReturn'],
		['closed', 'beginReview'],
		['closed', 'recordEligibility'],
		['closed', 'recordReturn'],
		['closed', 'closeCase']
	] as const)('forbids %s -> %s and returns the current safe state', (status, action) => {
		advanceToStatus(status);
		const current = repository.getByReference(reference)!;
		const before = {
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		};
		const invoke = () => {
			switch (action) {
				case 'beginReview':
					return workflow.beginReview({
						reference,
						expectedStatus: 'submitted',
						expectedRevision: current.revision,
						now: new Date('2026-07-17T10:20:00.000Z')
					});
				case 'recordEligibility':
					return workflow.recordEligibility({
						reference,
						expectedStatus: 'reviewing',
						expectedRevision: current.revision,
						decision: 'eligible_eu',
						internalOrderReference: 'internal-order-42',
						countryCode: 'SE',
						customerInstructions: 'Use the reviewed return address.',
						now: new Date('2026-07-17T10:20:00.000Z')
					});
				case 'recordReturn':
					return workflow.recordReturn({
						reference,
						expectedStatus: 'awaiting_return',
						expectedRevision: current.revision,
						outcome: 'return_not_received',
						now: new Date('2026-07-17T10:20:00.000Z')
					});
				case 'closeCase':
					return workflow.closeCase({
						reference,
						expectedStatus: 'ineligible',
						expectedRevision: current.revision,
						outcomeCode: 'ineligible_non_eu',
						now: new Date('2026-07-17T10:20:00.000Z')
					});
			}
		};

		expect(invoke).toThrowError(
			expect.objectContaining({
				code: 'WITHDRAWAL_CASE_CONFLICT',
				currentStatus: current.status,
				currentRevision: current.revision
			})
		);
		expect({
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		}).toEqual(before);
	});

	it('rolls back corrupt ciphertext before persisting one WDR-scoped decrypt alert', () => {
		const row = database
			.prepare("SELECT encrypted_payload FROM withdrawal_cases WHERE id = 'case_123'")
			.get() as { encrypted_payload: Buffer };
		const tampered = Buffer.from(row.encrypted_payload);
		tampered[0] ^= 255;
		database
			.prepare("UPDATE withdrawal_cases SET encrypted_payload = ? WHERE id = 'case_123'")
			.run(tampered);
		const before = {
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		};

		expect(() =>
			workflow.beginReview({
				reference,
				expectedStatus: 'submitted',
				expectedRevision: 1,
				now: actionAt
			})
		).toThrow('WITHDRAWAL_DECRYPT_FAILED');
		expect({
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		}).toEqual(before);
		expect(
			database
				.prepare(
					`SELECT alert_code, alert_subject_id FROM outbox_jobs
					 WHERE alert_code = 'WITHDRAWAL_DATA_UNREADABLE'`
				)
				.all()
		).toEqual([{ alert_code: 'WITHDRAWAL_DATA_UNREADABLE', alert_subject_id: reference }]);
	});

	it('previews an exact completed source message for ten minutes without writing', () => {
		database
			.prepare(
				`UPDATE withdrawal_messages SET attempt_count = 1,
				 provider_delivery_id = 'delivery-receipt', completed_at = ? WHERE id = 1`
			)
			.run(submittedAt.toISOString());
		const before = {
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		};

		const preview = workflow.previewResend({ reference, sourceMessageId: 1, now: actionAt });

		expect(preview).toMatchObject({
			reference,
			sourceMessageId: 1,
			destination: 'private.customer@example.com',
			subject: `Withdrawal notice received — ${reference}`,
			textBody: expect.stringContaining('Private Test Name'),
			expiresAt: new Date(actionAt.getTime() + 10 * 60_000)
		});
		expect(preview.previewToken).toMatch(/^v1\.\d{10}\.1\.[0-9a-f]{64}\.[A-Za-z0-9_-]{43}$/);
		expect({
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		}).toEqual(before);
		const persisted = JSON.stringify(database.prepare('SELECT * FROM withdrawal_messages').all());
		expect(persisted).not.toContain('private.customer@example.com');
		expect(persisted).not.toContain('Private Test Name');
		expect(persisted).not.toContain(preview.previewToken);
	});

	it('confirms a reviewed preview by queueing one resend row without inline delivery data', () => {
		database
			.prepare(
				`UPDATE withdrawal_messages SET attempt_count = 1,
				 provider_delivery_id = 'delivery-receipt', completed_at = ? WHERE id = 1`
			)
			.run(submittedAt.toISOString());
		const preview = workflow.previewResend({ reference, sourceMessageId: 1, now: actionAt });
		const confirmedAt = new Date(actionAt.getTime() + 60_000);

		const result = workflow.confirmResend({
			reference,
			sourceMessageId: 1,
			previewToken: preview.previewToken,
			idempotencyKey: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1',
			now: confirmedAt
		});

		expect(result).toEqual({
			reference,
			sourceMessageId: 1,
			messageId: 2,
			queued: true
		});
		expect(
			database
				.prepare(
					`SELECT id, case_id, kind, resend_of_message_id, idempotency_key,
					 attempt_count, next_attempt_at, provider_delivery_id, completed_at, last_error_code
					 FROM withdrawal_messages ORDER BY id`
				)
				.all()
		).toEqual([
			expect.objectContaining({ id: 1, kind: 'receipt' }),
			{
				id: 2,
				case_id: 'case_123',
				kind: 'resend',
				resend_of_message_id: 1,
				idempotency_key: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1',
				attempt_count: 0,
				next_attempt_at: confirmedAt.toISOString(),
				provider_delivery_id: null,
				completed_at: null,
				last_error_code: null
			}
		]);
		const persisted = JSON.stringify(database.prepare('SELECT * FROM withdrawal_messages').all());
		expect(persisted).not.toContain('private.customer@example.com');
		expect(persisted).not.toContain('Private Test Name');
		expect(persisted).not.toContain(preview.previewToken);
	});

	it('rejects an expired ten-minute preview without writing', () => {
		database
			.prepare(
				`UPDATE withdrawal_messages SET attempt_count = 1,
				 provider_delivery_id = 'delivery-receipt', completed_at = ? WHERE id = 1`
			)
			.run(submittedAt.toISOString());
		const preview = workflow.previewResend({ reference, sourceMessageId: 1, now: actionAt });
		const before = database.prepare('SELECT * FROM withdrawal_messages').all();

		expect(() =>
			workflow.confirmResend({
				reference,
				sourceMessageId: 1,
				previewToken: preview.previewToken,
				idempotencyKey: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1',
				now: new Date(actionAt.getTime() + 601_000)
			})
		).toThrowError(expect.objectContaining({ code: 'WITHDRAWAL_MESSAGE_PREVIEW_INVALID' }));
		expect(database.prepare('SELECT * FROM withdrawal_messages').all()).toEqual(before);
	});

	it.each(['wrong_message', 'wrong_case', 'tampered_token'] as const)(
		'rejects %s preview confirmation without writing',
		(failure) => {
			database
				.prepare(
					`UPDATE withdrawal_messages SET attempt_count = 1,
					 provider_delivery_id = 'delivery-receipt', completed_at = ? WHERE id = 1`
				)
				.run(submittedAt.toISOString());
			const preview = workflow.previewResend({ reference, sourceMessageId: 1, now: actionAt });
			const before = database.prepare('SELECT * FROM withdrawal_messages').all();
			const token =
				failure === 'tampered_token'
					? `${preview.previewToken.slice(0, -1)}${preview.previewToken.endsWith('A') ? 'B' : 'A'}`
					: preview.previewToken;

			expect(() =>
				workflow.confirmResend({
					reference: failure === 'wrong_case' ? 'WDR-BBBBBBBBBBBBBBBBBBBBBB' : reference,
					sourceMessageId: failure === 'wrong_message' ? 2 : 1,
					previewToken: token,
					idempotencyKey: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1',
					now: new Date(actionAt.getTime() + 60_000)
				})
			).toThrowError(expect.objectContaining({ code: 'WITHDRAWAL_MESSAGE_PREVIEW_INVALID' }));
			expect(database.prepare('SELECT * FROM withdrawal_messages').all()).toEqual(before);
		}
	);

	it('rejects a same-revision changed-case digest without queueing', () => {
		database
			.prepare(
				`UPDATE withdrawal_messages SET attempt_count = 1,
				 provider_delivery_id = 'delivery-receipt', completed_at = ? WHERE id = 1`
			)
			.run(submittedAt.toISOString());
		const preview = workflow.previewResend({ reference, sourceMessageId: 1, now: actionAt });
		const changed = encryptWithdrawalPayload(
			{
				...reader.inspectActive(reference, actionAt).payload,
				fullName: 'Changed Private Name'
			},
			'case_123',
			dataKey
		);
		database
			.prepare(
				`UPDATE withdrawal_cases SET encrypted_payload = ?, payload_nonce = ?, payload_tag = ?
				 WHERE id = 'case_123'`
			)
			.run(changed.ciphertext, changed.nonce, changed.tag);
		const before = database.prepare('SELECT * FROM withdrawal_messages').all();

		expect(() =>
			workflow.confirmResend({
				reference,
				sourceMessageId: 1,
				previewToken: preview.previewToken,
				idempotencyKey: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1',
				now: new Date(actionAt.getTime() + 60_000)
			})
		).toThrowError(expect.objectContaining({ code: 'WITHDRAWAL_MESSAGE_PREVIEW_INVALID' }));
		expect(database.prepare('SELECT * FROM withdrawal_messages').all()).toEqual(before);
	});

	it('previews a permanently failed source kind for reviewed retry', () => {
		const inserted = database
			.prepare(
				`INSERT INTO withdrawal_messages (
				 case_id, kind, resend_of_message_id, idempotency_key, attempt_count,
				 next_attempt_at, provider_delivery_id, completed_at, last_error_code
				) VALUES ('case_123', 'ineligible_decision', NULL, 'failed-source', 1, ?, NULL, ?,
				 'PLUNK_REQUEST_REJECTED')`
			)
			.run(submittedAt.toISOString(), submittedAt.toISOString());
		const sourceMessageId = Number(inserted.lastInsertRowid);
		const beforeCount = database.prepare('SELECT COUNT(*) AS count FROM withdrawal_messages').get();

		const preview = workflow.previewResend({ reference, sourceMessageId, now: actionAt });

		expect(preview).toMatchObject({
			sourceMessageId,
			destination: 'private.customer@example.com',
			subject: `Withdrawal eligibility decision — ${reference}`,
			textBody: expect.stringContaining('not eligible for a change-of-mind return')
		});
		expect(database.prepare('SELECT COUNT(*) AS count FROM withdrawal_messages').get()).toEqual(
			beforeCount
		);
	});

	it('previews a completed resend using the original message kind', () => {
		database
			.prepare(
				`UPDATE withdrawal_messages SET attempt_count = 1,
				 provider_delivery_id = 'delivery-receipt', completed_at = ? WHERE id = 1`
			)
			.run(submittedAt.toISOString());
		const inserted = database
			.prepare(
				`INSERT INTO withdrawal_messages (
				 case_id, kind, resend_of_message_id, idempotency_key, attempt_count,
				 next_attempt_at, provider_delivery_id, completed_at, last_error_code
				) VALUES ('case_123', 'resend', 1, 'completed-resend', 1, ?,
				 'delivery-resend', ?, NULL)`
			)
			.run(submittedAt.toISOString(), submittedAt.toISOString());
		const sourceMessageId = Number(inserted.lastInsertRowid);

		const preview = workflow.previewResend({ reference, sourceMessageId, now: actionAt });

		expect(preview).toMatchObject({
			sourceMessageId,
			subject: `Withdrawal notice received — ${reference}`,
			textBody: expect.stringContaining('This receipt confirms submission only.')
		});
	});

	it('reuses one resend row when the same confirmation idempotency key is repeated', () => {
		database
			.prepare(
				`UPDATE withdrawal_messages SET attempt_count = 1,
				 provider_delivery_id = 'delivery-receipt', completed_at = ? WHERE id = 1`
			)
			.run(submittedAt.toISOString());
		const preview = workflow.previewResend({ reference, sourceMessageId: 1, now: actionAt });
		const input = {
			reference,
			sourceMessageId: 1,
			previewToken: preview.previewToken,
			idempotencyKey: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1',
			now: new Date(actionAt.getTime() + 60_000)
		};

		const first = workflow.confirmResend(input);
		const repeated = workflow.confirmResend(input);

		expect(repeated).toEqual(first);
		expect(
			database
				.prepare("SELECT COUNT(*) AS count FROM withdrawal_messages WHERE kind = 'resend'")
				.get()
		).toEqual({ count: 1 });
	});

	it('rejects confirm without a preview token and writes nothing', () => {
		database
			.prepare(
				`UPDATE withdrawal_messages SET attempt_count = 1,
				 provider_delivery_id = 'delivery-receipt', completed_at = ? WHERE id = 1`
			)
			.run(submittedAt.toISOString());
		const before = database.prepare('SELECT * FROM withdrawal_messages').all();

		expect(() =>
			workflow.confirmResend({
				reference,
				sourceMessageId: 1,
				previewToken: '',
				idempotencyKey: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1',
				now: actionAt
			})
		).toThrowError(expect.objectContaining({ code: 'WITHDRAWAL_MESSAGE_PREVIEW_INVALID' }));
		expect(database.prepare('SELECT * FROM withdrawal_messages').all()).toEqual(before);
	});

	it('alerts once and performs zero mutation for tampered ciphertext during preview', () => {
		database
			.prepare(
				`UPDATE withdrawal_messages SET attempt_count = 1,
				 provider_delivery_id = 'delivery-receipt', completed_at = ? WHERE id = 1`
			)
			.run(submittedAt.toISOString());
		const row = database
			.prepare("SELECT encrypted_payload FROM withdrawal_cases WHERE id = 'case_123'")
			.get() as { encrypted_payload: Buffer };
		const tampered = Buffer.from(row.encrypted_payload);
		tampered[0] ^= 255;
		database
			.prepare("UPDATE withdrawal_cases SET encrypted_payload = ? WHERE id = 'case_123'")
			.run(tampered);
		const before = {
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		};

		expect(() => workflow.previewResend({ reference, sourceMessageId: 1, now: actionAt })).toThrow(
			'WITHDRAWAL_DECRYPT_FAILED'
		);
		expect({
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		}).toEqual(before);
		expect(
			database
				.prepare(
					`SELECT alert_code, alert_subject_id FROM outbox_jobs
					 WHERE alert_code = 'WITHDRAWAL_DATA_UNREADABLE'`
				)
				.all()
		).toEqual([{ alert_code: 'WITHDRAWAL_DATA_UNREADABLE', alert_subject_id: reference }]);
	});

	it('alerts once and performs zero mutation for tampered ciphertext during confirm', () => {
		database
			.prepare(
				`UPDATE withdrawal_messages SET attempt_count = 1,
				 provider_delivery_id = 'delivery-receipt', completed_at = ? WHERE id = 1`
			)
			.run(submittedAt.toISOString());
		const preview = workflow.previewResend({ reference, sourceMessageId: 1, now: actionAt });
		const row = database
			.prepare("SELECT encrypted_payload FROM withdrawal_cases WHERE id = 'case_123'")
			.get() as { encrypted_payload: Buffer };
		const tampered = Buffer.from(row.encrypted_payload);
		tampered[0] ^= 255;
		database
			.prepare("UPDATE withdrawal_cases SET encrypted_payload = ? WHERE id = 'case_123'")
			.run(tampered);
		const before = {
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		};

		expect(() =>
			workflow.confirmResend({
				reference,
				sourceMessageId: 1,
				previewToken: preview.previewToken,
				idempotencyKey: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1',
				now: new Date(actionAt.getTime() + 60_000)
			})
		).toThrow('WITHDRAWAL_DECRYPT_FAILED');
		expect({
			case: database.prepare('SELECT * FROM withdrawal_cases').get(),
			events: database.prepare('SELECT * FROM withdrawal_case_events').all(),
			messages: database.prepare('SELECT * FROM withdrawal_messages').all()
		}).toEqual(before);
		expect(
			database
				.prepare(
					`SELECT alert_code, alert_subject_id FROM outbox_jobs
					 WHERE alert_code = 'WITHDRAWAL_DATA_UNREADABLE'`
				)
				.all()
		).toEqual([{ alert_code: 'WITHDRAWAL_DATA_UNREADABLE', alert_subject_id: reference }]);
	});

	it('redacts resend destination, subject, body, digest token, and idempotency key from logs', () => {
		database
			.prepare(
				`UPDATE withdrawal_messages SET attempt_count = 1,
				 provider_delivery_id = 'delivery-receipt', completed_at = ? WHERE id = 1`
			)
			.run(submittedAt.toISOString());
		const preview = workflow.previewResend({ reference, sourceMessageId: 1, now: actionAt });
		const lines: string[] = [];
		const logger = createLogger((line) => lines.push(line));

		logger({
			level: 'info',
			code: 'MCP_WITHDRAWAL_MESSAGE_PREVIEWED',
			fields: {
				reference,
				source_message_id: 1,
				destination: preview.destination,
				subject: preview.subject,
				text_body: preview.textBody,
				preview_token: preview.previewToken,
				idempotency_key: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1'
			}
		});

		expect(JSON.parse(lines[0])).toEqual({
			reference,
			source_message_id: 1,
			destination: '[REDACTED]',
			subject: '[REDACTED]',
			text_body: '[REDACTED]',
			preview_token: '[REDACTED]',
			idempotency_key: '[REDACTED]',
			level: 'info',
			code: 'MCP_WITHDRAWAL_MESSAGE_PREVIEWED'
		});
		const serialized = lines[0];
		expect(serialized).not.toContain('private.customer@example.com');
		expect(serialized).not.toContain('Private Test Name');
		expect(serialized).not.toContain(preview.previewToken);
	});
});
