import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CanonicalWithdrawalInput } from '$lib/domain/withdrawals';
import { migrate } from '$lib/server/db/migrate.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import { WithdrawalMessageWorker } from '$lib/server/jobs/withdrawal-worker.server';
import { createLogger } from '$lib/server/logging/logger.server';
import { createMcpServer, type McpServices } from '$lib/server/mcp/server';
import { SqliteAlertService } from '$lib/server/monitoring/alerts.server';
import { WithdrawalCaseReader } from '$lib/server/withdrawals/case-reader.server';
import { decryptWithdrawalPayload } from '$lib/server/withdrawals/crypto.server';
import { renderWithdrawalReceiptText } from '$lib/server/withdrawals/receipt.server';
import { SqliteWithdrawalRepository } from '$lib/server/withdrawals/repository.server';
import { WithdrawalSubmissionService } from '$lib/server/withdrawals/submission.server';
import { WithdrawalWorkflowService } from '$lib/server/withdrawals/workflow.server';

const migrationsDirectory = resolve('migrations');
const now = new Date('2026-07-18T09:15:00.000Z');
const dataKey = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
const seller = {
	legalName: 'Svelte Society Merch AB',
	registrationNumber: '559999-0000',
	addressLine1: 'Registered Street 1',
	postalCode: '111 11',
	city: 'Stockholm',
	country: 'Sweden',
	email: 'merch@sveltesociety.dev'
};
const canaries = {
	fullName: 'Artifact Canary Fullname ZQX-731',
	receiptEmail: 'artifact-canary-731@example.test',
	enteredOrderReference: 'ENTERED-ORDER-CANARY-ZQX-731',
	item: 'Artifact Canary Hoodie ZQX-731',
	internalOrderReference: 'INTERNAL-RECON-CANARY-ZQX-731',
	receiptBody: 'Receipt Body Canary ZQX-731',
	plunkBody: 'PLUNK-BODY-CANARY-ZQX-731',
	authorization: 'Bearer authorization-canary-zqx-731',
	cookie: 'withdrawal_cookie=COOKIE-CANARY-ZQX-731',
	token: 'TOKEN-CANARY-ZQX-731',
	key: dataKey.toString('base64')
};
const input: CanonicalWithdrawalInput = {
	fullName: canaries.fullName,
	receiptEmail: canaries.receiptEmail,
	enteredOrderReference: canaries.enteredOrderReference,
	scope: 'specific_items',
	items: [{ description: canaries.item, quantity: 2 }]
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

function services(): McpServices {
	const alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
	const reader = new WithdrawalCaseReader({ repository, dataKey, alerts });
	return {
		withdrawals: {
			listCases: repository.list.bind(repository),
			inspectCase(reference: string) {
				const inspection = reader.inspectActive(reference, now);
				return { inspection, history: repository.getInspectionHistory(inspection.id) };
			}
		}
	};
}

async function callTool(
	server: ReturnType<typeof createMcpServer>,
	name: string,
	args: Record<string, unknown>
) {
	return (await server.receive({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name, arguments: args }
	})) as {
		result: {
			isError?: boolean;
			structuredContent?: Record<string, unknown>;
		};
	};
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'withdrawal-security-'));
	databasePath = join(directory, 'shop.sqlite');
	database = openFixtureDatabase(databasePath);
	migrate(database, migrationsDirectory);
	repository = new SqliteWithdrawalRepository(database);
});

afterEach(async () => {
	database.close();
	await rm(directory, { recursive: true, force: true });
});

describe('withdrawal artifact and response security', () => {
	it('keeps customer, reconciliation, receipt, provider, credential, and key canaries out of SQLite sidecars and structured logs', async () => {
		const submission = new WithdrawalSubmissionService({
			repository,
			dispatcher: { attemptReceipt: async () => 'queued' },
			dataKey
		});
		const submitted = await submission.submit(input, now);
		const alerts = new SqliteAlertService(new SqliteOutboxRepository(database));
		const reader = new WithdrawalCaseReader({ repository, dataKey, alerts });
		const workflow = new WithdrawalWorkflowService({ database, repository, reader, dataKey });
		workflow.beginReview({
			reference: submitted.reference,
			expectedStatus: 'submitted',
			expectedRevision: 1,
			now
		});
		workflow.recordEligibility({
			reference: submitted.reference,
			expectedStatus: 'reviewing',
			expectedRevision: 2,
			decision: 'eligible_eu',
			internalOrderReference: canaries.internalOrderReference,
			countryCode: 'SE',
			customerInstructions: canaries.plunkBody,
			now
		});

		const inspection = reader.inspectActive(submitted.reference, now);
		const receipt = `${renderWithdrawalReceiptText(inspection, seller)}\n${canaries.receiptBody}`;
		expect(receipt).toContain(canaries.fullName);
		expect(receipt).toContain(canaries.item);
		expect(receipt).toContain(canaries.receiptBody);

		const eligibleMessage = database
			.prepare(
				`SELECT id FROM withdrawal_messages
				 WHERE case_id = ? AND kind = 'eligible_instructions'`
			)
			.get(inspection.id) as { id: number };
		let attemptedProviderBody = '';
		const worker = new WithdrawalMessageWorker({
			repository,
			reader,
			plunk: {
				async send(providerMessage) {
					attemptedProviderBody = providerMessage.html;
					throw new Error(`provider failure ${canaries.plunkBody}`);
				}
			},
			alerts,
			from: { name: 'Svelte Society Shop', email: 'merch@sveltesociety.dev' },
			supportEmail: 'merch@sveltesociety.dev',
			productionOrigin: new URL('https://merch.sveltesociety.dev'),
			seller
		});
		expect(await worker.attemptReceipt(eligibleMessage.id, now)).toBe('queued');
		expect(attemptedProviderBody).toContain(canaries.plunkBody);
		expect(repository.getMessage(eligibleMessage.id)?.lastErrorCode).toBe(
			'WITHDRAWAL_MESSAGE_FAILED'
		);

		const logLines: string[] = [];
		const log = createLogger((serialized) => logLines.push(serialized));
		log({
			level: 'error',
			code: 'WITHDRAWAL_SECURITY_CANARY',
			fields: {
				full_name: canaries.fullName,
				receipt_email: canaries.receiptEmail,
				entered_order_reference: canaries.enteredOrderReference,
				items: canaries.item,
				internal_order_reference: canaries.internalOrderReference,
				body: `${canaries.receiptBody} ${canaries.plunkBody}`,
				provider_response: canaries.plunkBody,
				authorization: canaries.authorization,
				cookie: canaries.cookie,
				preview_token: canaries.token,
				withdrawal_data_key: canaries.key
			}
		});

		database.pragma('wal_checkpoint(PASSIVE)');
		const artifactPaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
		const artifacts = await Promise.all(artifactPaths.map((path) => readFile(path)));
		const plaintextCanaries = Object.values(canaries);
		for (const [index, artifact] of artifacts.entries()) {
			for (const canary of plaintextCanaries) {
				expect(
					artifact.includes(Buffer.from(canary, 'utf8')),
					`${artifactPaths[index]} contains plaintext canary ${canary}`
				).toBe(false);
			}
		}
		const serializedLogs = logLines.join('\n');
		for (const canary of plaintextCanaries) expect(serializedLogs).not.toContain(canary);
		expect(serializedLogs).toContain('[REDACTED]');

		const encrypted = repository.loadEncryptedByReference(submitted.reference);
		expect(encrypted).not.toBeNull();
		const recovered = decryptWithdrawalPayload(encrypted!.encryptedPayload, encrypted!.id, dataKey);
		expect(recovered).toEqual({
			fullName: canaries.fullName,
			receiptEmail: canaries.receiptEmail,
			enteredOrderReference: canaries.enteredOrderReference,
			items: [{ description: canaries.item, quantity: 2 }],
			reconciliation: {
				internalOrderReference: canaries.internalOrderReference,
				countryCode: 'SE',
				customerInstructions: canaries.plunkBody,
				returnOutcome: null,
				parcelReference: null
			}
		});
	});

	it('keeps submission, list, and error response envelopes fixed and limits returned PII', async () => {
		const submission = new WithdrawalSubmissionService({
			repository,
			dispatcher: { attemptReceipt: async () => 'queued' },
			dataKey
		});
		const submitted = await submission.submit(input, now);
		expect(Object.keys(submitted).sort()).toEqual([
			'createdAt',
			'deliveryState',
			'enteredOrderReference',
			'reference',
			'scope'
		]);
		expect(JSON.stringify(submitted)).not.toContain(canaries.fullName);
		expect(JSON.stringify(submitted)).not.toContain(canaries.receiptEmail);
		expect(JSON.stringify(submitted)).not.toContain(canaries.item);
		expect(submitted.enteredOrderReference).toBe(canaries.enteredOrderReference);

		const server = createMcpServer(services());
		const listed = await callTool(server, 'list_withdrawal_cases', { limit: 10 });
		expect(listed.result.isError).not.toBe(true);
		const listContent = listed.result.structuredContent as {
			cases: Array<Record<string, unknown>>;
		};
		expect(Object.keys(listContent)).toEqual(['cases']);
		expect(Object.keys(listContent.cases[0]).sort()).toEqual([
			'closed_at',
			'created_at',
			'eligibility',
			'outcome_code',
			'purged_at',
			'reference',
			'scope',
			'status',
			'updated_at'
		]);
		const serializedList = JSON.stringify(listContent);
		for (const canary of Object.values(canaries)) expect(serializedList).not.toContain(canary);

		const invalid = await callTool(server, 'inspect_withdrawal_case', {
			reference: canaries.enteredOrderReference
		});
		expect(invalid.result.isError).toBe(true);
		expect(invalid.result.structuredContent).toEqual({
			error: { code: 'INVALID_TOOL_ARGUMENTS' }
		});
		const missing = await callTool(server, 'inspect_withdrawal_case', {
			reference: 'WDR-0000000000000000000000'
		});
		expect(missing.result.isError).toBe(true);
		expect(missing.result.structuredContent).toEqual({
			error: { code: 'WITHDRAWAL_CASE_INSPECTION_FAILED' }
		});
		for (const response of [invalid, missing]) {
			const serialized = JSON.stringify(response.result.structuredContent);
			for (const canary of Object.values(canaries)) expect(serialized).not.toContain(canary);
		}
	});
});
