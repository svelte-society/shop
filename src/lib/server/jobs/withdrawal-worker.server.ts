import type { WithdrawalSellerIdentity } from '$lib/config/private.server';
import type { AlertService } from '$lib/server/monitoring/alerts.server';
import type { PlunkGateway } from '$lib/server/plunk/gateway';
import { PlunkError } from '$lib/server/plunk/gateway';
import type { WithdrawalCaseReader } from '$lib/server/withdrawals/case-reader.server';
import { resolveOriginalWithdrawalMessageKind } from '$lib/server/withdrawals/message-kind.server';
import { withdrawalMessage } from '$lib/server/withdrawals/messages.server';
import type {
	SqliteWithdrawalRepository,
	WithdrawalMessage
} from '$lib/server/withdrawals/repository.server';
import { isWithdrawalProviderDeliveryId } from '$lib/server/withdrawals/repository.server';
import type {
	WithdrawalReceiptDeliveryState,
	WithdrawalReceiptDispatcher
} from '$lib/server/withdrawals/submission.server';

export type WithdrawalMessageWorkerDependencies = {
	repository: Pick<
		SqliteWithdrawalRepository,
		| 'claimMessage'
		| 'claimDueMessages'
		| 'getMessage'
		| 'completeMessage'
		| 'rescheduleMessage'
		| 'failMessagePermanently'
	>;
	reader: Pick<WithdrawalCaseReader, 'inspectActiveById'>;
	plunk: PlunkGateway;
	alerts: AlertService;
	from: { name: string; email: string };
	supportEmail: string;
	productionOrigin: URL;
	seller: WithdrawalSellerIdentity;
};

const transientPlunkCodes = new Set([
	'PLUNK_TIMEOUT',
	'PLUNK_RATE_LIMITED',
	'PLUNK_UNAVAILABLE',
	'PLUNK_RESPONSE_INVALID'
]);
const backoffMinutes = [1, 5, 15, 60] as const;

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error('WITHDRAWAL_MESSAGE_ABORTED');
}

function stableFailure(error: unknown): string {
	return error instanceof PlunkError ? error.code : 'WITHDRAWAL_MESSAGE_FAILED';
}

function nextAttempt(now: Date, attemptCount: number): Date {
	const minutes = backoffMinutes[Math.min(attemptCount - 1, backoffMinutes.length - 1)];
	return new Date(now.getTime() + minutes * 60_000);
}

export class WithdrawalMessageWorker implements WithdrawalReceiptDispatcher {
	constructor(private readonly dependencies: WithdrawalMessageWorkerDependencies) {}

	async attemptReceipt(
		messageId: number,
		now: Date,
		signal?: AbortSignal
	): Promise<WithdrawalReceiptDeliveryState> {
		throwIfAborted(signal);
		const message = this.dependencies.repository.claimMessage(messageId, now);
		if (!message) return 'queued';
		return this.deliverClaimed(message, now, signal);
	}

	async drain(now: Date, limit: number, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		const messages = this.dependencies.repository.claimDueMessages(now, limit);
		for (const message of messages) {
			throwIfAborted(signal);
			await this.deliverClaimed(message, now, signal);
		}
	}

	private async deliverClaimed(
		message: WithdrawalMessage,
		now: Date,
		signal?: AbortSignal
	): Promise<WithdrawalReceiptDeliveryState> {
		const inspection = this.dependencies.reader.inspectActiveById(message.caseId, now);
		const kind = this.originalKind(message);
		const content = withdrawalMessage({
			kind,
			inspection,
			productionOrigin: this.dependencies.productionOrigin,
			supportEmail: this.dependencies.supportEmail,
			seller: this.dependencies.seller
		});
		let delivery: { deliveryId: string };
		try {
			const providerMessage = {
				to: content.to,
				from: this.dependencies.from,
				replyTo: this.dependencies.supportEmail,
				subject: content.subject,
				html: content.html
			};
			delivery = signal
				? await this.dependencies.plunk.send(providerMessage, signal)
				: await this.dependencies.plunk.send(providerMessage);
			if (!isWithdrawalProviderDeliveryId(delivery.deliveryId)) {
				throw new PlunkError('PLUNK_RESPONSE_INVALID');
			}
		} catch (error) {
			throwIfAborted(signal);
			const code = stableFailure(error);
			if (error instanceof PlunkError && error.code === 'PLUNK_REQUEST_REJECTED') {
				this.dependencies.repository.failMessagePermanently(
					message.id,
					message.attemptCount,
					code,
					now
				);
				this.alertUnsent(inspection.reference, now);
				return 'failed';
			}
			if (!(error instanceof PlunkError) || transientPlunkCodes.has(error.code)) {
				this.dependencies.repository.rescheduleMessage(
					message.id,
					message.attemptCount,
					nextAttempt(now, message.attemptCount),
					code
				);
				if (message.attemptCount === 5) this.alertUnsent(inspection.reference, now);
				return 'queued';
			}
			throw error;
		}
		this.dependencies.repository.completeMessage(
			message.id,
			message.attemptCount,
			delivery.deliveryId,
			now
		);
		return 'delivered';
	}

	private originalKind(message: WithdrawalMessage): Exclude<WithdrawalMessage['kind'], 'resend'> {
		const kind = resolveOriginalWithdrawalMessageKind(message, this.dependencies.repository);
		if (kind === null) throw new Error('WITHDRAWAL_MESSAGE_ROW_INVALID');
		return kind;
	}

	private alertUnsent(reference: string, now: Date): void {
		try {
			this.dependencies.alerts.enqueueAlert('WITHDRAWAL_MESSAGE_UNSENT', reference, now);
		} catch {
			// Message settlement remains authoritative if escalation persistence is unavailable.
		}
	}
}
