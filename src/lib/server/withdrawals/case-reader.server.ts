import type { Buffer } from 'node:buffer';
import type { WithdrawalPayloadV1 } from '$lib/domain/withdrawals';
import type { AlertService } from '$lib/server/monitoring/alerts.server';
import { decryptWithdrawalPayload } from './crypto.server';
import type { WithdrawalInspection } from './receipt.server';
import type {
	EncryptedWithdrawalCaseRecord,
	SqliteWithdrawalRepository
} from './repository.server';

export type WithdrawalCaseReaderDependencies = {
	repository: Pick<SqliteWithdrawalRepository, 'loadEncryptedByReference' | 'loadEncryptedById'>;
	dataKey: Buffer;
	alerts: AlertService;
};

function stableErrorCode(error: unknown): string | undefined {
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof error.code === 'string' &&
		/^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
	) {
		return error.code;
	}
	if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.message)) {
		return error.message;
	}
	return undefined;
}

function notFound(): never {
	throw new Error('WITHDRAWAL_CASE_NOT_FOUND');
}

export class WithdrawalCaseReader {
	constructor(private readonly dependencies: WithdrawalCaseReaderDependencies) {}

	inspectActive(reference: string, now = new Date()): WithdrawalInspection {
		const record = this.dependencies.repository.loadEncryptedByReference(reference);
		if (!record) notFound();
		return this.inspectLoaded(record, now);
	}

	inspectActiveById(caseId: string, now = new Date()): WithdrawalInspection {
		const record = this.dependencies.repository.loadEncryptedById(caseId);
		if (!record) notFound();
		return this.inspectLoaded(record, now);
	}

	decryptLoaded(record: EncryptedWithdrawalCaseRecord): WithdrawalPayloadV1 {
		return decryptWithdrawalPayload(record.encryptedPayload, record.id, this.dependencies.dataKey);
	}

	withDecryptAlert<T>(reference: string, now: Date, operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			if (stableErrorCode(error) === 'WITHDRAWAL_DECRYPT_FAILED') {
				try {
					this.dependencies.alerts.enqueueAlert('WITHDRAWAL_DATA_UNREADABLE', reference, now);
				} catch {
					// The stable decryption result must survive an independent alert-persistence failure.
				}
			}
			throw error;
		}
	}

	private inspectLoaded(record: EncryptedWithdrawalCaseRecord, now: Date): WithdrawalInspection {
		return this.withDecryptAlert(record.reference, now, () => ({
			...record,
			payload: this.decryptLoaded(record)
		}));
	}
}
