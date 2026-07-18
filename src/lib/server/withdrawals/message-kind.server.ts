import type {
	SqliteWithdrawalRepository,
	WithdrawalMessage,
	WithdrawalMessageKind
} from './repository.server';

export const MAX_WITHDRAWAL_RESEND_TRAVERSAL_DEPTH = 32;

export function resolveOriginalWithdrawalMessageKind(
	source: WithdrawalMessage,
	repository: Pick<SqliteWithdrawalRepository, 'getMessage'>
): Exclude<WithdrawalMessageKind, 'resend'> | null {
	let current = source;
	const seen = new Set([source.id]);
	let depth = 0;

	while (current.kind === 'resend') {
		if (depth >= MAX_WITHDRAWAL_RESEND_TRAVERSAL_DEPTH || current.resendOfMessageId === null) {
			return null;
		}

		let ancestor: WithdrawalMessage | null;
		try {
			ancestor = repository.getMessage(current.resendOfMessageId);
		} catch {
			return null;
		}
		if (
			!ancestor ||
			ancestor.caseId !== source.caseId ||
			ancestor.completedAt === null ||
			seen.has(ancestor.id)
		) {
			return null;
		}

		seen.add(ancestor.id);
		current = ancestor;
		depth += 1;
	}

	return current.kind;
}
