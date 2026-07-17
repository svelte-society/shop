import type { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
	generateWithdrawalReference,
	normalizeWithdrawalInput,
	type CanonicalWithdrawalInput,
	type WithdrawalPayloadV1,
	type WithdrawalScope
} from '$lib/domain/withdrawals';
import { encryptWithdrawalPayload, withdrawalDedupeFingerprint } from './crypto.server';
import type {
	SqliteWithdrawalRepository,
	WithdrawalCaseRecord,
	WithdrawalMessage
} from './repository.server';

export type WithdrawalReceiptDeliveryState = 'delivered' | 'queued' | 'failed';

export interface WithdrawalReceiptDispatcher {
	attemptReceipt(
		messageId: number,
		now: Date,
		signal?: AbortSignal
	): Promise<WithdrawalReceiptDeliveryState>;
}

export type WithdrawalSubmissionResult = {
	reference: string;
	createdAt: Date;
	scope: WithdrawalScope;
	enteredOrderReference: string;
	deliveryState: WithdrawalReceiptDeliveryState;
};

export type WithdrawalSubmissionServiceDependencies = {
	repository: Pick<SqliteWithdrawalRepository, 'createSubmission' | 'getMessage'>;
	dispatcher: WithdrawalReceiptDispatcher;
	dataKey: Buffer;
};

function result(
	record: WithdrawalCaseRecord,
	enteredOrderReference: string,
	deliveryState: WithdrawalReceiptDeliveryState
): WithdrawalSubmissionResult {
	return {
		reference: record.reference,
		createdAt: record.createdAt,
		scope: record.scope,
		enteredOrderReference,
		deliveryState
	};
}

function persistedReceiptState(message: WithdrawalMessage): WithdrawalReceiptDeliveryState {
	if (message.completedAt === null) {
		if (message.providerDeliveryId !== null) throw new Error('WITHDRAWAL_MESSAGE_ROW_INVALID');
		return 'queued';
	}
	if (message.providerDeliveryId !== null && message.lastErrorCode === null) return 'delivered';
	if (message.providerDeliveryId === null && message.lastErrorCode !== null) return 'failed';
	throw new Error('WITHDRAWAL_MESSAGE_ROW_INVALID');
}

export class WithdrawalSubmissionService {
	constructor(private readonly dependencies: WithdrawalSubmissionServiceDependencies) {}

	async submit(
		input: CanonicalWithdrawalInput,
		now = new Date(),
		signal?: AbortSignal
	): Promise<WithdrawalSubmissionResult> {
		const canonical = normalizeWithdrawalInput(input);
		const id = randomUUID();
		const reference = generateWithdrawalReference();
		const payload: WithdrawalPayloadV1 = {
			fullName: canonical.fullName,
			receiptEmail: canonical.receiptEmail,
			enteredOrderReference: canonical.enteredOrderReference,
			items: canonical.items,
			reconciliation: null
		};
		const encryptedPayload = encryptWithdrawalPayload(payload, id, this.dependencies.dataKey);
		const dedupeFingerprint = withdrawalDedupeFingerprint(canonical, this.dependencies.dataKey);
		const created = this.dependencies.repository.createSubmission({
			id,
			reference,
			scope: canonical.scope,
			encryptedPayload,
			dedupeFingerprint,
			createdAt: now
		});
		if (!created.created) {
			const message = this.dependencies.repository.getMessage(created.receiptMessageId);
			if (!message) throw new Error('WITHDRAWAL_MESSAGE_ROW_INVALID');
			return result(created.case, canonical.enteredOrderReference, persistedReceiptState(message));
		}

		let deliveryState: WithdrawalReceiptDeliveryState;
		try {
			deliveryState = await this.dependencies.dispatcher.attemptReceipt(
				created.receiptMessageId,
				now,
				signal
			);
		} catch {
			deliveryState = 'queued';
		}
		return result(created.case, canonical.enteredOrderReference, deliveryState);
	}
}
