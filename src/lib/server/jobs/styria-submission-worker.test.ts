import { describe, expect, it, vi } from 'vitest';
import type { FulfillmentStatus, OutboxJob, PaymentStatus } from '$lib/domain/orders';
import type { OutboxClaimFilter, OutboxRepository } from '$lib/server/db/outbox.server';
import type { PreparationResult, PreparationService } from '$lib/server/fulfillment/prepare.server';
import type { FulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import type { SubmissionResult, SubmissionService } from '$lib/server/fulfillment/submit.server';
import type { AlertService } from '$lib/server/monitoring/alerts.server';
import {
	DurableStyriaSubmissionWorker,
	type StyriaSubmissionWorkerDependencies
} from './styria-submission-worker.server';

const now = new Date('2026-08-19T20:30:00.000Z');
const orderId = 'order_auto_123';

type MutableOrderState = {
	id: string;
	paymentStatus: PaymentStatus;
	fulfillmentStatus: FulfillmentStatus;
	styriaOrderId: string | null;
	lastErrorCode: string | null;
};

type SetupInput = Partial<Omit<MutableOrderState, 'id'>> & {
	prepare?: () => Promise<PreparationResult>;
	submit?: (state: MutableOrderState, signal?: AbortSignal) => Promise<SubmissionResult>;
	alert?: AlertService['enqueueAlert'];
};

function readyPreparation(
	warnings: Array<{ code: string; message: string }> = []
): PreparationResult {
	return {
		status: 'ready',
		orderId,
		approvalId: 'automatic-approval',
		expiresAt: '2026-08-19T20:40:00.000Z',
		payloadHash: 'a'.repeat(64),
		payload: {} as never,
		warnings,
		blockers: []
	};
}

function blockedPreparation(): PreparationResult {
	return {
		status: 'blocked',
		orderId,
		approvalId: null,
		expiresAt: null,
		payloadHash: null,
		payload: null,
		warnings: [],
		blockers: [{ code: 'ORDER_SNAPSHOT_INVALID', message: 'Fixture blocker.' }]
	};
}

function jobFixture(overrides: Partial<OutboxJob> = {}): OutboxJob {
	return {
		id: 17,
		kind: 'styria-create',
		idempotencyKey: `styria-create:${orderId}`,
		orderId,
		nextAttemptAt: now,
		attemptCount: 0,
		completedAt: null,
		lastErrorCode: null,
		...overrides
	};
}

function inspected(
	state: MutableOrderState
): NonNullable<ReturnType<FulfillmentRepository['inspect']>> {
	return {
		id: state.id,
		paymentStatus: state.paymentStatus,
		fulfillmentStatus: state.fulfillmentStatus,
		styriaOrderId: state.styriaOrderId,
		lastErrorCode: state.lastErrorCode
	} as NonNullable<ReturnType<FulfillmentRepository['inspect']>>;
}

function setup(input: SetupInput = {}) {
	const state: MutableOrderState = {
		id: orderId,
		paymentStatus: input.paymentStatus ?? 'paid',
		fulfillmentStatus: input.fulfillmentStatus ?? 'pending_review',
		styriaOrderId: input.styriaOrderId ?? null,
		lastErrorCode: input.lastErrorCode ?? null
	};
	let due = true;
	const claimDue = vi.fn((_at: Date, _limit: number, _filter?: OutboxClaimFilter): OutboxJob[] => {
		void _at;
		void _limit;
		void _filter;
		if (!due) return [];
		due = false;
		return [jobFixture()];
	});
	const complete = vi.fn();
	const reschedule = vi.fn();
	const outbox = {
		claimDue,
		complete,
		reschedule
	} satisfies Pick<OutboxRepository, 'claimDue' | 'complete' | 'reschedule'>;
	const inspect = vi.fn(() => inspected(state));
	const requireReview = vi.fn((_id: string, errorCode: string) => {
		state.fulfillmentStatus = 'review_required';
		state.lastErrorCode = errorCode;
	});
	const fulfillment = {
		inspect,
		requireReview
	} satisfies Pick<FulfillmentRepository, 'inspect' | 'requireReview'>;
	const prepare = vi.fn(
		input.prepare ?? (async (): Promise<PreparationResult> => readyPreparation())
	);
	const preparation = { prepare } satisfies PreparationService;
	const submit = vi.fn(
		input.submit ??
			(async (mutable: MutableOrderState): Promise<SubmissionResult> => {
				mutable.fulfillmentStatus = 'awaiting_vendor_payment';
				mutable.styriaOrderId = 'styria_456';
				return {
					orderId,
					styriaOrderId: 'styria_456',
					fulfillmentStatus: 'awaiting_vendor_payment',
					manualPaymentRequired: true
				};
			})
	);
	const submission = {
		submit: vi.fn(async (_request, _at, signal) => submit(state, signal))
	} satisfies SubmissionService;
	const enqueueAlert = vi.fn(input.alert ?? (() => undefined));
	const alerts = { enqueueAlert } satisfies AlertService;
	const dependencies: StyriaSubmissionWorkerDependencies = {
		outbox,
		fulfillment,
		preparation,
		submission,
		alerts
	};
	return {
		state,
		worker: new DurableStyriaSubmissionWorker(dependencies),
		claimDue,
		complete,
		reschedule,
		inspect,
		requireReview,
		prepare,
		submit,
		enqueueAlert,
		makeDue: () => {
			due = true;
		}
	};
}

describe('DurableStyriaSubmissionWorker', () => {
	it('claims exactly one Styria job, submits it, alerts for manual payment, and completes', async () => {
		const state = setup();

		await expect(state.worker.drain(now)).resolves.toEqual({
			completed: 1,
			rescheduled: 0,
			reviewRequired: 0
		});
		expect(state.claimDue).toHaveBeenCalledWith(now, 1, { include: ['styria-create'] });
		expect(state.prepare).toHaveBeenCalledWith(orderId, now, undefined);
		expect(state.submit).toHaveBeenCalledOnce();
		expect(state.enqueueAlert).toHaveBeenCalledWith('STYRIA_PAYMENT_REQUIRED', orderId, now);
		expect(state.complete).toHaveBeenCalledWith(17, now);
		expect(state.reschedule).not.toHaveBeenCalled();
	});

	it('alerts when Styria unexpectedly consumes credit and still completes the job', async () => {
		const state = setup({
			submit: async (order) => {
				order.fulfillmentStatus = 'in_production';
				order.styriaOrderId = 'styria_paid';
				return {
					orderId,
					styriaOrderId: 'styria_paid',
					fulfillmentStatus: 'in_production',
					manualPaymentRequired: false
				};
			}
		});

		await expect(state.worker.drain(now)).resolves.toEqual({
			completed: 1,
			rescheduled: 0,
			reviewRequired: 0
		});
		expect(state.enqueueAlert).toHaveBeenCalledWith('STYRIA_UNEXPECTED_AUTO_PAID', orderId, now);
	});

	it('keeps an unexpected auto-paid job incomplete until its durable alert is recorded', async () => {
		let alertAttempts = 0;
		const state = setup({
			submit: async (order) => {
				order.fulfillmentStatus = 'in_production';
				order.styriaOrderId = 'styria_paid';
				return {
					orderId,
					styriaOrderId: 'styria_paid',
					fulfillmentStatus: 'in_production',
					manualPaymentRequired: false
				};
			},
			alert: () => {
				alertAttempts += 1;
				if (alertAttempts === 1) throw new Error('alert unavailable');
			}
		});

		await expect(state.worker.drain(now)).rejects.toThrow('alert unavailable');
		expect(state.complete).not.toHaveBeenCalled();
		expect(state.submit).toHaveBeenCalledOnce();

		state.makeDue();
		await expect(state.worker.drain(now)).resolves.toEqual({
			completed: 1,
			rescheduled: 0,
			reviewRequired: 0
		});
		expect(state.submit).toHaveBeenCalledOnce();
		expect(state.enqueueAlert).toHaveBeenCalledTimes(2);
		expect(state.complete).toHaveBeenCalledWith(17, now);
	});

	it('moves preparation warnings or blockers to durable review without submission', async () => {
		for (const prepare of [
			async () => readyPreparation([{ code: 'PAYMENT_WARNING', message: 'Fixture warning.' }]),
			async () => blockedPreparation()
		]) {
			const state = setup({ prepare });

			await expect(state.worker.drain(now)).resolves.toEqual({
				completed: 1,
				rescheduled: 0,
				reviewRequired: 1
			});
			expect(state.requireReview).toHaveBeenCalledWith(
				orderId,
				'STYRIA_AUTO_PREPARATION_REVIEW_REQUIRED',
				now
			);
			expect(state.submit).not.toHaveBeenCalled();
			expect(state.enqueueAlert).toHaveBeenCalledWith('STYRIA_REVIEW_REQUIRED', orderId, now);
			expect(state.complete).toHaveBeenCalledWith(17, now);
		}
	});

	it('routes a refund received before draining to review without preparing the order', async () => {
		const state = setup({ paymentStatus: 'refunded' });

		await expect(state.worker.drain(now)).resolves.toEqual({
			completed: 1,
			rescheduled: 0,
			reviewRequired: 1
		});
		expect(state.prepare).not.toHaveBeenCalled();
		expect(state.submit).not.toHaveBeenCalled();
		expect(state.requireReview).toHaveBeenCalledWith(
			orderId,
			'STYRIA_AUTO_PREPARATION_REVIEW_REQUIRED',
			now
		);
		expect(state.complete).toHaveBeenCalledWith(17, now);
	});

	it('reschedules a transient preparation failure only while the order remains pending', async () => {
		const state = setup({
			prepare: async () => {
				throw { code: 'STRIPE_TEMPORARILY_UNAVAILABLE' };
			}
		});

		await expect(state.worker.drain(now)).resolves.toEqual({
			completed: 0,
			rescheduled: 1,
			reviewRequired: 0
		});
		expect(state.reschedule).toHaveBeenCalledWith(
			17,
			1,
			new Date('2026-08-19T20:32:00.000Z'),
			'STRIPE_TEMPORARILY_UNAVAILABLE'
		);
		expect(state.submit).not.toHaveBeenCalled();
		expect(state.complete).not.toHaveBeenCalled();
	});

	it('never resubmits an order found in submitting and routes it to reconciliation', async () => {
		const state = setup({ fulfillmentStatus: 'submitting' });

		await expect(state.worker.drain(now)).resolves.toEqual({
			completed: 1,
			rescheduled: 0,
			reviewRequired: 1
		});
		expect(state.prepare).not.toHaveBeenCalled();
		expect(state.submit).not.toHaveBeenCalled();
		expect(state.requireReview).toHaveBeenCalledWith(orderId, 'STYRIA_CREATE_AMBIGUOUS', now);
		expect(state.enqueueAlert).toHaveBeenCalledWith('STYRIA_REVIEW_REQUIRED', orderId, now);
	});

	it('settles an ambiguous post-submit failure into review instead of retrying create', async () => {
		const state = setup({
			submit: async (order) => {
				order.fulfillmentStatus = 'submitting';
				throw { code: 'STYRIA_REQUEST_FAILED' };
			}
		});

		await expect(state.worker.drain(now)).resolves.toEqual({
			completed: 1,
			rescheduled: 0,
			reviewRequired: 1
		});
		expect(state.requireReview).toHaveBeenCalledWith(orderId, 'STYRIA_CREATE_AMBIGUOUS', now);
		expect(state.reschedule).not.toHaveBeenCalled();
		expect(state.complete).toHaveBeenCalledWith(17, now);
	});

	it('completes a provider-linked redelivery idempotently without preparing or creating again', async () => {
		const state = setup({
			fulfillmentStatus: 'awaiting_vendor_payment',
			styriaOrderId: 'styria_existing',
			alert: () => {
				throw new Error('alert unavailable');
			}
		});

		await expect(state.worker.drain(now)).resolves.toEqual({
			completed: 1,
			rescheduled: 0,
			reviewRequired: 0
		});
		expect(state.prepare).not.toHaveBeenCalled();
		expect(state.submit).not.toHaveBeenCalled();
		expect(state.complete).toHaveBeenCalledWith(17, now);
	});

	it('routes a refunded provider-linked redelivery to review without requesting payment', async () => {
		const state = setup({
			paymentStatus: 'partially_refunded',
			fulfillmentStatus: 'awaiting_vendor_payment',
			styriaOrderId: 'styria_existing'
		});

		await expect(state.worker.drain(now)).resolves.toEqual({
			completed: 1,
			rescheduled: 0,
			reviewRequired: 1
		});
		expect(state.prepare).not.toHaveBeenCalled();
		expect(state.submit).not.toHaveBeenCalled();
		expect(state.requireReview).toHaveBeenCalledWith(
			orderId,
			'AUTOMATIC_SUBMISSION_PAYMENT_NOT_PAID',
			now
		);
		expect(state.enqueueAlert).toHaveBeenCalledWith('STYRIA_REVIEW_REQUIRED', orderId, now);
		expect(state.enqueueAlert).not.toHaveBeenCalledWith('STYRIA_PAYMENT_REQUIRED', orderId, now);
		expect(state.complete).toHaveBeenCalledWith(17, now);
	});

	it('does not claim work after cancellation', async () => {
		const state = setup();
		const controller = new AbortController();
		controller.abort(new Error('shutdown'));

		await expect(state.worker.drain(now, controller.signal)).rejects.toThrow('shutdown');
		expect(state.claimDue).not.toHaveBeenCalled();
	});
});
