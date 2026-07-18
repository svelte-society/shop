import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalWithdrawalInput } from '$lib/domain/withdrawals';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { WithdrawalMessageWorker } from '$lib/server/jobs/withdrawal-worker.server';
import { SqliteLeaseRepository } from '$lib/server/jobs/leases.server';
import { OutboxScheduler } from '$lib/server/jobs/scheduler.server';
import { SqliteWithdrawalRetentionJob } from '$lib/server/jobs/withdrawal-retention.server';
import { createMcpServer, type McpServices } from '$lib/server/mcp/server';
import { SqliteAlertService } from '$lib/server/monitoring/alerts.server';
import { PlunkError, type PlunkSendInput } from '$lib/server/plunk/gateway';
import { WithdrawalCaseReader } from '$lib/server/withdrawals/case-reader.server';
import { decryptWithdrawalPayload } from '$lib/server/withdrawals/crypto.server';
import {
	SqliteWithdrawalRepository,
	type WithdrawalMessageKind
} from '$lib/server/withdrawals/repository.server';
import { WithdrawalSubmissionService } from '$lib/server/withdrawals/submission.server';
import { WithdrawalWorkflowService } from '$lib/server/withdrawals/workflow.server';

const migrationsDirectory = resolve('migrations');
const dataKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const submittedAt = new Date('2026-07-17T08:30:00.000Z');
const wholeOrderInput: CanonicalWithdrawalInput = {
	fullName: 'Flow Canary Customer',
	receiptEmail: 'flow.canary@example.test',
	enteredOrderReference: 'FLOW-CANARY-ORDER',
	scope: 'entire_order',
	items: []
};
const partialInput: CanonicalWithdrawalInput = {
	fullName: 'Partial Flow Customer',
	receiptEmail: 'partial.flow@example.test',
	enteredOrderReference: 'PARTIAL-FLOW-ORDER',
	scope: 'specific_items',
	items: [
		{ description: 'Orange community hoodie', quantity: 2 },
		{ description: 'Svelte Society cap', quantity: 1 }
	]
};
const seller = {
	legalName: 'Svelte Society Merch AB',
	registrationNumber: '559999-0000',
	addressLine1: 'Registered Street 1',
	postalCode: '111 11',
	city: 'Stockholm',
	country: 'Sweden',
	email: 'merch@sveltesociety.dev'
};

let directory: string;
let databasePath: string;
let database: ShopDatabase;
let repository: SqliteWithdrawalRepository;

function openFixtureDatabase(path: string): ShopDatabase {
	const opened = new Database(path);
	opened.pragma('journal_mode = WAL');
	opened.pragma('foreign_keys = ON');
	opened.pragma('busy_timeout = 5000');
	opened.pragma('synchronous = FULL');
	return opened;
}

function rowCount(table: string): number {
	return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
		.count;
}

async function createQueuedCase(input = partialInput) {
	const submission = new WithdrawalSubmissionService({
		repository,
		dispatcher: { attemptReceipt: async () => 'queued' },
		dataKey
	});
	const result = await submission.submit(input, submittedAt);
	const record = repository.loadEncryptedByReference(result.reference);
	if (!record) throw new Error('TEST_WITHDRAWAL_CASE_MISSING');
	return { result, record };
}

function completeReceipt(): void {
	database
		.prepare(
			`UPDATE withdrawal_messages SET attempt_count = 1,
			 provider_delivery_id = 'delivery_fixture_receipt', completed_at = ? WHERE id = 1`
		)
		.run(submittedAt.toISOString());
}

function insertPendingMessage(caseId: string, kind: WithdrawalMessageKind, suffix: string): number {
	if (kind === 'resend') completeReceipt();
	const inserted = database
		.prepare(
			`INSERT INTO withdrawal_messages (
			 case_id, kind, resend_of_message_id, idempotency_key, attempt_count,
			 next_attempt_at, provider_delivery_id, completed_at, last_error_code
			) VALUES (?, ?, ?, ?, 0, ?, NULL, NULL, NULL)`
		)
		.run(
			caseId,
			kind,
			kind === 'resend' ? 1 : null,
			`integration:${kind}:${suffix}`,
			submittedAt.toISOString()
		);
	return Number(inserted.lastInsertRowid);
}

function withdrawalWorker(send: (input: PlunkSendInput) => Promise<{ deliveryId: string }>) {
	const alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
	const reader = new WithdrawalCaseReader({ repository, dataKey, alerts });
	return new WithdrawalMessageWorker({
		repository,
		reader,
		plunk: { send },
		alerts,
		from: { name: 'Svelte Society Shop', email: 'merch@sveltesociety.dev' },
		supportEmail: 'merch@sveltesociety.dev',
		productionOrigin: new URL('https://merch.sveltesociety.dev'),
		seller
	});
}

async function callMcpTool(
	server: ReturnType<typeof createMcpServer>,
	name: string,
	args: Record<string, unknown>
) {
	const response = (await server.receive({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name, arguments: args }
	})) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } };
	expect(response.result.isError).not.toBe(true);
	return response.result.structuredContent as Record<string, unknown>;
}

function withdrawalMcpServer(actionAt: Date) {
	const alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
	const reader = new WithdrawalCaseReader({ repository, dataKey, alerts });
	const dependencies = { database, repository, reader, dataKey };
	const workflow = new WithdrawalWorkflowService(dependencies);
	const messageWorkflow = new WithdrawalWorkflowService({
		...dependencies,
		productionOrigin: new URL('https://merch.sveltesociety.dev'),
		supportEmail: 'merch@sveltesociety.dev',
		seller
	});
	const services = {
		withdrawals: {
			listCases: repository.list.bind(repository),
			inspectCase(reference: string) {
				const inspection = reader.inspectActive(reference, actionAt);
				return { inspection, history: repository.getInspectionHistory(inspection.id) };
			}
		},
		withdrawalWorkflow: {
			beginReview: (input) => workflow.beginReview({ ...input, now: actionAt }),
			recordEligibility: (input) => workflow.recordEligibility({ ...input, now: actionAt }),
			recordReturn: (input) => workflow.recordReturn({ ...input, now: actionAt }),
			closeCase: (input) => workflow.closeCase({ ...input, now: actionAt }),
			resendMessage(input) {
				if (input.mode === 'preview') {
					return {
						mode: 'preview' as const,
						...messageWorkflow.previewResend({
							reference: input.reference,
							sourceMessageId: input.sourceMessageId,
							now: actionAt
						}),
						queued: false as const
					};
				}
				return {
					mode: 'confirm' as const,
					...messageWorkflow.confirmResend({
						reference: input.reference,
						sourceMessageId: input.sourceMessageId,
						previewToken: input.previewToken as string,
						idempotencyKey: input.idempotencyKey as string,
						now: actionAt
					})
				};
			}
		}
	} satisfies McpServices;
	return createMcpServer(services);
}

async function closeEligibleCase() {
	const { result, record } = await createQueuedCase({
		...partialInput,
		enteredOrderReference: 'PURGE-FLOW-ORDER'
	});
	const alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
	const reader = new WithdrawalCaseReader({ repository, dataKey, alerts });
	const workflow = new WithdrawalWorkflowService({ database, repository, reader, dataKey });
	const closedAt = new Date('2026-07-17T10:00:00.000Z');
	workflow.beginReview({
		reference: result.reference,
		expectedStatus: 'submitted',
		expectedRevision: 1,
		now: closedAt
	});
	workflow.recordEligibility({
		reference: result.reference,
		expectedStatus: 'reviewing',
		expectedRevision: 2,
		decision: 'eligible_eu',
		internalOrderReference: 'internal-purge-order',
		countryCode: 'SE',
		customerInstructions: 'Use the reviewed registered return address.',
		now: closedAt
	});
	workflow.recordReturn({
		reference: result.reference,
		expectedStatus: 'awaiting_return',
		expectedRevision: 3,
		outcome: 'return_not_received',
		now: closedAt
	});
	workflow.closeCase({
		reference: result.reference,
		expectedStatus: 'awaiting_return',
		expectedRevision: 4,
		outcomeCode: 'eligible_return_not_received',
		now: closedAt
	});
	return {
		reference: result.reference,
		caseId: record.id,
		closedAt,
		purgeDueAt: new Date(closedAt.getTime() + 90 * 24 * 60 * 60_000)
	};
}

async function preparePendingMessage(kind: WithdrawalMessageKind) {
	const { record } = await createQueuedCase();
	if (
		kind === 'eligible_instructions' ||
		kind === 'ineligible_decision' ||
		kind === 'support_handoff'
	) {
		const alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
		const reader = new WithdrawalCaseReader({ repository, dataKey, alerts });
		const workflow = new WithdrawalWorkflowService({ database, repository, reader, dataKey });
		workflow.beginReview({
			reference: record.reference,
			expectedStatus: 'submitted',
			expectedRevision: 1,
			now: submittedAt
		});
		const decision =
			kind === 'eligible_instructions'
				? ('eligible_eu' as const)
				: kind === 'ineligible_decision'
					? ('ineligible_non_eu' as const)
					: ('support_handling' as const);
		workflow.recordEligibility({
			reference: record.reference,
			expectedStatus: 'reviewing',
			expectedRevision: 2,
			decision,
			internalOrderReference: `integration-order-${kind}`,
			countryCode: decision === 'ineligible_non_eu' ? 'US' : 'SE',
			customerInstructions:
				decision === 'eligible_eu' ? 'Use the reviewed registered return address.' : undefined,
			now: submittedAt
		});
		const message = database
			.prepare('SELECT id FROM withdrawal_messages WHERE case_id = ? AND kind = ?')
			.get(record.id, kind) as { id: number } | undefined;
		if (!message) throw new Error('TEST_WITHDRAWAL_MESSAGE_MISSING');
		return { record, messageId: message.id };
	}
	if (kind === 'resend') {
		return { record, messageId: insertPendingMessage(record.id, kind, 'retry') };
	}
	return { record, messageId: 1 };
}

function runRaceChild(runnerPath: string, configurationPath: string) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChild) => {
		const child = spawn(
			process.execPath,
			['--experimental-transform-types', runnerPath, configurationPath],
			{
				cwd: resolve('.'),
				env: { ...process.env, NODE_NO_WARNINGS: '1' },
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
		child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
		child.on('close', (code) => resolveChild({ code, stdout, stderr }));
	});
}

async function waitForFiles(paths: string[]): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const present = await Promise.all(
			paths.map((path) =>
				readFile(path)
					.then(() => true)
					.catch(() => false)
			)
		);
		if (present.every(Boolean)) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
	throw new Error('WITHDRAWAL_RACE_BARRIER_TIMEOUT');
}

async function waitForRaceBarrier(
	paths: string[],
	children: Array<Promise<{ code: number | null; stdout: string; stderr: string }>>
): Promise<void> {
	await Promise.race([
		waitForFiles(paths),
		...children.map(async (child) => {
			const result = await child;
			throw new Error(`WITHDRAWAL_RACE_CHILD_EXITED:${JSON.stringify(result)}`);
		})
	]);
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'withdrawal-flow-'));
	databasePath = join(directory, 'shop.sqlite');
	database = openFixtureDatabase(databasePath);
	migrate(database, migrationsDirectory);
	repository = new SqliteWithdrawalRepository(database);
});

afterEach(async () => {
	if (database.open) database.close();
	await rm(directory, { recursive: true, force: true });
});

describe('withdrawal production-shaped flow', () => {
	it('atomically commits one durable whole-order case, receipt, alert, and event before Plunk failure', async () => {
		const dispatcher = {
			attemptReceipt: vi.fn(async () => {
				throw new Error('PLUNK_UNAVAILABLE');
			})
		};
		const submission = new WithdrawalSubmissionService({ repository, dispatcher, dataKey });

		const result = await submission.submit(wholeOrderInput, submittedAt);

		expect(result).toMatchObject({
			reference: expect.stringMatching(/^WDR-[A-Za-z0-9_-]{22}$/u),
			createdAt: submittedAt,
			scope: 'entire_order',
			enteredOrderReference: 'FLOW-CANARY-ORDER',
			deliveryState: 'queued'
		});
		database.pragma('wal_checkpoint(FULL)');
		database.close();
		database = openFixtureDatabase(databasePath);

		expect(
			database
				.prepare(
					`SELECT status, revision, scope, eligibility, outcome_code
					 FROM withdrawal_cases`
				)
				.all()
		).toEqual([
			{
				status: 'submitted',
				revision: 1,
				scope: 'entire_order',
				eligibility: 'pending',
				outcome_code: null
			}
		]);
		expect(
			database
				.prepare(
					`SELECT kind, attempt_count, provider_delivery_id, completed_at, last_error_code
					 FROM withdrawal_messages`
				)
				.all()
		).toEqual([
			{
				kind: 'receipt',
				attempt_count: 0,
				provider_delivery_id: null,
				completed_at: null,
				last_error_code: null
			}
		]);
		expect(
			database
				.prepare(
					`SELECT kind, alert_code, alert_subject_id
					 FROM outbox_jobs WHERE alert_code = 'WITHDRAWAL_NOTICE_RECEIVED'`
				)
				.all()
		).toEqual([
			{
				kind: 'operational-alert',
				alert_code: 'WITHDRAWAL_NOTICE_RECEIVED',
				alert_subject_id: result.reference
			}
		]);
		expect(
			database
				.prepare(
					`SELECT actor, action, prior_status, next_status, result_code
					 FROM withdrawal_case_events`
				)
				.all()
		).toEqual([
			{
				actor: 'customer',
				action: 'submitted',
				prior_status: null,
				next_status: 'submitted',
				result_code: 'NOTICE_RECEIVED'
			}
		]);
		expect(dispatcher.attemptReceipt).toHaveBeenCalledOnce();
	});

	it('encrypts a normalized partial-item notice and exposes only the stable public result', async () => {
		const dispatcher = { attemptReceipt: vi.fn(async () => 'queued' as const) };
		const submission = new WithdrawalSubmissionService({ repository, dispatcher, dataKey });

		const result = await submission.submit(partialInput, submittedAt);

		expect(Object.keys(result).sort()).toEqual([
			'createdAt',
			'deliveryState',
			'enteredOrderReference',
			'reference',
			'scope'
		]);
		const stored = repository.loadEncryptedByReference(result.reference);
		expect(stored).not.toBeNull();
		expect(decryptWithdrawalPayload(stored!.encryptedPayload, stored!.id, dataKey)).toEqual({
			fullName: partialInput.fullName,
			receiptEmail: partialInput.receiptEmail,
			enteredOrderReference: partialInput.enteredOrderReference,
			items: partialInput.items,
			reconciliation: null
		});
		expect(rowCount('withdrawal_cases')).toBe(1);
	});

	it.each([
		'withdrawal_cases',
		'withdrawal_messages',
		'outbox_jobs',
		'withdrawal_case_events'
	] as const)('rolls back every row when %s rejects before commit', async (table) => {
		database.exec(`
			CREATE TRIGGER reject_${table} BEFORE INSERT ON ${table}
			BEGIN
				SELECT RAISE(ABORT, 'injected precommit failure');
			END
		`);
		const dispatcher = { attemptReceipt: vi.fn(async () => 'queued' as const) };
		const submission = new WithdrawalSubmissionService({ repository, dispatcher, dataKey });

		await expect(submission.submit(partialInput, submittedAt)).rejects.toThrowError(
			'WITHDRAWAL_SUBMISSION_FAILED'
		);

		for (const persistedTable of [
			'withdrawal_cases',
			'withdrawal_messages',
			'outbox_jobs',
			'withdrawal_case_events'
		]) {
			expect(rowCount(persistedTable), persistedTable).toBe(0);
		}
		expect(dispatcher.attemptReceipt).not.toHaveBeenCalled();
	});

	it('creates no case when validation or encryption fails before repository entry', async () => {
		const dispatcher = { attemptReceipt: vi.fn(async () => 'queued' as const) };
		const invalid = new WithdrawalSubmissionService({ repository, dispatcher, dataKey });
		const badKey = new WithdrawalSubmissionService({
			repository,
			dispatcher,
			dataKey: Buffer.alloc(31)
		});

		await expect(
			invalid.submit({ ...partialInput, receiptEmail: 'not-an-email' }, submittedAt)
		).rejects.toThrowError('WITHDRAWAL_INPUT_INVALID');
		await expect(badKey.submit(partialInput, submittedAt)).rejects.toThrowError(
			'WITHDRAWAL_ENCRYPT_FAILED'
		);
		expect(rowCount('withdrawal_cases')).toBe(0);
		expect(dispatcher.attemptReceipt).not.toHaveBeenCalled();
	});

	it.each([
		'receipt',
		'eligible_instructions',
		'ineligible_decision',
		'support_handoff',
		'resend'
	] as const)('retries, completes, and permanently alerts the %s message kind', async (kind) => {
		const { record, messageId: retryMessageId } = await preparePendingMessage(kind);
		const sendRetry = vi
			.fn<(input: PlunkSendInput) => Promise<{ deliveryId: string }>>()
			.mockRejectedValueOnce(new PlunkError('PLUNK_TIMEOUT'))
			.mockResolvedValueOnce({ deliveryId: `delivery_${kind}_completed` });
		const retryWorker = withdrawalWorker(sendRetry);

		await expect(retryWorker.attemptReceipt(retryMessageId, submittedAt)).resolves.toBe('queued');
		expect(repository.getMessage(retryMessageId)).toMatchObject({
			attemptCount: 1,
			nextAttemptAt: new Date(submittedAt.getTime() + 60_000),
			completedAt: null,
			lastErrorCode: 'PLUNK_TIMEOUT'
		});
		await expect(
			retryWorker.attemptReceipt(retryMessageId, new Date(submittedAt.getTime() + 60_000))
		).resolves.toBe('delivered');
		expect(repository.getMessage(retryMessageId)).toMatchObject({
			attemptCount: 2,
			providerDeliveryId: `delivery_${kind}_completed`,
			completedAt: new Date(submittedAt.getTime() + 60_000),
			lastErrorCode: null
		});

		const failedMessageId = insertPendingMessage(record.id, kind, 'permanent');
		const failedWorker = withdrawalWorker(
			vi.fn(async () => {
				throw new PlunkError('PLUNK_REQUEST_REJECTED');
			})
		);
		await expect(
			failedWorker.attemptReceipt(failedMessageId, new Date(submittedAt.getTime() + 120_000))
		).resolves.toBe('failed');
		expect(repository.getMessage(failedMessageId)).toMatchObject({
			attemptCount: 1,
			completedAt: new Date(submittedAt.getTime() + 120_000),
			lastErrorCode: 'PLUNK_REQUEST_REJECTED'
		});
		expect(
			database
				.prepare(
					`SELECT alert_code, alert_subject_id FROM outbox_jobs
					 WHERE alert_code = 'WITHDRAWAL_MESSAGE_UNSENT'`
				)
				.all()
		).toEqual([{ alert_code: 'WITHDRAWAL_MESSAGE_UNSENT', alert_subject_id: record.reference }]);
	});

	it('executes every authorized MCP transition and preserves non-EU support handling', async () => {
		const actionAt = new Date('2026-07-17T10:00:00.000Z');
		const eligible = await createQueuedCase({
			...partialInput,
			enteredOrderReference: 'MCP-ELIGIBLE-ORDER'
		});
		const ineligible = await createQueuedCase({
			...wholeOrderInput,
			enteredOrderReference: 'MCP-INELIGIBLE-ORDER'
		});
		const support = await createQueuedCase({
			...wholeOrderInput,
			enteredOrderReference: 'MCP-SUPPORT-ORDER'
		});
		const server = withdrawalMcpServer(actionAt);

		await callMcpTool(server, 'begin_withdrawal_review', {
			reference: eligible.result.reference,
			expected_status: 'submitted',
			expected_revision: 1
		});
		await callMcpTool(server, 'record_withdrawal_eligibility', {
			reference: eligible.result.reference,
			expected_status: 'reviewing',
			expected_revision: 2,
			decision: 'eligible_eu',
			internal_order_reference: 'internal-eligible-order',
			country_code: 'SE',
			customer_instructions: 'Use the reviewed registered return address.'
		});
		await callMcpTool(server, 'record_withdrawal_return', {
			reference: eligible.result.reference,
			expected_status: 'awaiting_return',
			expected_revision: 3,
			outcome: 'parcel_received',
			parcel_reference: 'registered-parcel-42'
		});
		await callMcpTool(server, 'close_withdrawal_case', {
			reference: eligible.result.reference,
			expected_status: 'awaiting_return',
			expected_revision: 4,
			outcome_code: 'eligible_return_received'
		});

		await callMcpTool(server, 'begin_withdrawal_review', {
			reference: ineligible.result.reference,
			expected_status: 'submitted',
			expected_revision: 1
		});
		await callMcpTool(server, 'record_withdrawal_eligibility', {
			reference: ineligible.result.reference,
			expected_status: 'reviewing',
			expected_revision: 2,
			decision: 'ineligible_non_eu',
			internal_order_reference: 'internal-ineligible-order',
			country_code: 'US'
		});
		await callMcpTool(server, 'close_withdrawal_case', {
			reference: ineligible.result.reference,
			expected_status: 'ineligible',
			expected_revision: 3,
			outcome_code: 'ineligible_non_eu'
		});

		await callMcpTool(server, 'begin_withdrawal_review', {
			reference: support.result.reference,
			expected_status: 'submitted',
			expected_revision: 1
		});
		await callMcpTool(server, 'record_withdrawal_eligibility', {
			reference: support.result.reference,
			expected_status: 'reviewing',
			expected_revision: 2,
			decision: 'support_handling',
			internal_order_reference: 'internal-support-order',
			country_code: 'US'
		});
		await callMcpTool(server, 'close_withdrawal_case', {
			reference: support.result.reference,
			expected_status: 'support_handling',
			expected_revision: 3,
			outcome_code: 'support_handling_completed'
		});

		const receipt = database
			.prepare(
				`SELECT id FROM withdrawal_messages WHERE case_id = ? AND kind = 'receipt' ORDER BY id`
			)
			.get(eligible.record.id) as { id: number };
		database
			.prepare(
				`UPDATE withdrawal_messages SET attempt_count = 1,
				 provider_delivery_id = 'delivery_mcp_receipt', completed_at = ? WHERE id = ?`
			)
			.run(actionAt.toISOString(), receipt.id);
		const preview = await callMcpTool(server, 'resend_withdrawal_message', {
			reference: eligible.result.reference,
			source_message_id: receipt.id,
			mode: 'preview'
		});
		expect(preview).toMatchObject({ mode: 'preview', queued: false });
		await callMcpTool(server, 'resend_withdrawal_message', {
			reference: eligible.result.reference,
			source_message_id: receipt.id,
			mode: 'confirm',
			preview_token: preview.preview_token,
			idempotency_key: '9f0f79ee-8f68-4b46-84c0-2533fdc127a1'
		});

		const listed = await callMcpTool(server, 'list_withdrawal_cases', { limit: 10 });
		expect(listed.cases).toHaveLength(3);
		const inspected = await callMcpTool(server, 'inspect_withdrawal_case', {
			reference: support.result.reference
		});
		expect(inspected).toMatchObject({
			status: 'closed',
			eligibility: 'support_handling',
			customer: {
				reconciliation: {
					country_code: 'US',
					internal_order_reference: 'internal-support-order'
				}
			}
		});
		expect(
			database
				.prepare(
					`SELECT kind FROM withdrawal_messages WHERE case_id = ? AND kind = 'support_handoff'`
				)
				.all(support.record.id)
		).toEqual([{ kind: 'support_handoff' }]);
		expect(rowCount('orders')).toBe(0);
	});

	it('rolls purge back on a late failure, then purges the due case and settles queued messages', async () => {
		const closed = await closeEligibleCase();
		expect(repository.purgeDue(new Date(closed.purgeDueAt.getTime() - 1), 100)).toBe(0);
		database.exec(`
			CREATE TRIGGER reject_purge_event BEFORE INSERT ON withdrawal_case_events
			WHEN NEW.action = 'pii_purged'
			BEGIN
				SELECT RAISE(ABORT, 'late purge event failure');
			END
		`);

		expect(() => repository.purgeDue(closed.purgeDueAt, 100)).toThrowError(
			'WITHDRAWAL_PURGE_FAILED'
		);
		expect(repository.loadEncryptedByReference(closed.reference)).not.toBeNull();
		expect(
			database
				.prepare('SELECT COUNT(*) AS count FROM withdrawal_messages WHERE completed_at IS NULL')
				.get()
		).toEqual({ count: 2 });

		database.exec('DROP TRIGGER reject_purge_event');
		expect(repository.purgeDue(closed.purgeDueAt, 100)).toBe(1);
		expect(repository.loadEncryptedByReference(closed.reference)).toBeNull();
		expect(
			database
				.prepare(
					`SELECT schema_version, encryption_key_version, encrypted_payload,
					 payload_nonce, payload_tag, dedupe_fingerprint, purged_at
					 FROM withdrawal_cases WHERE id = ?`
				)
				.get(closed.caseId)
		).toEqual({
			schema_version: null,
			encryption_key_version: null,
			encrypted_payload: null,
			payload_nonce: null,
			payload_tag: null,
			dedupe_fingerprint: null,
			purged_at: closed.purgeDueAt.toISOString()
		});
		expect(
			database
				.prepare(
					`SELECT COUNT(*) AS count FROM withdrawal_messages
					 WHERE completed_at = ? AND last_error_code = 'WITHDRAWAL_CASE_PURGED'`
				)
				.get(closed.purgeDueAt.toISOString())
		).toEqual({ count: 2 });
		expect(
			database
				.prepare(
					`SELECT actor, action, result_code FROM withdrawal_case_events
					 WHERE action = 'pii_purged'`
				)
				.all()
		).toEqual([{ actor: 'system', action: 'pii_purged', result_code: 'PII_PURGED' }]);
	});

	it('excludes retention while withdrawal delivery owns the shared guard', async () => {
		const closed = await closeEligibleCase();
		const alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
		let releaseDelivery!: () => void;
		const delivery = new Promise<void>((resolveDelivery) => {
			releaseDelivery = resolveDelivery;
		});
		const withdrawalDrain = vi.fn(() => delivery);
		const sending = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalWorker: { drain: withdrawalDrain },
			enabled: true,
			ownerId: 'integration-delivery',
			clock: () => closed.purgeDueAt
		});
		const retention = new OutboxScheduler({
			database,
			leases: new SqliteLeaseRepository(database),
			worker: { drain: vi.fn(async () => ({ completed: 0, rescheduled: 0 })) },
			withdrawalRetention: new SqliteWithdrawalRetentionJob({ repository, alerts }),
			enabled: true,
			ownerId: 'integration-retention',
			clock: () => closed.purgeDueAt
		});

		const activeDelivery = sending.runOutboxOnce(closed.purgeDueAt);
		await vi.waitFor(() => expect(withdrawalDrain).toHaveBeenCalledOnce());
		await retention.runWithdrawalRetentionOnce?.(closed.purgeDueAt);
		expect(repository.getByReference(closed.reference)?.purgedAt).toBeNull();

		releaseDelivery();
		await activeDelivery;
		await retention.runWithdrawalRetentionOnce?.(closed.purgeDueAt);
		expect(repository.getByReference(closed.reference)?.purgedAt).toEqual(closed.purgeDueAt);
	});

	it('restores active and purged case states from separate SQLite backup snapshots', async () => {
		const active = await createQueuedCase({
			...partialInput,
			enteredOrderReference: 'ACTIVE-BACKUP-ORDER'
		});
		const activeBackup = join(directory, 'active.sqlite');
		const purgedBackup = join(directory, 'purged.sqlite');
		await database.backup(activeBackup);

		const closed = await closeEligibleCase();
		expect(repository.purgeDue(closed.purgeDueAt, 100)).toBe(1);
		await database.backup(purgedBackup);

		const restoredActivePath = join(directory, 'restored-active.sqlite');
		const restoredPurgedPath = join(directory, 'restored-purged.sqlite');
		await copyFile(activeBackup, restoredActivePath);
		await copyFile(purgedBackup, restoredPurgedPath);
		const restoredActive = openFixtureDatabase(restoredActivePath);
		const restoredPurged = openFixtureDatabase(restoredPurgedPath);
		try {
			const activeRepository = new SqliteWithdrawalRepository(restoredActive);
			const activeReader = new WithdrawalCaseReader({
				repository: activeRepository,
				dataKey,
				alerts: new SqliteAlertService(new SqliteOutboxRepository(restoredActive))
			});
			expect(
				activeReader.inspectActive(active.result.reference, submittedAt).payload
			).toMatchObject({
				enteredOrderReference: 'ACTIVE-BACKUP-ORDER'
			});
			const purgedRepository = new SqliteWithdrawalRepository(restoredPurged);
			expect(purgedRepository.getByReference(closed.reference)).toMatchObject({
				status: 'closed',
				purgedAt: closed.purgeDueAt
			});
			expect(purgedRepository.loadEncryptedByReference(closed.reference)).toBeNull();
		} finally {
			restoredActive.close();
			restoredPurged.close();
		}
	});

	it('deduplicates simultaneous exact submissions from independent process connections', async () => {
		const root = resolve('.');
		const runnerPath = join(directory, 'withdrawal-race-runner.mjs');
		const releasePath = join(directory, 'release');
		const readyPaths = [join(directory, 'ready-1'), join(directory, 'ready-2')];
		const outputPaths = [join(directory, 'output-1.json'), join(directory, 'output-2.json')];
		const configPaths = [join(directory, 'config-1.json'), join(directory, 'config-2.json')];
		const runner = `
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('$lib/')) {
      const base = join(config.root, 'src/lib', specifier.slice(5));
      for (const candidate of [base, base + '.ts', join(base, 'index.ts')]) {
        if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
      }
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const candidate of [base, base + '.ts', join(base, 'index.ts')]) {
        if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
      }
    }
    return nextResolve(specifier, context);
  }
});
const require = createRequire(join(config.root, 'package.json'));
const Database = require('better-sqlite3');
const { SqliteWithdrawalRepository } = await import(pathToFileURL(join(config.root,
  'src/lib/server/withdrawals/repository.server.ts')).href);
const { WithdrawalSubmissionService } = await import(pathToFileURL(join(config.root,
  'src/lib/server/withdrawals/submission.server.ts')).href);
const database = new Database(config.databasePath);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.pragma('busy_timeout = 5000');
database.pragma('synchronous = FULL');
const repository = new SqliteWithdrawalRepository(database);
const gatedRepository = {
  getMessage: repository.getMessage.bind(repository),
  createSubmission(input) {
    writeFileSync(config.readyPath, 'ready', { mode: 0o600 });
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(config.releasePath)) Atomics.wait(wait, 0, 0, 10);
    return repository.createSubmission(input);
  }
};
const service = new WithdrawalSubmissionService({
  repository: gatedRepository,
  dispatcher: { attemptReceipt: async () => 'queued' },
  dataKey: Buffer.from(config.dataKey, 'base64')
});
try {
  const result = await service.submit(config.input, new Date(config.submittedAt));
  writeFileSync(config.outputPath, JSON.stringify({
    reference: result.reference,
    scope: result.scope,
    deliveryState: result.deliveryState
  }), { mode: 0o600 });
} finally {
  database.close();
}
`;
		await writeFile(runnerPath, runner, { mode: 0o600 });
		for (const index of [0, 1]) {
			await writeFile(
				configPaths[index],
				JSON.stringify({
					root,
					databasePath,
					readyPath: readyPaths[index],
					releasePath,
					outputPath: outputPaths[index],
					dataKey: dataKey.toString('base64'),
					input: wholeOrderInput,
					submittedAt: submittedAt.toISOString()
				}),
				{ mode: 0o600 }
			);
		}

		const children = configPaths.map((path) => runRaceChild(runnerPath, path));
		await waitForRaceBarrier(readyPaths, children);
		await writeFile(releasePath, 'release', { mode: 0o600 });
		const childResults = await Promise.all(children);

		expect(childResults).toEqual([
			expect.objectContaining({ code: 0, stderr: '' }),
			expect.objectContaining({ code: 0, stderr: '' })
		]);
		const results = await Promise.all(
			outputPaths.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as unknown)
		);
		expect(results[0]).toEqual(results[1]);
		expect(results[0]).toMatchObject({ scope: 'entire_order', deliveryState: 'queued' });
		expect(
			database
				.prepare(
					`SELECT
					 (SELECT COUNT(*) FROM withdrawal_cases) AS cases,
					 (SELECT COUNT(*) FROM withdrawal_messages WHERE kind = 'receipt') AS receipts,
					 (SELECT COUNT(*) FROM outbox_jobs
					  WHERE alert_code = 'WITHDRAWAL_NOTICE_RECEIVED') AS alerts,
					 (SELECT COUNT(*) FROM withdrawal_case_events
					  WHERE result_code = 'NOTICE_RECEIVED') AS events`
				)
				.get()
		).toEqual({ cases: 1, receipts: 1, alerts: 1, events: 1 });
	}, 20_000);
});
