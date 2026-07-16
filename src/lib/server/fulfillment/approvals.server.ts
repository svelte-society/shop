import type { ShopDatabase } from '$lib/server/db/types';

const ACTOR = 'codex-admin';
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PAYLOAD_HASH_PATTERN = /^[a-f0-9]{64}$/;

export type NewSubmissionApproval = {
	approvalId: string;
	orderId: string;
	payloadHash: string;
	expiresAt: Date;
};

export interface ApprovalRepository {
	create(input: NewSubmissionApproval): void;
}

export class ApprovalRepositoryError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'ApprovalRepositoryError';
	}
}

function fail(code: string): never {
	throw new ApprovalRepositoryError(code);
}

function isExactString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maxLength &&
		value === value.trim() &&
		!/[\r\n]/.test(value)
	);
}

function approvalTimestamp(value: unknown): string {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
		fail('SUBMISSION_APPROVAL_INVALID');
	}
	return value.toISOString();
}

export class SqliteApprovalRepository implements ApprovalRepository {
	constructor(private readonly database: ShopDatabase) {}

	create(input: NewSubmissionApproval): void {
		if (
			!input ||
			!isExactString(input.approvalId, 43) ||
			!APPROVAL_ID_PATTERN.test(input.approvalId) ||
			!isExactString(input.orderId, 200) ||
			!isExactString(input.payloadHash, 64) ||
			!PAYLOAD_HASH_PATTERN.test(input.payloadHash)
		) {
			fail('SUBMISSION_APPROVAL_INVALID');
		}
		const expiresAt = approvalTimestamp(input.expiresAt);
		try {
			this.database
				.prepare(
					`INSERT INTO submission_approvals (
						id, order_id, payload_hash, actor, expires_at, used_at
					) VALUES (?, ?, ?, '${ACTOR}', ?, NULL)`
				)
				.run(input.approvalId, input.orderId, input.payloadHash, expiresAt);
		} catch {
			fail('SUBMISSION_APPROVAL_CREATE_FAILED');
		}
	}
}
