import { Buffer } from 'node:buffer';
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { WithdrawalSellerIdentity } from '$lib/config/private.server';
import type { WithdrawalStatus } from '$lib/domain/withdrawals';
import type { ShopDatabase } from '$lib/server/db/types';
import type { WithdrawalCaseReader } from './case-reader.server';
import { encryptWithdrawalPayload } from './crypto.server';
import { withdrawalMessage } from './messages.server';
import type {
	SqliteWithdrawalRepository,
	WithdrawalMessage,
	WithdrawalMessageKind
} from './repository.server';

const ISO_3166_ALPHA_2 = new Set(
	(
		'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ ' +
		'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
		'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
		'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
		'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY ' +
		'HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
		'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY ' +
		'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
		'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY ' +
		'QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ ' +
		'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ ' +
		'VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
	).split(' ')
);
const EU_27 = new Set(
	'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ')
);
const MCP_PREVIEW_CONTEXT = 'svelte-society-withdrawal-mcp-preview-v1';
const PREVIEW_LIFETIME_MILLISECONDS = 10 * 60_000;
const PREVIEW_TOKEN_PATTERN =
	/^v1\.(0|[1-9]\d{0,10})\.([1-9]\d*)\.([0-9a-f]{64})\.([A-Za-z0-9_-]{43})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WithdrawalMutationResult = {
	reference: string;
	status: WithdrawalStatus;
	revision: number;
};

export type BeginWithdrawalReviewInput = {
	reference: string;
	expectedStatus: 'submitted';
	expectedRevision: number;
	now: Date;
};

export type RecordWithdrawalEligibilityInput = {
	reference: string;
	expectedStatus: 'reviewing';
	expectedRevision: number;
	decision: 'eligible_eu' | 'ineligible_non_eu' | 'support_handling';
	internalOrderReference: string;
	countryCode: string;
	customerInstructions?: string;
	now: Date;
};

export type RecordWithdrawalReturnInput = {
	reference: string;
	expectedStatus: 'awaiting_return';
	expectedRevision: number;
	outcome: 'parcel_received' | 'return_waived' | 'return_not_received';
	parcelReference?: string;
	now: Date;
};

export type CloseWithdrawalCaseInput = {
	reference: string;
	expectedStatus: 'awaiting_return' | 'ineligible' | 'support_handling';
	expectedRevision: number;
	outcomeCode:
		| 'eligible_return_received'
		| 'eligible_return_waived'
		| 'eligible_return_not_received'
		| 'ineligible_non_eu'
		| 'support_handling_completed';
	now: Date;
};

export type PreviewWithdrawalResendInput = {
	reference: string;
	sourceMessageId: number;
	now: Date;
};

export type WithdrawalResendPreview = {
	reference: string;
	sourceMessageId: number;
	destination: string;
	subject: string;
	textBody: string;
	previewToken: string;
	expiresAt: Date;
};

export type ConfirmWithdrawalResendInput = {
	reference: string;
	sourceMessageId: number;
	previewToken: string;
	idempotencyKey: string;
	now: Date;
};

export type WithdrawalResendConfirmation = {
	reference: string;
	sourceMessageId: number;
	messageId: number;
	queued: true;
};

export class WithdrawalWorkflowError extends Error {
	constructor(
		readonly code: string,
		readonly currentStatus?: WithdrawalStatus,
		readonly currentRevision?: number
	) {
		super(code);
		this.name = 'WithdrawalWorkflowError';
	}
}

export type WithdrawalWorkflowDependencies = {
	database: ShopDatabase;
	repository: Pick<
		SqliteWithdrawalRepository,
		'loadEncryptedByReference' | 'getByReference' | 'getMessage'
	>;
	reader: Pick<WithdrawalCaseReader, 'withDecryptAlert' | 'decryptLoaded'>;
	dataKey: Buffer;
	productionOrigin?: URL;
	supportEmail?: string;
	seller?: WithdrawalSellerIdentity;
};

function conflict(status: WithdrawalStatus, revision: number): never {
	throw new WithdrawalWorkflowError('WITHDRAWAL_CASE_CONFLICT', status, revision);
}

function validateEligibility(input: RecordWithdrawalEligibilityInput): string {
	const countryCode = input.countryCode.trim().toUpperCase();
	if (!/^[A-Z]{2}$/u.test(countryCode) || !ISO_3166_ALPHA_2.has(countryCode)) {
		throw new WithdrawalWorkflowError('WITHDRAWAL_COUNTRY_INVALID');
	}
	if (
		(input.decision === 'eligible_eu' && !EU_27.has(countryCode)) ||
		(input.decision === 'ineligible_non_eu' && EU_27.has(countryCode))
	) {
		throw new WithdrawalWorkflowError('WITHDRAWAL_COUNTRY_INVALID');
	}
	const validInstructions =
		typeof input.customerInstructions === 'string' &&
		input.customerInstructions.length >= 1 &&
		input.customerInstructions.length <= 1_000 &&
		input.customerInstructions === input.customerInstructions.trim() &&
		!/\p{Cc}/u.test(input.customerInstructions);
	if (
		(input.decision === 'eligible_eu' && !validInstructions) ||
		(input.decision !== 'eligible_eu' && input.customerInstructions !== undefined)
	) {
		throw new WithdrawalWorkflowError('WITHDRAWAL_ELIGIBILITY_INVALID');
	}
	return countryCode;
}

function validOptionalText(value: string | undefined, maximum: number): boolean {
	return (
		value === undefined ||
		(value.length >= 1 &&
			value.length <= maximum &&
			value === value.trim() &&
			!/\p{Cc}/u.test(value))
	);
}

function previewKey(dataKey: Buffer): Buffer {
	return Buffer.from(hkdfSync('sha256', dataKey, Buffer.alloc(0), MCP_PREVIEW_CONTEXT, 32));
}

function messageDigest(message: {
	to: string;
	subject: string;
	text: string;
	html: string;
}): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				to: message.to,
				subject: message.subject,
				text: message.text,
				html: message.html
			}),
			'utf8'
		)
		.digest('hex');
}

function previewMac(
	reference: string,
	sourceMessageId: number,
	revision: number,
	digest: string,
	expiry: string,
	dataKey: Buffer
): string {
	return createHmac('sha256', previewKey(dataKey))
		.update(`${reference}\n${sourceMessageId}\n${revision}\n${digest}\n${expiry}`, 'utf8')
		.digest('base64url');
}

function parsePreviewToken(
	input: ConfirmWithdrawalResendInput,
	dataKey: Buffer
): { expiry: string; revision: number; digest: string } {
	if (
		!Number.isSafeInteger(input.sourceMessageId) ||
		input.sourceMessageId < 1 ||
		!UUID_PATTERN.test(input.idempotencyKey) ||
		!(input.now instanceof Date) ||
		!Number.isFinite(input.now.getTime())
	) {
		throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_PREVIEW_INVALID');
	}
	const match = PREVIEW_TOKEN_PATTERN.exec(input.previewToken);
	if (!match) throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_PREVIEW_INVALID');
	const expiry = Number(match[1]);
	const revision = Number(match[2]);
	const nowSeconds = Math.floor(input.now.getTime() / 1_000);
	if (
		!Number.isSafeInteger(expiry) ||
		expiry < nowSeconds ||
		!Number.isSafeInteger(revision) ||
		revision < 1
	) {
		throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_PREVIEW_INVALID');
	}
	const suppliedMac = Buffer.from(match[4], 'base64url');
	const expectedMac = Buffer.from(
		previewMac(input.reference, input.sourceMessageId, revision, match[3], match[1], dataKey),
		'base64url'
	);
	if (suppliedMac.length !== 32 || !timingSafeEqual(suppliedMac, expectedMac)) {
		throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_PREVIEW_INVALID');
	}
	return { expiry: match[1], revision, digest: match[3] };
}

function messageConfiguration(dependencies: WithdrawalWorkflowDependencies): {
	productionOrigin: URL;
	supportEmail: string;
	seller: WithdrawalSellerIdentity;
} {
	if (!dependencies.productionOrigin || !dependencies.supportEmail || !dependencies.seller) {
		throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_ACTION_FAILED');
	}
	return {
		productionOrigin: dependencies.productionOrigin,
		supportEmail: dependencies.supportEmail,
		seller: dependencies.seller
	};
}

function originalMessageKind(
	source: WithdrawalMessage,
	repository: Pick<SqliteWithdrawalRepository, 'getMessage'>
): Exclude<WithdrawalMessageKind, 'resend'> {
	let current = source;
	const seen = new Set<number>();
	while (current.kind === 'resend') {
		if (current.resendOfMessageId === null || seen.has(current.id)) {
			throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_PREVIEW_INVALID');
		}
		seen.add(current.id);
		const original = repository.getMessage(current.resendOfMessageId);
		if (!original || original.caseId !== source.caseId) {
			throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_PREVIEW_INVALID');
		}
		current = original;
	}
	return current.kind;
}

export class WithdrawalWorkflowService {
	constructor(private readonly dependencies: WithdrawalWorkflowDependencies) {}

	beginReview(input: BeginWithdrawalReviewInput): WithdrawalMutationResult {
		return this.dependencies.reader.withDecryptAlert(input.reference, input.now, () => {
			const mutate = this.dependencies.database.transaction(() => {
				const record = this.dependencies.repository.loadEncryptedByReference(input.reference);
				if (!record) throw new WithdrawalWorkflowError('WITHDRAWAL_CASE_NOT_FOUND');
				if (record.status !== input.expectedStatus || record.revision !== input.expectedRevision) {
					conflict(record.status, record.revision);
				}

				this.dependencies.reader.decryptLoaded(record);
				const updated = this.dependencies.database
					.prepare(
						`UPDATE withdrawal_cases
						 SET status = 'reviewing', revision = revision + 1, updated_at = ?
						 WHERE id = ? AND revision = ?`
					)
					.run(input.now.toISOString(), record.id, record.revision);
				if (updated.changes !== 1) {
					const current = this.dependencies.repository.getByReference(input.reference);
					if (current) conflict(current.status, current.revision);
					throw new WithdrawalWorkflowError('WITHDRAWAL_CASE_NOT_FOUND');
				}

				this.dependencies.database
					.prepare(
						`INSERT INTO withdrawal_case_events (
						 case_id, actor, action, prior_status, next_status, result_code, created_at
						) VALUES (?, 'codex-admin', 'review_started', 'submitted', 'reviewing',
						 'ADMIN_REVIEW_STARTED', ?)`
					)
					.run(record.id, input.now.toISOString());

				return {
					reference: record.reference,
					status: 'reviewing' as const,
					revision: record.revision + 1
				};
			});
			return mutate.immediate();
		});
	}

	recordEligibility(input: RecordWithdrawalEligibilityInput): WithdrawalMutationResult {
		return this.dependencies.reader.withDecryptAlert(input.reference, input.now, () => {
			const mutate = this.dependencies.database.transaction(() => {
				const record = this.dependencies.repository.loadEncryptedByReference(input.reference);
				if (!record) throw new WithdrawalWorkflowError('WITHDRAWAL_CASE_NOT_FOUND');
				if (record.status !== input.expectedStatus || record.revision !== input.expectedRevision) {
					conflict(record.status, record.revision);
				}
				const payload = this.dependencies.reader.decryptLoaded(record);
				const countryCode = validateEligibility(input);
				const decision =
					input.decision === 'eligible_eu'
						? {
								status: 'awaiting_return' as const,
								messageKind: 'eligible_instructions' as const,
								resultCode: 'ELIGIBLE_EU_RECORDED'
							}
						: input.decision === 'ineligible_non_eu'
							? {
									status: 'ineligible' as const,
									messageKind: 'ineligible_decision' as const,
									resultCode: 'INELIGIBLE_NON_EU_RECORDED'
								}
							: {
									status: 'support_handling' as const,
									messageKind: 'support_handoff' as const,
									resultCode: 'SUPPORT_HANDLING_RECORDED'
								};
				const encrypted = encryptWithdrawalPayload(
					{
						...payload,
						reconciliation: {
							internalOrderReference: input.internalOrderReference,
							countryCode,
							customerInstructions:
								input.decision === 'eligible_eu' ? (input.customerInstructions as string) : null,
							returnOutcome: null,
							parcelReference: null
						}
					},
					record.id,
					this.dependencies.dataKey
				);
				const timestamp = input.now.toISOString();
				const updated = this.dependencies.database
					.prepare(
						`UPDATE withdrawal_cases SET
						 status = ?, revision = revision + 1,
						 eligibility = ?, encrypted_payload = ?, payload_nonce = ?,
						 payload_tag = ?, updated_at = ?, reconciled_at = ?
						 WHERE id = ? AND revision = ?`
					)
					.run(
						decision.status,
						input.decision,
						encrypted.ciphertext,
						encrypted.nonce,
						encrypted.tag,
						timestamp,
						timestamp,
						record.id,
						record.revision
					);
				if (updated.changes !== 1) {
					const current = this.dependencies.repository.getByReference(input.reference);
					if (current) conflict(current.status, current.revision);
					throw new WithdrawalWorkflowError('WITHDRAWAL_CASE_NOT_FOUND');
				}
				this.dependencies.database
					.prepare(
						`INSERT INTO withdrawal_case_events (
						 case_id, actor, action, prior_status, next_status, result_code, created_at
						) VALUES (?, 'codex-admin', 'eligibility_recorded', 'reviewing', ?, ?, ?)`
					)
					.run(record.id, decision.status, decision.resultCode, timestamp);
				this.dependencies.database
					.prepare(
						`INSERT INTO withdrawal_messages (
						 case_id, kind, resend_of_message_id, idempotency_key, attempt_count,
						 next_attempt_at, provider_delivery_id, completed_at, last_error_code
						) VALUES (?, ?, NULL, ?, 0, ?, NULL, NULL, NULL)`
					)
					.run(
						record.id,
						decision.messageKind,
						`withdrawal:${decision.messageKind}:${record.id}:${record.revision + 1}`,
						timestamp
					);
				return {
					reference: record.reference,
					status: decision.status,
					revision: record.revision + 1
				};
			});
			return mutate.immediate();
		});
	}

	recordReturn(input: RecordWithdrawalReturnInput): WithdrawalMutationResult {
		return this.dependencies.reader.withDecryptAlert(input.reference, input.now, () => {
			const mutate = this.dependencies.database.transaction(() => {
				const record = this.dependencies.repository.loadEncryptedByReference(input.reference);
				if (!record) throw new WithdrawalWorkflowError('WITHDRAWAL_CASE_NOT_FOUND');
				if (record.status !== input.expectedStatus || record.revision !== input.expectedRevision) {
					conflict(record.status, record.revision);
				}
				const payload = this.dependencies.reader.decryptLoaded(record);
				if (!payload.reconciliation) {
					throw new WithdrawalWorkflowError('WITHDRAWAL_RETURN_INVALID');
				}
				if (!validOptionalText(input.parcelReference, 120)) {
					throw new WithdrawalWorkflowError('WITHDRAWAL_RETURN_INVALID');
				}
				const encrypted = encryptWithdrawalPayload(
					{
						...payload,
						reconciliation: {
							...payload.reconciliation,
							returnOutcome: input.outcome,
							parcelReference: input.parcelReference ?? null
						}
					},
					record.id,
					this.dependencies.dataKey
				);
				const resultCode =
					input.outcome === 'parcel_received'
						? 'PARCEL_RECEIVED_RECORDED'
						: input.outcome === 'return_waived'
							? 'RETURN_WAIVED_RECORDED'
							: 'RETURN_NOT_RECEIVED_RECORDED';
				const timestamp = input.now.toISOString();
				const updated = this.dependencies.database
					.prepare(
						`UPDATE withdrawal_cases SET revision = revision + 1,
						 encrypted_payload = ?, payload_nonce = ?, payload_tag = ?, updated_at = ?
						 WHERE id = ? AND revision = ?`
					)
					.run(
						encrypted.ciphertext,
						encrypted.nonce,
						encrypted.tag,
						timestamp,
						record.id,
						record.revision
					);
				if (updated.changes !== 1) {
					const current = this.dependencies.repository.getByReference(input.reference);
					if (current) conflict(current.status, current.revision);
					throw new WithdrawalWorkflowError('WITHDRAWAL_CASE_NOT_FOUND');
				}
				this.dependencies.database
					.prepare(
						`INSERT INTO withdrawal_case_events (
						 case_id, actor, action, prior_status, next_status, result_code, created_at
						) VALUES (?, 'codex-admin', 'return_recorded', 'awaiting_return',
						 'awaiting_return', ?, ?)`
					)
					.run(record.id, resultCode, timestamp);
				return {
					reference: record.reference,
					status: 'awaiting_return' as const,
					revision: record.revision + 1
				};
			});
			return mutate.immediate();
		});
	}

	closeCase(input: CloseWithdrawalCaseInput): WithdrawalMutationResult {
		return this.dependencies.reader.withDecryptAlert(input.reference, input.now, () => {
			const mutate = this.dependencies.database.transaction(() => {
				const record = this.dependencies.repository.loadEncryptedByReference(input.reference);
				if (!record) throw new WithdrawalWorkflowError('WITHDRAWAL_CASE_NOT_FOUND');
				if (record.status !== input.expectedStatus || record.revision !== input.expectedRevision) {
					conflict(record.status, record.revision);
				}
				const payload = this.dependencies.reader.decryptLoaded(record);
				const expectedReturn =
					input.outcomeCode === 'eligible_return_received'
						? 'parcel_received'
						: input.outcomeCode === 'eligible_return_waived'
							? 'return_waived'
							: input.outcomeCode === 'eligible_return_not_received'
								? 'return_not_received'
								: null;
				const validCombination =
					(record.status === 'awaiting_return' &&
						record.eligibility === 'eligible_eu' &&
						expectedReturn !== null &&
						payload.reconciliation?.returnOutcome === expectedReturn) ||
					(record.status === 'ineligible' &&
						record.eligibility === 'ineligible_non_eu' &&
						input.outcomeCode === 'ineligible_non_eu') ||
					(record.status === 'support_handling' &&
						record.eligibility === 'support_handling' &&
						input.outcomeCode === 'support_handling_completed');
				if (!validCombination) {
					throw new WithdrawalWorkflowError('WITHDRAWAL_CLOSE_INVALID');
				}
				const timestamp = input.now.toISOString();
				const purgeDueAt = new Date(input.now.getTime() + 90 * 24 * 60 * 60_000).toISOString();
				const outcomeCode = input.outcomeCode.toUpperCase();
				const updated = this.dependencies.database
					.prepare(
						`UPDATE withdrawal_cases SET status = 'closed', revision = revision + 1,
						 outcome_code = ?, updated_at = ?, closed_at = ?, pii_purge_due_at = ?
						 WHERE id = ? AND revision = ?`
					)
					.run(outcomeCode, timestamp, timestamp, purgeDueAt, record.id, record.revision);
				if (updated.changes !== 1) {
					const current = this.dependencies.repository.getByReference(input.reference);
					if (current) conflict(current.status, current.revision);
					throw new WithdrawalWorkflowError('WITHDRAWAL_CASE_NOT_FOUND');
				}
				this.dependencies.database
					.prepare(
						`INSERT INTO withdrawal_case_events (
						 case_id, actor, action, prior_status, next_status, result_code, created_at
						) VALUES (?, 'codex-admin', 'case_closed', ?, 'closed', ?, ?)`
					)
					.run(record.id, record.status, outcomeCode, timestamp);
				return {
					reference: record.reference,
					status: 'closed' as const,
					revision: record.revision + 1
				};
			});
			return mutate.immediate();
		});
	}

	previewResend(input: PreviewWithdrawalResendInput): WithdrawalResendPreview {
		return this.dependencies.reader.withDecryptAlert(input.reference, input.now, () => {
			const configuration = messageConfiguration(this.dependencies);
			const record = this.dependencies.repository.loadEncryptedByReference(input.reference);
			if (!record) throw new WithdrawalWorkflowError('WITHDRAWAL_CASE_NOT_FOUND');
			const payload = this.dependencies.reader.decryptLoaded(record);
			const source = this.dependencies.repository.getMessage(input.sourceMessageId);
			if (!source || source.caseId !== record.id || source.completedAt === null) {
				throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_PREVIEW_INVALID');
			}
			const kind = originalMessageKind(source, this.dependencies.repository);
			const message = withdrawalMessage({
				kind,
				inspection: { ...record, payload },
				productionOrigin: configuration.productionOrigin,
				supportEmail: configuration.supportEmail,
				seller: configuration.seller
			});
			const digest = messageDigest(message);
			const expiresAt = new Date(input.now.getTime() + PREVIEW_LIFETIME_MILLISECONDS);
			const expiry = String(Math.floor(expiresAt.getTime() / 1_000));
			const mac = previewMac(
				record.reference,
				source.id,
				record.revision,
				digest,
				expiry,
				this.dependencies.dataKey
			);
			return {
				reference: record.reference,
				sourceMessageId: source.id,
				destination: message.to,
				subject: message.subject,
				textBody: message.text,
				previewToken: `v1.${expiry}.${record.revision}.${digest}.${mac}`,
				expiresAt
			};
		});
	}

	confirmResend(input: ConfirmWithdrawalResendInput): WithdrawalResendConfirmation {
		const token = parsePreviewToken(input, this.dependencies.dataKey);
		return this.dependencies.reader.withDecryptAlert(input.reference, input.now, () => {
			const configuration = messageConfiguration(this.dependencies);
			const enqueue = this.dependencies.database.transaction(() => {
				const record = this.dependencies.repository.loadEncryptedByReference(input.reference);
				if (!record || record.revision !== token.revision) {
					throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_PREVIEW_INVALID');
				}
				const payload = this.dependencies.reader.decryptLoaded(record);
				const source = this.dependencies.repository.getMessage(input.sourceMessageId);
				if (!source || source.caseId !== record.id || source.completedAt === null) {
					throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_PREVIEW_INVALID');
				}
				const kind = originalMessageKind(source, this.dependencies.repository);
				const message = withdrawalMessage({
					kind,
					inspection: { ...record, payload },
					productionOrigin: configuration.productionOrigin,
					supportEmail: configuration.supportEmail,
					seller: configuration.seller
				});
				if (messageDigest(message) !== token.digest) {
					throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_PREVIEW_INVALID');
				}
				const existing = this.dependencies.database
					.prepare(
						`SELECT id, case_id, kind, resend_of_message_id FROM withdrawal_messages
						 WHERE idempotency_key = ?`
					)
					.get(input.idempotencyKey) as
					| {
							id: number;
							case_id: string;
							kind: string;
							resend_of_message_id: number | null;
					  }
					| undefined;
				if (existing) {
					if (
						existing.case_id !== record.id ||
						existing.kind !== 'resend' ||
						existing.resend_of_message_id !== source.id
					) {
						throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_PREVIEW_INVALID');
					}
					return {
						reference: record.reference,
						sourceMessageId: source.id,
						messageId: existing.id,
						queued: true as const
					};
				}
				const inserted = this.dependencies.database
					.prepare(
						`INSERT INTO withdrawal_messages (
						 case_id, kind, resend_of_message_id, idempotency_key, attempt_count,
						 next_attempt_at, provider_delivery_id, completed_at, last_error_code
						) VALUES (?, 'resend', ?, ?, 0, ?, NULL, NULL, NULL)`
					)
					.run(record.id, source.id, input.idempotencyKey, input.now.toISOString());
				const messageId = Number(inserted.lastInsertRowid);
				if (!Number.isSafeInteger(messageId) || messageId < 1) {
					throw new WithdrawalWorkflowError('WITHDRAWAL_MESSAGE_ACTION_FAILED');
				}
				return {
					reference: record.reference,
					sourceMessageId: source.id,
					messageId,
					queued: true as const
				};
			});
			return enqueue.immediate();
		});
	}
}
