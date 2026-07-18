import { Buffer } from 'node:buffer';
import type {
	WithdrawalEligibility,
	WithdrawalScope,
	WithdrawalStatus
} from '$lib/domain/withdrawals';
import type { ShopDatabase } from '$lib/server/db/types';
import type { EncryptedWithdrawalPayload } from './crypto.server';

export type CreateWithdrawalSubmission = {
	id: string;
	reference: string;
	scope: WithdrawalScope;
	encryptedPayload: EncryptedWithdrawalPayload;
	dedupeFingerprint: string;
	createdAt: Date;
};

export type WithdrawalCaseRecord = {
	id: string;
	reference: string;
	status: WithdrawalStatus;
	revision: number;
	scope: WithdrawalScope;
	eligibility: WithdrawalEligibility;
	outcomeCode: string | null;
	createdAt: Date;
	updatedAt: Date;
	reconciledAt: Date | null;
	closedAt: Date | null;
	piiPurgeDueAt: Date | null;
	purgedAt: Date | null;
};

export type EncryptedWithdrawalCaseRecord = WithdrawalCaseRecord & {
	encryptedPayload: EncryptedWithdrawalPayload;
};

export type WithdrawalCaseSummary = Omit<WithdrawalCaseRecord, 'id'>;

export type WithdrawalListInput = {
	status?: WithdrawalStatus;
	limit: number;
};

export type WithdrawalMessageKind =
	'receipt' | 'eligible_instructions' | 'ineligible_decision' | 'support_handoff' | 'resend';

export type WithdrawalMessage = {
	id: number;
	caseId: string;
	kind: WithdrawalMessageKind;
	resendOfMessageId: number | null;
	idempotencyKey: string;
	attemptCount: number;
	nextAttemptAt: Date;
	providerDeliveryId: string | null;
	completedAt: Date | null;
	lastErrorCode: string | null;
};

export type WithdrawalCaseEventMetadata = {
	actor: 'customer' | 'codex-admin' | 'system';
	action: string;
	priorStatus: WithdrawalStatus | null;
	nextStatus: WithdrawalStatus;
	resultCode: string;
	createdAt: Date;
};

export type WithdrawalMessageDeliveryMetadata = {
	sourceMessageId: WithdrawalMessage['id'];
} & Pick<
	WithdrawalMessage,
	'kind' | 'attemptCount' | 'nextAttemptAt' | 'providerDeliveryId' | 'completedAt' | 'lastErrorCode'
>;

export type WithdrawalInspectionHistory = {
	events: WithdrawalCaseEventMetadata[];
	messages: WithdrawalMessageDeliveryMetadata[];
};

export type CreateSubmissionResult = {
	created: boolean;
	case: WithdrawalCaseRecord;
	receiptMessageId: number;
};

type CaseRow = {
	id: unknown;
	public_reference: unknown;
	status: unknown;
	revision: unknown;
	scope: unknown;
	eligibility: unknown;
	outcome_code: unknown;
	schema_version: unknown;
	encryption_key_version: unknown;
	encrypted_payload: unknown;
	payload_nonce: unknown;
	payload_tag: unknown;
	dedupe_fingerprint: unknown;
	created_at: unknown;
	updated_at: unknown;
	reconciled_at: unknown;
	closed_at: unknown;
	pii_purge_due_at: unknown;
	purged_at: unknown;
};

type MessageRow = {
	id: unknown;
	case_id: unknown;
	kind: unknown;
	resend_of_message_id: unknown;
	idempotency_key: unknown;
	attempt_count: unknown;
	next_attempt_at: unknown;
	provider_delivery_id: unknown;
	completed_at: unknown;
	last_error_code: unknown;
};

type CaseEventRow = {
	actor: unknown;
	action: unknown;
	prior_status: unknown;
	next_status: unknown;
	result_code: unknown;
	created_at: unknown;
};

const CASE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;
const REFERENCE_PATTERN = /^WDR-[A-Za-z0-9_-]{22}$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const CLAIM_LEASE_MILLISECONDS = 5 * 60_000;
const DEDUPE_WINDOW_MILLISECONDS = 24 * 60 * 60_000;
const statuses = new Set<WithdrawalStatus>([
	'submitted',
	'reviewing',
	'awaiting_return',
	'ineligible',
	'support_handling',
	'closed'
]);
const scopes = new Set<WithdrawalScope>(['entire_order', 'specific_items']);
const eligibilities = new Set<WithdrawalEligibility>([
	'pending',
	'eligible_eu',
	'ineligible_non_eu',
	'support_handling'
]);
const messageKinds = new Set<WithdrawalMessageKind>([
	'receipt',
	'eligible_instructions',
	'ineligible_decision',
	'support_handoff',
	'resend'
]);
const eventActors = new Set<WithdrawalCaseEventMetadata['actor']>([
	'customer',
	'codex-admin',
	'system'
]);
const EVENT_ACTION_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;

class WithdrawalRepositoryError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = 'WithdrawalRepositoryError';
		this.code = code;
	}
}

const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

export function isWithdrawalProviderDeliveryId(value: unknown): value is string {
	return typeof value === 'string' && PROVIDER_ID_PATTERN.test(value);
}

function isStableErrorCode(value: unknown): value is string {
	return typeof value === 'string' && STABLE_ERROR_CODE_PATTERN.test(value);
}

function fail(code: string): never {
	throw new WithdrawalRepositoryError(code);
}

function isoTimestamp(value: Date, invalidCode: string): string {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(invalidCode);
	return value.toISOString();
}

function dateFromIso(value: unknown, invalidCode: string): Date {
	if (typeof value !== 'string') fail(invalidCode);
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(invalidCode);
	return parsed;
}

function nullableDateFromIso(value: unknown, invalidCode: string): Date | null {
	return value === null ? null : dateFromIso(value, invalidCode);
}

function isCaseId(value: unknown): value is string {
	return typeof value === 'string' && CASE_ID_PATTERN.test(value);
}

function isReference(value: unknown): value is string {
	return typeof value === 'string' && REFERENCE_PATTERN.test(value);
}

function isStatus(value: unknown): value is WithdrawalStatus {
	return typeof value === 'string' && statuses.has(value as WithdrawalStatus);
}

function isScope(value: unknown): value is WithdrawalScope {
	return typeof value === 'string' && scopes.has(value as WithdrawalScope);
}

function isEligibility(value: unknown): value is WithdrawalEligibility {
	return typeof value === 'string' && eligibilities.has(value as WithdrawalEligibility);
}

function isMessageKind(value: unknown): value is WithdrawalMessageKind {
	return typeof value === 'string' && messageKinds.has(value as WithdrawalMessageKind);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 300;
}

function activeEncryptionShape(row: CaseRow): boolean {
	return (
		row.purged_at === null &&
		row.schema_version === 1 &&
		row.encryption_key_version === 1 &&
		Buffer.isBuffer(row.encrypted_payload) &&
		row.encrypted_payload.length > 0 &&
		Buffer.isBuffer(row.payload_nonce) &&
		row.payload_nonce.length === 12 &&
		Buffer.isBuffer(row.payload_tag) &&
		row.payload_tag.length === 16 &&
		typeof row.dedupe_fingerprint === 'string' &&
		FINGERPRINT_PATTERN.test(row.dedupe_fingerprint)
	);
}

function purgedEncryptionShape(row: CaseRow): boolean {
	return (
		typeof row.purged_at === 'string' &&
		row.schema_version === null &&
		row.encryption_key_version === null &&
		row.encrypted_payload === null &&
		row.payload_nonce === null &&
		row.payload_tag === null &&
		row.dedupe_fingerprint === null
	);
}

function mapCase(row: CaseRow): WithdrawalCaseRecord {
	if (
		!isCaseId(row.id) ||
		!isReference(row.public_reference) ||
		!isStatus(row.status) ||
		!Number.isSafeInteger(row.revision) ||
		(row.revision as number) < 1 ||
		!isScope(row.scope) ||
		!isEligibility(row.eligibility) ||
		(row.outcome_code !== null && !isStableErrorCode(row.outcome_code)) ||
		(!activeEncryptionShape(row) && !purgedEncryptionShape(row))
	) {
		fail('WITHDRAWAL_CASE_ROW_INVALID');
	}
	const createdAt = dateFromIso(row.created_at, 'WITHDRAWAL_CASE_ROW_INVALID');
	const updatedAt = dateFromIso(row.updated_at, 'WITHDRAWAL_CASE_ROW_INVALID');
	const reconciledAt = nullableDateFromIso(row.reconciled_at, 'WITHDRAWAL_CASE_ROW_INVALID');
	const closedAt = nullableDateFromIso(row.closed_at, 'WITHDRAWAL_CASE_ROW_INVALID');
	const piiPurgeDueAt = nullableDateFromIso(row.pii_purge_due_at, 'WITHDRAWAL_CASE_ROW_INVALID');
	const purgedAt = nullableDateFromIso(row.purged_at, 'WITHDRAWAL_CASE_ROW_INVALID');
	if (updatedAt < createdAt) fail('WITHDRAWAL_CASE_ROW_INVALID');
	return {
		id: row.id,
		reference: row.public_reference,
		status: row.status,
		revision: row.revision as number,
		scope: row.scope,
		eligibility: row.eligibility,
		outcomeCode: row.outcome_code as string | null,
		createdAt,
		updatedAt,
		reconciledAt,
		closedAt,
		piiPurgeDueAt,
		purgedAt
	};
}

function mapEncryptedCase(row: CaseRow): EncryptedWithdrawalCaseRecord {
	const record = mapCase(row);
	if (!activeEncryptionShape(row)) fail('WITHDRAWAL_CASE_ROW_INVALID');
	return {
		...record,
		encryptedPayload: {
			schemaVersion: 1,
			keyVersion: 1,
			ciphertext: Buffer.from(row.encrypted_payload as Buffer),
			nonce: Buffer.from(row.payload_nonce as Buffer),
			tag: Buffer.from(row.payload_tag as Buffer)
		}
	};
}

function mapMessage(row: MessageRow): WithdrawalMessage {
	if (
		!Number.isSafeInteger(row.id) ||
		(row.id as number) < 1 ||
		!isCaseId(row.case_id) ||
		!isMessageKind(row.kind) ||
		!isNonEmptyString(row.idempotency_key) ||
		!Number.isSafeInteger(row.attempt_count) ||
		(row.attempt_count as number) < 0 ||
		(row.provider_delivery_id !== null &&
			!isWithdrawalProviderDeliveryId(row.provider_delivery_id)) ||
		(row.last_error_code !== null && !isStableErrorCode(row.last_error_code))
	) {
		fail('WITHDRAWAL_MESSAGE_ROW_INVALID');
	}
	const resendOfMessageId =
		row.resend_of_message_id === null
			? null
			: Number.isSafeInteger(row.resend_of_message_id) && (row.resend_of_message_id as number) >= 1
				? (row.resend_of_message_id as number)
				: fail('WITHDRAWAL_MESSAGE_ROW_INVALID');
	if ((row.kind === 'resend') !== (resendOfMessageId !== null)) {
		fail('WITHDRAWAL_MESSAGE_ROW_INVALID');
	}
	return {
		id: row.id as number,
		caseId: row.case_id,
		kind: row.kind,
		resendOfMessageId,
		idempotencyKey: row.idempotency_key,
		attemptCount: row.attempt_count as number,
		nextAttemptAt: dateFromIso(row.next_attempt_at, 'WITHDRAWAL_MESSAGE_ROW_INVALID'),
		providerDeliveryId: row.provider_delivery_id as string | null,
		completedAt: nullableDateFromIso(row.completed_at, 'WITHDRAWAL_MESSAGE_ROW_INVALID'),
		lastErrorCode: row.last_error_code as string | null
	};
}

function mapCaseEvent(row: CaseEventRow): WithdrawalCaseEventMetadata {
	if (
		typeof row.actor !== 'string' ||
		!eventActors.has(row.actor as WithdrawalCaseEventMetadata['actor']) ||
		typeof row.action !== 'string' ||
		!EVENT_ACTION_PATTERN.test(row.action) ||
		(row.prior_status !== null && !isStatus(row.prior_status)) ||
		!isStatus(row.next_status) ||
		!isStableErrorCode(row.result_code)
	) {
		fail('WITHDRAWAL_EVENT_ROW_INVALID');
	}
	return {
		actor: row.actor as WithdrawalCaseEventMetadata['actor'],
		action: row.action,
		priorStatus: row.prior_status as WithdrawalStatus | null,
		nextStatus: row.next_status,
		resultCode: row.result_code,
		createdAt: dateFromIso(row.created_at, 'WITHDRAWAL_EVENT_ROW_INVALID')
	};
}

function messageDeliveryMetadata(message: WithdrawalMessage): WithdrawalMessageDeliveryMetadata {
	return {
		sourceMessageId: message.id,
		kind: message.kind,
		attemptCount: message.attemptCount,
		nextAttemptAt: message.nextAttemptAt,
		providerDeliveryId: message.providerDeliveryId,
		completedAt: message.completedAt,
		lastErrorCode: message.lastErrorCode
	};
}

function validateEncryptedPayload(value: EncryptedWithdrawalPayload): void {
	if (
		!value ||
		value.schemaVersion !== 1 ||
		value.keyVersion !== 1 ||
		!Buffer.isBuffer(value.ciphertext) ||
		value.ciphertext.length === 0 ||
		!Buffer.isBuffer(value.nonce) ||
		value.nonce.length !== 12 ||
		!Buffer.isBuffer(value.tag) ||
		value.tag.length !== 16
	) {
		fail('WITHDRAWAL_SUBMISSION_INVALID');
	}
}

function validateSubmission(input: CreateWithdrawalSubmission): string {
	if (
		!input ||
		!isCaseId(input.id) ||
		!isReference(input.reference) ||
		!isScope(input.scope) ||
		typeof input.dedupeFingerprint !== 'string' ||
		!FINGERPRINT_PATTERN.test(input.dedupeFingerprint)
	) {
		fail('WITHDRAWAL_SUBMISSION_INVALID');
	}
	validateEncryptedPayload(input.encryptedPayload);
	return isoTimestamp(input.createdAt, 'WITHDRAWAL_SUBMISSION_INVALID');
}

function validateMessageId(id: number): void {
	if (!Number.isSafeInteger(id) || id < 1) fail('WITHDRAWAL_MESSAGE_INVALID');
}

function validateExpectedAttempt(expectedAttemptCount: number): void {
	if (!Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 1) {
		fail('WITHDRAWAL_MESSAGE_INVALID');
	}
}

function summary(record: WithdrawalCaseRecord): WithdrawalCaseSummary {
	return {
		reference: record.reference,
		status: record.status,
		revision: record.revision,
		scope: record.scope,
		eligibility: record.eligibility,
		outcomeCode: record.outcomeCode,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		reconciledAt: record.reconciledAt,
		closedAt: record.closedAt,
		piiPurgeDueAt: record.piiPurgeDueAt,
		purgedAt: record.purgedAt
	};
}

export class SqliteWithdrawalRepository {
	constructor(private readonly database: ShopDatabase) {}

	createSubmission(input: CreateWithdrawalSubmission): CreateSubmissionResult {
		const createdAt = validateSubmission(input);
		const dedupeThreshold = new Date(
			input.createdAt.getTime() - DEDUPE_WINDOW_MILLISECONDS
		).toISOString();
		const findDuplicate = this.database.prepare(`
			SELECT * FROM withdrawal_cases
			WHERE dedupe_fingerprint = ? AND created_at >= ?
			ORDER BY created_at DESC, id DESC
			LIMIT 1
		`);
		const findReceipt = this.database.prepare(`
			SELECT * FROM withdrawal_messages
			WHERE case_id = ? AND kind = 'receipt'
			ORDER BY id
			LIMIT 1
		`);
		const insertCase = this.database.prepare(`
			INSERT INTO withdrawal_cases (
				id, public_reference, status, revision, scope, eligibility, outcome_code,
				schema_version, encryption_key_version, encrypted_payload, payload_nonce,
				payload_tag, dedupe_fingerprint, created_at, updated_at,
				reconciled_at, closed_at, pii_purge_due_at, purged_at
			) VALUES (?, ?, 'submitted', 1, ?, 'pending', NULL, 1, 1, ?, ?, ?, ?, ?, ?,
				NULL, NULL, NULL, NULL)
		`);
		const insertReceipt = this.database.prepare(`
			INSERT INTO withdrawal_messages (
				case_id, kind, resend_of_message_id, idempotency_key,
				attempt_count, next_attempt_at, provider_delivery_id, completed_at, last_error_code
			) VALUES (?, 'receipt', NULL, ?, 0, ?, NULL, NULL, NULL)
		`);
		const insertAlert = this.database.prepare(`
			INSERT INTO outbox_jobs (
				kind, idempotency_key, order_id, attempt_count, next_attempt_at,
				completed_at, last_error_code, alert_code, alert_subject_id, alert_observed_at
			) VALUES ('operational-alert', ?, NULL, 0, ?, NULL, NULL,
				'WITHDRAWAL_NOTICE_RECEIVED', ?, ?)
		`);
		const insertEvent = this.database.prepare(`
			INSERT INTO withdrawal_case_events (
				case_id, actor, action, prior_status, next_status, result_code, created_at
			) VALUES (?, 'customer', 'submitted', NULL, 'submitted', 'NOTICE_RECEIVED', ?)
		`);
		const findCreated = this.database.prepare('SELECT * FROM withdrawal_cases WHERE id = ?');
		const create = this.database.transaction((): CreateSubmissionResult => {
			const duplicate = findDuplicate.get(input.dedupeFingerprint, dedupeThreshold) as
				CaseRow | undefined;
			if (duplicate) {
				const duplicateCase = mapCase(duplicate);
				const receiptRow = findReceipt.get(duplicateCase.id) as MessageRow | undefined;
				if (!receiptRow) fail('WITHDRAWAL_MESSAGE_ROW_INVALID');
				const receipt = mapMessage(receiptRow);
				if (
					receipt.kind !== 'receipt' ||
					receipt.idempotencyKey !== `withdrawal:receipt:${duplicateCase.id}`
				) {
					fail('WITHDRAWAL_MESSAGE_ROW_INVALID');
				}
				return { created: false, case: duplicateCase, receiptMessageId: receipt.id };
			}

			insertCase.run(
				input.id,
				input.reference,
				input.scope,
				input.encryptedPayload.ciphertext,
				input.encryptedPayload.nonce,
				input.encryptedPayload.tag,
				input.dedupeFingerprint,
				createdAt,
				createdAt
			);
			const receiptResult = insertReceipt.run(
				input.id,
				`withdrawal:receipt:${input.id}`,
				createdAt
			);
			const alertKey = `alert:WITHDRAWAL_NOTICE_RECEIVED:${input.reference}:${createdAt.slice(0, 13)}`;
			insertAlert.run(alertKey, createdAt, input.reference, createdAt);
			insertEvent.run(input.id, createdAt);
			const created = findCreated.get(input.id) as CaseRow | undefined;
			const receiptMessageId = Number(receiptResult.lastInsertRowid);
			if (!created || !Number.isSafeInteger(receiptMessageId) || receiptMessageId < 1) {
				fail('WITHDRAWAL_SUBMISSION_FAILED');
			}
			return { created: true, case: mapCase(created), receiptMessageId };
		});

		try {
			return create.immediate();
		} catch (error) {
			if (error instanceof WithdrawalRepositoryError) throw error;
			fail('WITHDRAWAL_SUBMISSION_FAILED');
		}
	}

	getByReference(reference: string): WithdrawalCaseRecord | null {
		if (!isReference(reference)) fail('WITHDRAWAL_REFERENCE_INVALID');
		const row = this.database
			.prepare('SELECT * FROM withdrawal_cases WHERE public_reference = ?')
			.get(reference) as CaseRow | undefined;
		return row ? mapCase(row) : null;
	}

	loadEncryptedByReference(reference: string): EncryptedWithdrawalCaseRecord | null {
		if (!isReference(reference)) fail('WITHDRAWAL_REFERENCE_INVALID');
		const row = this.database
			.prepare('SELECT * FROM withdrawal_cases WHERE public_reference = ?')
			.get(reference) as CaseRow | undefined;
		if (!row) return null;
		if (row.purged_at !== null) {
			mapCase(row);
			return null;
		}
		return mapEncryptedCase(row);
	}

	loadEncryptedById(id: string): EncryptedWithdrawalCaseRecord | null {
		if (!isCaseId(id)) fail('WITHDRAWAL_CASE_ID_INVALID');
		const row = this.database.prepare('SELECT * FROM withdrawal_cases WHERE id = ?').get(id) as
			CaseRow | undefined;
		if (!row) return null;
		if (row.purged_at !== null) {
			mapCase(row);
			return null;
		}
		return mapEncryptedCase(row);
	}

	list(input: WithdrawalListInput): WithdrawalCaseSummary[] {
		if (
			!input ||
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 100 ||
			(input.status !== undefined && !isStatus(input.status))
		) {
			fail('WITHDRAWAL_LIST_INVALID');
		}
		const rows = (
			input.status === undefined
				? this.database
						.prepare('SELECT * FROM withdrawal_cases ORDER BY created_at DESC, id DESC LIMIT ?')
						.all(input.limit)
				: this.database
						.prepare(
							`SELECT * FROM withdrawal_cases WHERE status = ?
							 ORDER BY created_at DESC, id DESC LIMIT ?`
						)
						.all(input.status, input.limit)
		) as CaseRow[];
		return rows.map(mapCase).map(summary);
	}

	getInspectionHistory(caseId: string): WithdrawalInspectionHistory {
		if (!isCaseId(caseId)) fail('WITHDRAWAL_CASE_ID_INVALID');
		const eventRows = this.database
			.prepare(
				`SELECT actor, action, prior_status, next_status, result_code, created_at
				 FROM withdrawal_case_events WHERE case_id = ? ORDER BY id`
			)
			.all(caseId) as CaseEventRow[];
		const messageRows = this.database
			.prepare(
				`SELECT id, case_id, kind, resend_of_message_id, idempotency_key,
				 attempt_count, next_attempt_at, provider_delivery_id, completed_at, last_error_code
				 FROM withdrawal_messages WHERE case_id = ? ORDER BY id`
			)
			.all(caseId) as MessageRow[];
		return {
			events: eventRows.map(mapCaseEvent),
			messages: messageRows.map(mapMessage).map(messageDeliveryMetadata)
		};
	}

	purgeDue(now: Date, limit: number): number {
		const purgedAt = isoTimestamp(now, 'WITHDRAWAL_PURGE_INVALID');
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			fail('WITHDRAWAL_PURGE_INVALID');
		}
		const findDue = this.database.prepare(`
			SELECT * FROM withdrawal_cases
			WHERE status = 'closed' AND purged_at IS NULL AND pii_purge_due_at <= ?
			ORDER BY pii_purge_due_at, id
			LIMIT ?
		`);
		const findMessages = this.database.prepare(
			'SELECT * FROM withdrawal_messages WHERE case_id = ? ORDER BY id'
		);
		const settleMessages = this.database.prepare(`
			UPDATE withdrawal_messages
			SET provider_delivery_id = NULL, completed_at = ?, last_error_code = 'WITHDRAWAL_CASE_PURGED'
			WHERE case_id = ? AND completed_at IS NULL
		`);
		const purgeCase = this.database.prepare(`
			UPDATE withdrawal_cases
			SET schema_version = NULL, encryption_key_version = NULL, encrypted_payload = NULL,
				payload_nonce = NULL, payload_tag = NULL, dedupe_fingerprint = NULL,
				revision = revision + 1, purged_at = ?, updated_at = ?
			WHERE id = ? AND status = 'closed' AND purged_at IS NULL AND pii_purge_due_at <= ?
		`);
		const insertEvent = this.database.prepare(`
			INSERT INTO withdrawal_case_events (
				case_id, actor, action, prior_status, next_status, result_code, created_at
			) VALUES (?, 'system', 'pii_purged', 'closed', 'closed', 'PII_PURGED', ?)
		`);
		const purge = this.database.transaction(() => {
			const records = (findDue.all(purgedAt, limit) as CaseRow[]).map(mapCase);
			for (const record of records) {
				(findMessages.all(record.id) as MessageRow[]).map(mapMessage);
				settleMessages.run(purgedAt, record.id);
				if (purgeCase.run(purgedAt, purgedAt, record.id, purgedAt).changes !== 1) {
					fail('WITHDRAWAL_PURGE_CONFLICT');
				}
				insertEvent.run(record.id, purgedAt);
			}
			return records.length;
		});
		try {
			return purge.immediate();
		} catch (error) {
			if (error instanceof WithdrawalRepositoryError) throw error;
			fail('WITHDRAWAL_PURGE_FAILED');
		}
	}

	getMessage(id: number): WithdrawalMessage | null {
		validateMessageId(id);
		const row = this.database.prepare('SELECT * FROM withdrawal_messages WHERE id = ?').get(id) as
			MessageRow | undefined;
		return row ? mapMessage(row) : null;
	}

	claimDueMessages(now: Date, limit: number): WithdrawalMessage[] {
		const nowTimestamp = isoTimestamp(now, 'WITHDRAWAL_MESSAGE_INVALID');
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			fail('WITHDRAWAL_MESSAGE_INVALID');
		}
		const lease = new Date(now.getTime() + CLAIM_LEASE_MILLISECONDS);
		const leaseTimestamp = lease.toISOString();
		const findDue = this.database.prepare(`
			SELECT * FROM withdrawal_messages
			WHERE completed_at IS NULL AND next_attempt_at <= ?
			ORDER BY next_attempt_at, id
			LIMIT ?
		`);
		const reserve = this.database.prepare(`
			UPDATE withdrawal_messages
			SET attempt_count = attempt_count + 1, next_attempt_at = ?
			WHERE id = ? AND completed_at IS NULL AND next_attempt_at <= ? AND attempt_count = ?
		`);
		const claim = this.database.transaction(() => {
			const messages = (findDue.all(nowTimestamp, limit) as MessageRow[]).map(mapMessage);
			for (const message of messages) {
				if (
					reserve.run(leaseTimestamp, message.id, nowTimestamp, message.attemptCount).changes !== 1
				) {
					fail('WITHDRAWAL_MESSAGE_CLAIM_CONFLICT');
				}
			}
			return messages.map((message) => ({
				...message,
				attemptCount: message.attemptCount + 1,
				nextAttemptAt: new Date(lease)
			}));
		});
		try {
			return claim.immediate();
		} catch (error) {
			if (error instanceof WithdrawalRepositoryError) throw error;
			fail('WITHDRAWAL_MESSAGE_CLAIM_FAILED');
		}
	}

	claimMessage(id: number, now: Date): WithdrawalMessage | null {
		validateMessageId(id);
		const nowTimestamp = isoTimestamp(now, 'WITHDRAWAL_MESSAGE_INVALID');
		const lease = new Date(now.getTime() + CLAIM_LEASE_MILLISECONDS);
		const find = this.database.prepare('SELECT * FROM withdrawal_messages WHERE id = ?');
		const reserve = this.database.prepare(`
			UPDATE withdrawal_messages
			SET attempt_count = attempt_count + 1, next_attempt_at = ?
			WHERE id = ? AND completed_at IS NULL AND next_attempt_at <= ? AND attempt_count = ?
		`);
		const claim = this.database.transaction(() => {
			const row = find.get(id) as MessageRow | undefined;
			if (!row) return null;
			const message = mapMessage(row);
			if (message.completedAt !== null || message.nextAttemptAt > now) return null;
			if (reserve.run(lease.toISOString(), id, nowTimestamp, message.attemptCount).changes !== 1) {
				fail('WITHDRAWAL_MESSAGE_CLAIM_CONFLICT');
			}
			return {
				...message,
				attemptCount: message.attemptCount + 1,
				nextAttemptAt: lease
			};
		});
		try {
			return claim.immediate();
		} catch (error) {
			if (error instanceof WithdrawalRepositoryError) throw error;
			fail('WITHDRAWAL_MESSAGE_CLAIM_FAILED');
		}
	}

	completeMessage(
		id: number,
		expectedAttemptCount: number,
		providerDeliveryId: string,
		now: Date
	): void {
		validateMessageId(id);
		validateExpectedAttempt(expectedAttemptCount);
		if (!isWithdrawalProviderDeliveryId(providerDeliveryId)) fail('WITHDRAWAL_MESSAGE_INVALID');
		const completedAt = isoTimestamp(now, 'WITHDRAWAL_MESSAGE_INVALID');
		const update = this.database.prepare(`
			UPDATE withdrawal_messages
			SET provider_delivery_id = ?, completed_at = ?, last_error_code = NULL
			WHERE id = ? AND completed_at IS NULL AND attempt_count = ?
		`);
		if (update.run(providerDeliveryId, completedAt, id, expectedAttemptCount).changes !== 1) {
			this.settlementFailure(id);
		}
	}

	rescheduleMessage(
		id: number,
		expectedAttemptCount: number,
		nextAttemptAt: Date,
		errorCode: string
	): void {
		validateMessageId(id);
		validateExpectedAttempt(expectedAttemptCount);
		if (!isStableErrorCode(errorCode)) fail('WITHDRAWAL_MESSAGE_INVALID');
		const next = isoTimestamp(nextAttemptAt, 'WITHDRAWAL_MESSAGE_INVALID');
		const update = this.database.prepare(`
			UPDATE withdrawal_messages
			SET next_attempt_at = ?, last_error_code = ?
			WHERE id = ? AND completed_at IS NULL AND attempt_count = ?
		`);
		if (update.run(next, errorCode, id, expectedAttemptCount).changes !== 1) {
			this.settlementFailure(id);
		}
	}

	failMessagePermanently(
		id: number,
		expectedAttemptCount: number,
		errorCode: string,
		now: Date
	): void {
		validateMessageId(id);
		validateExpectedAttempt(expectedAttemptCount);
		if (!isStableErrorCode(errorCode)) fail('WITHDRAWAL_MESSAGE_INVALID');
		const completedAt = isoTimestamp(now, 'WITHDRAWAL_MESSAGE_INVALID');
		const update = this.database.prepare(`
			UPDATE withdrawal_messages
			SET provider_delivery_id = NULL, completed_at = ?, last_error_code = ?
			WHERE id = ? AND completed_at IS NULL AND attempt_count = ?
		`);
		if (update.run(completedAt, errorCode, id, expectedAttemptCount).changes !== 1) {
			this.settlementFailure(id);
		}
	}

	private settlementFailure(id: number): never {
		const row = this.database.prepare('SELECT * FROM withdrawal_messages WHERE id = ?').get(id) as
			MessageRow | undefined;
		if (!row) fail('WITHDRAWAL_MESSAGE_NOT_FOUND');
		mapMessage(row);
		fail('WITHDRAWAL_MESSAGE_SETTLEMENT_CONFLICT');
	}
}
