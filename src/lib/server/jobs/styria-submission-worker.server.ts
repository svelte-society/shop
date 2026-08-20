import type { OutboxJob } from '$lib/domain/orders';
import { isStableErrorCode, RepositoryError } from '$lib/domain/orders';
import type { OutboxRepository } from '$lib/server/db/outbox.server';
import type { PreparationResult, PreparationService } from '$lib/server/fulfillment/prepare.server';
import type { FulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import type { SubmissionService } from '$lib/server/fulfillment/submit.server';
import type { AlertService } from '$lib/server/monitoring/alerts.server';
import { nextOutboxAttempt } from './backoff';

const JOB_KIND = 'styria-create';
const JOB_KINDS = [JOB_KIND] as const;
const PREPARATION_REVIEW_CODE = 'STYRIA_AUTO_PREPARATION_REVIEW_REQUIRED';
const PAYMENT_REVIEW_CODE = 'AUTOMATIC_SUBMISSION_PAYMENT_NOT_PAID';
const AMBIGUOUS_CREATE_CODE = 'STYRIA_CREATE_AMBIGUOUS';
const INVALID_JOB_CODE = 'STYRIA_CREATE_JOB_INVALID';
const TRANSIENT_ERROR_CODE = 'STYRIA_AUTO_SUBMISSION_FAILED';

export type StyriaSubmissionDrainResult = {
	completed: number;
	rescheduled: number;
	reviewRequired: number;
};

export interface StyriaSubmissionWorker {
	drain(now?: Date, signal?: AbortSignal): Promise<StyriaSubmissionDrainResult>;
}

export type StyriaSubmissionWorkerDependencies = {
	outbox: Pick<OutboxRepository, 'claimDue' | 'complete' | 'reschedule'>;
	fulfillment: Pick<FulfillmentRepository, 'inspect' | 'requireReview'>;
	preparation: PreparationService;
	submission: SubmissionService;
	alerts?: AlertService;
};

type Settlement = 'completed' | 'rescheduled' | 'review-required';

export class StyriaSubmissionWorkerError extends Error {
	constructor(readonly code: 'STYRIA_SUBMISSION_TIME_INVALID' | 'STYRIA_SUBMISSION_STATE_INVALID') {
		super(code);
		this.name = 'StyriaSubmissionWorkerError';
	}
}

function validDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error('STYRIA_SUBMISSION_ABORTED');
}

function stableErrorCode(error: unknown): string {
	if (error instanceof RepositoryError) return error.code;
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		isStableErrorCode(error.code)
	) {
		return error.code;
	}
	return TRANSIENT_ERROR_CODE;
}

function validJob(job: OutboxJob): job is OutboxJob & { orderId: string } {
	return (
		job.kind === JOB_KIND &&
		typeof job.orderId === 'string' &&
		job.orderId.length > 0 &&
		job.orderId === job.orderId.trim() &&
		job.idempotencyKey === `${JOB_KIND}:${job.orderId}`
	);
}

export class DurableStyriaSubmissionWorker implements StyriaSubmissionWorker {
	constructor(private readonly dependencies: StyriaSubmissionWorkerDependencies) {}

	async drain(now = new Date(), signal?: AbortSignal): Promise<StyriaSubmissionDrainResult> {
		if (!validDate(now)) throw new StyriaSubmissionWorkerError('STYRIA_SUBMISSION_TIME_INVALID');
		throwIfAborted(signal);
		const [job] = this.dependencies.outbox.claimDue(now, 1, { include: JOB_KINDS });
		if (!job) return { completed: 0, rescheduled: 0, reviewRequired: 0 };

		const settlement = await this.process(job, now, signal);
		return {
			completed: settlement === 'completed' || settlement === 'review-required' ? 1 : 0,
			rescheduled: settlement === 'rescheduled' ? 1 : 0,
			reviewRequired: settlement === 'review-required' ? 1 : 0
		};
	}

	private async process(job: OutboxJob, now: Date, signal?: AbortSignal): Promise<Settlement> {
		if (!validJob(job)) {
			if (typeof job.orderId === 'string' && job.orderId.length > 0) {
				return this.requireReview(job, job.orderId, INVALID_JOB_CODE, now);
			}
			this.dependencies.outbox.complete(job.id, now);
			return 'completed';
		}

		let order;
		try {
			order = this.dependencies.fulfillment.inspect(job.orderId);
		} catch (error) {
			throwIfAborted(signal);
			return this.reschedule(job, now, stableErrorCode(error));
		}
		if (!order) return this.reschedule(job, now, 'ORDER_NOT_FOUND');

		if (order.fulfillmentStatus === 'review_required') {
			this.enqueueReviewAlert(job.orderId, now);
			this.dependencies.outbox.complete(job.id, now);
			return 'review-required';
		}
		if (order.styriaOrderId !== null && order.paymentStatus !== 'paid') {
			return this.requireReview(job, job.orderId, PAYMENT_REVIEW_CODE, now);
		}
		if (order.styriaOrderId !== null || order.fulfillmentStatus === 'cancelled') {
			this.enqueueSuccessAlert(order.fulfillmentStatus, job.orderId, now);
			this.dependencies.outbox.complete(job.id, now);
			return 'completed';
		}
		if (order.fulfillmentStatus === 'submitting') {
			return this.requireReview(job, job.orderId, AMBIGUOUS_CREATE_CODE, now);
		}
		if (order.fulfillmentStatus !== 'pending_review' || order.paymentStatus !== 'paid') {
			return this.requireReview(job, job.orderId, PREPARATION_REVIEW_CODE, now);
		}

		let preparation: PreparationResult;
		try {
			preparation = await this.dependencies.preparation.prepare(job.orderId, now, signal);
			throwIfAborted(signal);
		} catch (error) {
			throwIfAborted(signal);
			return this.settleFailureBeforeSubmission(job, now, stableErrorCode(error));
		}
		if (preparation.status === 'blocked') {
			return this.requireReview(job, job.orderId, PREPARATION_REVIEW_CODE, now);
		}
		if (preparation.warnings.length > 0) {
			return this.requireReview(job, job.orderId, PREPARATION_REVIEW_CODE, now);
		}

		try {
			await this.dependencies.submission.submit(
				{ orderId: job.orderId, approvalId: preparation.approvalId },
				now,
				signal
			);
		} catch (error) {
			return this.settleFailureAfterSubmission(job, now, signal, stableErrorCode(error));
		}

		return this.settleAfterSubmission(job, now);
	}

	private settleFailureBeforeSubmission(job: OutboxJob, now: Date, errorCode: string): Settlement {
		const current = job.orderId ? this.dependencies.fulfillment.inspect(job.orderId) : null;
		if (!current) return this.reschedule(job, now, errorCode);
		if (current.fulfillmentStatus === 'pending_review') {
			return this.reschedule(job, now, errorCode);
		}
		if (current.fulfillmentStatus === 'review_required') {
			this.enqueueReviewAlert(current.id, now);
			this.dependencies.outbox.complete(job.id, now);
			return 'review-required';
		}
		if (current.styriaOrderId !== null && current.paymentStatus !== 'paid') {
			return this.requireReview(job, current.id, PAYMENT_REVIEW_CODE, now);
		}
		if (current.styriaOrderId !== null || current.fulfillmentStatus === 'cancelled') {
			this.enqueueSuccessAlert(current.fulfillmentStatus, current.id, now);
			this.dependencies.outbox.complete(job.id, now);
			return 'completed';
		}
		return this.requireReview(job, current.id, AMBIGUOUS_CREATE_CODE, now);
	}

	private settleFailureAfterSubmission(
		job: OutboxJob,
		now: Date,
		signal: AbortSignal | undefined,
		errorCode: string
	): Settlement {
		let current;
		try {
			current = job.orderId ? this.dependencies.fulfillment.inspect(job.orderId) : null;
		} catch {
			throwIfAborted(signal);
			// Do not make the job immediately due when the post-submit state cannot be read.
			// The claim lease prevents a blind duplicate create until a later state-driven delivery.
			throw new StyriaSubmissionWorkerError('STYRIA_SUBMISSION_STATE_INVALID');
		}
		if (!current) throw new StyriaSubmissionWorkerError('STYRIA_SUBMISSION_STATE_INVALID');
		if (current.fulfillmentStatus === 'pending_review') {
			throwIfAborted(signal);
			return this.reschedule(job, now, errorCode);
		}
		if (current.fulfillmentStatus === 'review_required') {
			this.enqueueReviewAlert(current.id, now);
			this.dependencies.outbox.complete(job.id, now);
			return 'review-required';
		}
		if (current.styriaOrderId !== null && current.paymentStatus !== 'paid') {
			return this.requireReview(job, current.id, PAYMENT_REVIEW_CODE, now);
		}
		if (current.styriaOrderId !== null || current.fulfillmentStatus === 'cancelled') {
			this.enqueueSuccessAlert(current.fulfillmentStatus, current.id, now);
			this.dependencies.outbox.complete(job.id, now);
			return 'completed';
		}
		return this.requireReview(job, current.id, AMBIGUOUS_CREATE_CODE, now);
	}

	private settleAfterSubmission(job: OutboxJob, now: Date): Settlement {
		const current = job.orderId ? this.dependencies.fulfillment.inspect(job.orderId) : null;
		if (!current) throw new StyriaSubmissionWorkerError('STYRIA_SUBMISSION_STATE_INVALID');
		if (current.fulfillmentStatus === 'review_required') {
			this.enqueueReviewAlert(current.id, now);
			this.dependencies.outbox.complete(job.id, now);
			return 'review-required';
		}
		if (current.styriaOrderId !== null && current.paymentStatus !== 'paid') {
			return this.requireReview(job, current.id, PAYMENT_REVIEW_CODE, now);
		}
		if (current.styriaOrderId !== null || current.fulfillmentStatus === 'cancelled') {
			this.enqueueSuccessAlert(current.fulfillmentStatus, current.id, now);
			this.dependencies.outbox.complete(job.id, now);
			return 'completed';
		}
		return this.requireReview(job, current.id, AMBIGUOUS_CREATE_CODE, now);
	}

	private requireReview(job: OutboxJob, orderId: string, errorCode: string, now: Date): Settlement {
		const current = this.dependencies.fulfillment.inspect(orderId);
		if (!current) throw new StyriaSubmissionWorkerError('STYRIA_SUBMISSION_STATE_INVALID');
		if (current.fulfillmentStatus !== 'review_required') {
			this.dependencies.fulfillment.requireReview(orderId, errorCode, now);
		}
		this.enqueueReviewAlert(orderId, now);
		this.dependencies.outbox.complete(job.id, now);
		return 'review-required';
	}

	private enqueueReviewAlert(orderId: string, now: Date): void {
		try {
			this.dependencies.alerts?.enqueueAlert('STYRIA_REVIEW_REQUIRED', orderId, now);
		} catch {
			// The review state is durable; the operational scan retries alert delivery.
		}
	}

	private enqueueSuccessAlert(fulfillmentStatus: string, orderId: string, now: Date): void {
		const code =
			fulfillmentStatus === 'awaiting_vendor_payment'
				? 'STYRIA_PAYMENT_REQUIRED'
				: fulfillmentStatus === 'in_production'
					? 'STYRIA_UNEXPECTED_AUTO_PAID'
					: null;
		if (code === null) return;
		if (code === 'STYRIA_UNEXPECTED_AUTO_PAID') {
			// There is no periodic recovery scan for an unexpected automatic payment.
			// Keep the Styria job incomplete until this durable operator alert is recorded.
			this.dependencies.alerts?.enqueueAlert(code, orderId, now);
			return;
		}
		try {
			this.dependencies.alerts?.enqueueAlert(code, orderId, now);
		} catch {
			// Awaiting-payment reminders are recovered by the periodic operational scan.
		}
	}

	private reschedule(job: OutboxJob, now: Date, errorCode: string): Settlement {
		const attempt = job.attemptCount + 1;
		this.dependencies.outbox.reschedule(
			job.id,
			attempt,
			nextOutboxAttempt(now, attempt),
			isStableErrorCode(errorCode) ? errorCode : TRANSIENT_ERROR_CODE
		);
		return 'rescheduled';
	}
}
