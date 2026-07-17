import { randomUUID } from 'node:crypto';
import { RepositoryError } from '$lib/domain/orders';
import type { OutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import type { PlunkGateway, PlunkSendInput } from './gateway';

export const SHIPPING_EMAIL_SUBJECT = 'Your Svelte Society order is on the way';

export type ShippingEmailInput = {
	recipientEmail: string;
	productSummary: string;
	trackingNumber: string;
	supportEmail: string;
};

export interface ShippingEmailSender {
	send(input: ShippingEmailInput, signal?: AbortSignal): Promise<{ deliveryId: string }>;
}

export type ShippingOrderDetails = {
	orderId: string;
	checkoutSessionId: string;
	trackingNumber: string;
	productSummary: string;
};

type ShippingOrderRow = {
	id: unknown;
	stripe_checkout_session_id: unknown;
	payment_status: unknown;
	tracking_number: unknown;
};

type ShippingLineRow = {
	product_name: unknown;
	variant_label: unknown;
	quantity: unknown;
};

function fail(code: string): never {
	throw new RepositoryError(code);
}

function exactString(value: unknown, maximum = 500): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum &&
		value === value.trim() &&
		!/[\r\n]/.test(value)
	);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function validateMessageInput(input: ShippingEmailInput): void {
	if (
		!input ||
		!exactString(input.recipientEmail) ||
		!exactString(input.productSummary, 2_000) ||
		!exactString(input.trackingNumber, 200) ||
		!exactString(input.supportEmail)
	) {
		fail('SHIPPING_EMAIL_INPUT_INVALID');
	}
}

export function shippingEmailMessage(
	input: ShippingEmailInput,
	from: { name: string; email: string },
	productionOrigin: string
): PlunkSendInput {
	validateMessageInput(input);
	if (!from || !exactString(from.name, 200) || !exactString(from.email)) {
		fail('SHIPPING_EMAIL_CONFIG_INVALID');
	}
	let withdrawalUrl: string;
	try {
		const origin = new URL(productionOrigin);
		if (
			origin.protocol !== 'https:' ||
			origin.origin !== productionOrigin ||
			origin.pathname !== '/'
		)
			fail('SHIPPING_EMAIL_CONFIG_INVALID');
		withdrawalUrl = new URL('/withdraw', origin).href;
	} catch {
		fail('SHIPPING_EMAIL_CONFIG_INVALID');
	}
	const productSummary = escapeHtml(input.productSummary);
	const trackingNumber = escapeHtml(input.trackingNumber);
	const supportEmail = escapeHtml(input.supportEmail);
	return {
		to: input.recipientEmail,
		from,
		replyTo: input.supportEmail,
		subject: SHIPPING_EMAIL_SUBJECT,
		html:
			'<p>Your Svelte Society merch has shipped.</p>' +
			`<p>${productSummary}</p>` +
			`<p>Tracking: ${trackingNumber}</p>` +
			'<p>Thanks for being part of the Svelte community.</p>' +
			`<p><a href="${withdrawalUrl}">Withdraw from this purchase</a>.</p>` +
			`<p>Questions? Email ${supportEmail}.</p>`
	};
}

export function createShippingEmailSender(
	plunk: PlunkGateway,
	from: { name: string; email: string },
	productionOrigin = process.env.PRODUCTION_ORIGIN ?? ''
): ShippingEmailSender {
	return {
		send(input, signal) {
			const message = shippingEmailMessage(input, from, productionOrigin);
			return signal ? plunk.send(message, signal) : plunk.send(message);
		}
	};
}

export function loadShippingOrder(database: ShopDatabase, orderId: string): ShippingOrderDetails {
	if (!exactString(orderId, 200)) fail('SHIPPING_EMAIL_ORDER_INVALID');
	const row = database
		.prepare(
			`SELECT id, stripe_checkout_session_id, payment_status, tracking_number
			FROM orders WHERE id = ?`
		)
		.get(orderId) as ShippingOrderRow | undefined;
	if (
		!row ||
		row.id !== orderId ||
		!exactString(row.stripe_checkout_session_id, 200) ||
		!exactString(row.payment_status, 30) ||
		!['paid', 'partially_refunded', 'refunded'].includes(row.payment_status) ||
		!exactString(row.tracking_number, 200)
	) {
		fail('SHIPPING_EMAIL_ORDER_INVALID');
	}
	const lines = database
		.prepare(
			`SELECT product_name, variant_label, quantity
			FROM order_lines WHERE order_id = ? ORDER BY line_index`
		)
		.all(orderId) as ShippingLineRow[];
	if (lines.length === 0) fail('SHIPPING_EMAIL_ORDER_INVALID');
	const productSummary = lines
		.map((line) => {
			if (
				!exactString(line.product_name, 500) ||
				!exactString(line.variant_label, 500) ||
				!Number.isSafeInteger(line.quantity) ||
				(line.quantity as number) < 1
			) {
				fail('SHIPPING_EMAIL_ORDER_INVALID');
			}
			return `${line.quantity as number} × ${line.product_name} (${line.variant_label})`;
		})
		.join(', ');
	if (productSummary.length > 2_000) fail('SHIPPING_EMAIL_ORDER_INVALID');
	return {
		orderId,
		checkoutSessionId: row.stripe_checkout_session_id,
		trackingNumber: row.tracking_number,
		productSummary
	};
}

export type SqliteShippingEmailServiceDependencies = {
	database: ShopDatabase;
	outbox: OutboxRepository;
	stripe: StripeFulfillmentGateway;
	sender: ShippingEmailSender;
	supportEmail: string;
	now?: () => Date;
	idempotencyKey?: () => string;
};

export class SqliteShippingEmailService {
	private readonly now: () => Date;
	private readonly idempotencyKey: () => string;

	constructor(private readonly dependencies: SqliteShippingEmailServiceDependencies) {
		this.now = dependencies.now ?? (() => new Date());
		this.idempotencyKey = dependencies.idempotencyKey ?? randomUUID;
	}

	async getTarget(orderId: string): Promise<{ email: string; trackingNumber: string }> {
		const order = loadShippingOrder(this.dependencies.database, orderId);
		const details = await this.dependencies.stripe.retrieveFulfillmentDetails(
			order.checkoutSessionId
		);
		return { email: details.email, trackingNumber: order.trackingNumber };
	}

	async send(input: {
		orderId: string;
		expectedEmail: string;
		expectedTrackingNumber: string;
	}): Promise<{ sent: true }> {
		const order = loadShippingOrder(this.dependencies.database, input.orderId);
		if (order.trackingNumber !== input.expectedTrackingNumber) {
			fail('SHIPPING_EMAIL_REVIEW_MISMATCH');
		}
		// Fetch again at the action boundary so a preview cannot authorize a stale address.
		const details = await this.dependencies.stripe.retrieveFulfillmentDetails(
			order.checkoutSessionId
		);
		if (details.email !== input.expectedEmail) fail('SHIPPING_EMAIL_REVIEW_MISMATCH');
		const idempotencyKey = `shipping-support:${order.orderId}:${order.trackingNumber}:${this.idempotencyKey()}`;
		if (
			!this.dependencies.outbox.beginEmailDelivery({
				orderId: order.orderId,
				kind: 'shipping-support',
				trackingNumber: order.trackingNumber,
				idempotencyKey
			})
		) {
			fail('SHIPPING_EMAIL_ACTION_CONFLICT');
		}
		const delivery = await this.dependencies.sender.send({
			recipientEmail: details.email,
			productSummary: order.productSummary,
			trackingNumber: order.trackingNumber,
			supportEmail: this.dependencies.supportEmail
		});
		this.dependencies.outbox.completeEmailDelivery(
			{
				orderId: order.orderId,
				kind: 'shipping-support',
				trackingNumber: order.trackingNumber,
				idempotencyKey
			},
			delivery.deliveryId,
			this.now()
		);
		return { sent: true };
	}
}
