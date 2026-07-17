import type { OutboxJob } from '$lib/domain/orders';
import { RepositoryError } from '$lib/domain/orders';
import type { OutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import type { PlunkGateway } from '$lib/server/plunk/gateway';
import { PlunkError } from '$lib/server/plunk/gateway';
import { loadShippingOrder, type ShippingEmailSender } from '$lib/server/plunk/shipping-email';
import { StripeFulfillmentError } from '$lib/server/stripe/client.server';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import { nextOutboxAttempt } from './backoff';

const DEFAULT_BATCH_LIMIT = 25;
const PAID_ORDER_ALERT_SUBJECT = 'Svelte Society Shop: paid order awaiting review';

export interface OutboxWorker {
	drain(now: Date, limit?: number): Promise<{ completed: number; rescheduled: number }>;
}

export type PaidOrderAlertEmailConfig = {
	to: string;
	from: { name: string; email: string };
	replyTo: string;
};

export type PaidOrderAlertOutboxWorkerDependencies = {
	database: ShopDatabase;
	outbox: OutboxRepository;
	plunk: PlunkGateway;
	alertEmail: PaidOrderAlertEmailConfig;
	shipping?: {
		stripe: StripeFulfillmentGateway;
		sender: ShippingEmailSender;
		supportEmail: string;
	};
};

type PaidOrderAlertRow = {
	id: unknown;
	total_amount: unknown;
	destination_country: unknown;
	unit_count: unknown;
};

type PaidOrderAlert = {
	id: string;
	totalAmount: number;
	destinationCountry: string;
	unitCount: number;
};

class OutboxWorkerError extends Error {
	constructor(
		readonly code:
			| 'OUTBOX_JOB_KIND_UNSUPPORTED'
			| 'PAID_ORDER_ALERT_JOB_INVALID'
			| 'PAID_ORDER_ALERT_DATA_INVALID'
			| 'SHIPPING_EMAIL_SERVICE_UNAVAILABLE'
			| 'SHIPPING_EMAIL_JOB_INVALID'
	) {
		super(code);
		this.name = 'OutboxWorkerError';
	}
}

function loadPaidOrderAlert(database: ShopDatabase, job: OutboxJob): PaidOrderAlert {
	if (job.kind !== 'paid-order-alert') {
		throw new OutboxWorkerError('OUTBOX_JOB_KIND_UNSUPPORTED');
	}
	if (job.orderId === null || job.idempotencyKey !== `paid-order-alert:${job.orderId}`) {
		throw new OutboxWorkerError('PAID_ORDER_ALERT_JOB_INVALID');
	}
	const row = database
		.prepare(
			`SELECT o.id, o.total_amount, o.destination_country, SUM(ol.quantity) AS unit_count
			FROM orders o
			JOIN order_lines ol ON ol.order_id = o.id
			WHERE o.id = ?
			GROUP BY o.id, o.total_amount, o.destination_country`
		)
		.get(job.orderId) as PaidOrderAlertRow | undefined;
	if (
		!row ||
		typeof row.id !== 'string' ||
		row.id.length === 0 ||
		!Number.isSafeInteger(row.total_amount) ||
		(row.total_amount as number) < 0 ||
		typeof row.destination_country !== 'string' ||
		!Number.isSafeInteger(row.unit_count) ||
		(row.unit_count as number) < 1
	) {
		throw new OutboxWorkerError('PAID_ORDER_ALERT_DATA_INVALID');
	}
	return {
		id: row.id,
		totalAmount: row.total_amount as number,
		destinationCountry: row.destination_country,
		unitCount: row.unit_count as number
	};
}

function stableErrorCode(error: unknown, job: OutboxJob): string {
	if (
		error instanceof PlunkError ||
		error instanceof RepositoryError ||
		error instanceof StripeFulfillmentError
	)
		return error.code;
	if (error instanceof OutboxWorkerError) return error.code;
	return job.kind === 'shipping-email' ? 'SHIPPING_EMAIL_FAILED' : 'PAID_ORDER_ALERT_FAILED';
}

function shippingReference(job: OutboxJob, trackingNumber: string) {
	if (
		job.kind !== 'shipping-email' ||
		job.orderId === null ||
		job.idempotencyKey !== `shipping:${job.orderId}:${trackingNumber}`
	) {
		throw new OutboxWorkerError('SHIPPING_EMAIL_JOB_INVALID');
	}
	return {
		orderId: job.orderId,
		kind: 'shipping' as const,
		trackingNumber,
		idempotencyKey: job.idempotencyKey
	};
}

function paidOrderAlertHtml(order: PaidOrderAlert): string {
	return (
		`<p>Internal order ID: ${order.id}</p>` +
		`<p>Unit count: ${order.unitCount}</p>` +
		`<p>Total: EUR ${(order.totalAmount / 100).toFixed(2)}</p>` +
		`<p>Destination country: ${order.destinationCountry}</p>` +
		'<p>Open Codex and use list_pending_orders.</p>'
	);
}

export class PaidOrderAlertOutboxWorker implements OutboxWorker {
	constructor(private readonly dependencies: PaidOrderAlertOutboxWorkerDependencies) {}

	async drain(
		now: Date,
		limit = DEFAULT_BATCH_LIMIT
	): Promise<{ completed: number; rescheduled: number }> {
		const jobs = this.dependencies.outbox.claimDue(now, limit);
		const outcomes = await Promise.all(
			jobs.map(async (job): Promise<'completed' | 'rescheduled'> => {
				try {
					if (job.kind === 'shipping-email') {
						await this.sendShipping(job, now);
					} else {
						await this.sendPaidOrderAlert(job, now);
					}
					return 'completed';
				} catch (error) {
					const attempt = job.attemptCount + 1;
					this.dependencies.outbox.reschedule(
						job.id,
						attempt,
						nextOutboxAttempt(now, attempt),
						stableErrorCode(error, job)
					);
					return 'rescheduled';
				}
			})
		);

		return {
			completed: outcomes.filter((outcome) => outcome === 'completed').length,
			rescheduled: outcomes.filter((outcome) => outcome === 'rescheduled').length
		};
	}

	private async sendPaidOrderAlert(job: OutboxJob, now: Date): Promise<void> {
		const order = loadPaidOrderAlert(this.dependencies.database, job);
		await this.dependencies.plunk.send({
			to: this.dependencies.alertEmail.to,
			from: this.dependencies.alertEmail.from,
			replyTo: this.dependencies.alertEmail.replyTo,
			subject: PAID_ORDER_ALERT_SUBJECT,
			html: paidOrderAlertHtml(order)
		});
		this.dependencies.outbox.complete(job.id, now);
	}

	private async sendShipping(job: OutboxJob, now: Date): Promise<void> {
		const shipping = this.dependencies.shipping;
		if (!shipping) throw new OutboxWorkerError('SHIPPING_EMAIL_SERVICE_UNAVAILABLE');
		if (job.orderId === null) throw new OutboxWorkerError('SHIPPING_EMAIL_JOB_INVALID');
		const order = loadShippingOrder(this.dependencies.database, job.orderId);
		const reference = shippingReference(job, order.trackingNumber);
		if (!this.dependencies.outbox.beginEmailDelivery(reference)) {
			this.dependencies.outbox.complete(job.id, now);
			return;
		}
		// Stripe remains the source of truth. Retrieve the current address object only at send time,
		// use its email, and discard the rest without persisting it.
		const details = await shipping.stripe.retrieveFulfillmentDetails(order.checkoutSessionId);
		const delivery = await shipping.sender.send({
			recipientEmail: details.email,
			productSummary: order.productSummary,
			trackingNumber: order.trackingNumber,
			supportEmail: shipping.supportEmail
		});
		this.dependencies.outbox.completeEmailDelivery(reference, delivery.deliveryId, now, job.id);
	}
}
