import { mapStyriaStatus } from '$lib/domain/fulfillment';
import { RepositoryError } from '$lib/domain/orders';
import type {
	FulfillmentRepository,
	OrderWithLinesAndEvents
} from '$lib/server/fulfillment/repository.server';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import { StyriaError, type StyriaGateway } from '$lib/server/styria/gateway';
import { buildStyriaPayload, hashStyriaPayload } from '$lib/server/styria/payload';
import type { StyriaOrder, StyriaOrderPayload } from '$lib/server/styria/types';
import type { AlertService } from '$lib/server/monitoring/alerts.server';
import { buildStyriaSubmissionEvidence, isConsistentStyriaOrder } from './reconcile.server';

const AMBIGUOUS_ERROR_CODE = 'STYRIA_CREATE_AMBIGUOUS';

export const RECONCILIATION_INSTRUCTION =
	'Run reconcile_styria_order for this order before any further submission attempt.';
export const REJECTION_REVIEW_INSTRUCTION =
	'Review the Styria request rejection before taking further fulfillment action.';

export interface SubmissionService {
	submit(
		input: { orderId: string; approvalId: string },
		now?: Date,
		signal?: AbortSignal
	): Promise<SubmissionResult>;
}

type SubmissionIdentity = {
	orderId: string;
	styriaOrderId: string;
};

export type SubmissionResult = SubmissionIdentity &
	(
		| {
				fulfillmentStatus: 'awaiting_vendor_payment';
				manualPaymentRequired: true;
		  }
		| {
				fulfillmentStatus: 'in_production' | 'review_required';
				manualPaymentRequired: false;
		  }
	);

type SubmissionFulfillmentStatus = SubmissionResult['fulfillmentStatus'];

export type SubmissionDependencies = {
	fulfillment: Pick<
		FulfillmentRepository,
		'inspect' | 'beginSubmission' | 'recordSubmitted' | 'requireReview'
	>;
	stripe: StripeFulfillmentGateway;
	styria: StyriaGateway;
	brandName: string;
	comment: string;
	alerts?: AlertService;
};

export class SubmissionError extends Error {
	constructor(
		readonly code: string,
		readonly instruction: string | null = null
	) {
		super(code);
		this.name = 'SubmissionError';
	}
}

function fail(code: string, instruction: string | null = null): never {
	throw new SubmissionError(code, instruction);
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

function validDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function successResult(
	orderId: string,
	order: StyriaOrder,
	fulfillmentStatus: SubmissionFulfillmentStatus
): SubmissionResult {
	const identity = { orderId, styriaOrderId: order.id };
	if (fulfillmentStatus === 'awaiting_vendor_payment') {
		return { ...identity, fulfillmentStatus, manualPaymentRequired: true };
	}
	return { ...identity, fulfillmentStatus, manualPaymentRequired: false };
}

function submittedFulfillmentStatus(styriaStatus: string): SubmissionFulfillmentStatus {
	const status = mapStyriaStatus({ status: styriaStatus, deleted: false, trackingNumber: null });
	if (
		status !== 'awaiting_vendor_payment' &&
		status !== 'in_production' &&
		status !== 'review_required'
	) {
		fail('STYRIA_RESPONSE_INVALID');
	}
	return status;
}

export class FulfillmentSubmissionService implements SubmissionService {
	constructor(private readonly dependencies: SubmissionDependencies) {}

	private reviewAndFail(
		orderId: string,
		now: Date,
		reviewCode: string,
		errorCode: string,
		instruction: string
	): never {
		try {
			this.dependencies.fulfillment.requireReview(orderId, reviewCode, now);
		} catch {
			fail('FULFILLMENT_REVIEW_FAILED', instruction);
		}
		try {
			this.dependencies.alerts?.enqueueAlert('STYRIA_REVIEW_REQUIRED', orderId, now);
		} catch {
			// The durable review state remains authoritative; the scheduled scan retries alerting.
		}
		fail(errorCode, instruction);
	}

	private recordOrRequireReconciliation(orderId: string, order: StyriaOrder, now: Date): void {
		try {
			this.dependencies.fulfillment.recordSubmitted(orderId, order.id, order.status, now);
		} catch {
			this.reviewAndFail(
				orderId,
				now,
				AMBIGUOUS_ERROR_CODE,
				'STYRIA_RECONCILIATION_REQUIRED',
				RECONCILIATION_INSTRUCTION
			);
		}
	}

	async submit(
		input: { orderId: string; approvalId: string },
		now = new Date(),
		signal?: AbortSignal
	): ReturnType<SubmissionService['submit']> {
		if (
			!input ||
			!isExactString(input.orderId, 200) ||
			!isExactString(input.approvalId, 200) ||
			!validDate(now)
		) {
			fail('FULFILLMENT_SUBMISSION_INVALID');
		}

		let order: OrderWithLinesAndEvents | null;
		try {
			order = this.dependencies.fulfillment.inspect(input.orderId);
		} catch {
			fail('FULFILLMENT_ORDER_READ_FAILED');
		}
		if (!order) fail('FULFILLMENT_ORDER_NOT_FOUND');

		let details;
		try {
			details = await this.dependencies.stripe.retrieveFulfillmentDetails(
				order.checkoutSessionId,
				signal
			);
		} catch {
			fail('FULFILLMENT_DETAILS_RETRIEVAL_FAILED');
		}

		let payload: StyriaOrderPayload;
		let payloadHash: string;
		try {
			payload = buildStyriaPayload({
				order,
				fulfillment: { recipient: details.recipient, address: details.address },
				brandName: this.dependencies.brandName,
				comment: this.dependencies.comment
			});
			payloadHash = hashStyriaPayload(payload);
		} catch {
			fail('FULFILLMENT_PAYLOAD_REBUILD_FAILED');
		}
		const evidence = buildStyriaSubmissionEvidence(order);

		try {
			this.dependencies.fulfillment.beginSubmission(
				input.orderId,
				input.approvalId,
				payloadHash,
				now
			);
		} catch (error) {
			if (error instanceof RepositoryError) fail(error.code);
			fail('FULFILLMENT_BEGIN_FAILED');
		}

		let matches: StyriaOrder[];
		try {
			const providerMatches = await this.dependencies.styria.searchByExternalId(
				payload.external_id,
				evidence.createdAfter,
				signal
			);
			if (!Array.isArray(providerMatches)) throw new Error('invalid response');
			matches = providerMatches.filter((match) => match.external_id === payload.external_id);
		} catch (error) {
			if (error instanceof StyriaError && error.code === 'STYRIA_REQUEST_REJECTED') {
				this.reviewAndFail(
					input.orderId,
					now,
					error.code,
					error.code,
					REJECTION_REVIEW_INSTRUCTION
				);
			}
			this.reviewAndFail(
				input.orderId,
				now,
				AMBIGUOUS_ERROR_CODE,
				'STYRIA_RECONCILIATION_REQUIRED',
				RECONCILIATION_INSTRUCTION
			);
		}

		if (matches.length > 0) {
			if (matches.length !== 1 || !isConsistentStyriaOrder(matches[0], evidence)) {
				this.reviewAndFail(
					input.orderId,
					now,
					AMBIGUOUS_ERROR_CODE,
					'STYRIA_RECONCILIATION_REQUIRED',
					RECONCILIATION_INSTRUCTION
				);
			}
			this.recordOrRequireReconciliation(input.orderId, matches[0], now);
			const fulfillmentStatus = submittedFulfillmentStatus(matches[0].status);
			return successResult(input.orderId, matches[0], fulfillmentStatus);
		}

		let created: StyriaOrder;
		try {
			created = await this.dependencies.styria.create(payload, signal);
		} catch (error) {
			if (error instanceof StyriaError && error.code === 'STYRIA_REQUEST_REJECTED') {
				this.reviewAndFail(
					input.orderId,
					now,
					error.code,
					error.code,
					REJECTION_REVIEW_INSTRUCTION
				);
			}
			this.reviewAndFail(
				input.orderId,
				now,
				AMBIGUOUS_ERROR_CODE,
				'STYRIA_RECONCILIATION_REQUIRED',
				RECONCILIATION_INSTRUCTION
			);
		}

		if (!isConsistentStyriaOrder(created, evidence)) {
			this.reviewAndFail(
				input.orderId,
				now,
				AMBIGUOUS_ERROR_CODE,
				'STYRIA_RECONCILIATION_REQUIRED',
				RECONCILIATION_INSTRUCTION
			);
		}
		this.recordOrRequireReconciliation(input.orderId, created, now);
		const fulfillmentStatus = submittedFulfillmentStatus(created.status);
		return successResult(input.orderId, created, fulfillmentStatus);
	}
}
