import { randomUUID } from 'node:crypto';
import { isMarketDestination } from '$lib/domain/destinations';
import type {
	CheckoutDraftLine,
	FulfillmentStatus,
	Order,
	OrderLine,
	OrderWithLines,
	PaidOrderInput,
	PaymentStatus,
	StripeEventInput
} from '$lib/domain/orders';
import { isStableErrorCode, RepositoryError } from '$lib/domain/orders';
import { SqliteOrderEventRepository } from '$lib/server/audit/order-events.server';
import { SqliteCheckoutDraftRepository } from './checkout-drafts.server';
import { SqliteOutboxRepository } from './outbox.server';
import { SqliteStripeEventRepository } from './stripe-events.server';
import type { ShopDatabase } from './types';

export interface OrderRepository {
	createPaidOrder(input: PaidOrderInput): Order;
	findByCheckoutSession(sessionId: string): OrderWithLines | null;
	updatePaymentStatus(paymentIntentId: string, status: PaymentStatus, now: Date): void;
}

export interface PaidOrderUnitOfWork {
	commitPaidOrder(input: PaidOrderInput, event: StripeEventInput): Order;
}

type OrderRow = {
	id: unknown;
	stripe_checkout_session_id: unknown;
	stripe_payment_intent_id: unknown;
	stripe_customer_id: unknown;
	checkout_draft_id: unknown;
	currency: unknown;
	subtotal_amount: unknown;
	discount_amount: unknown;
	shipping_amount: unknown;
	tax_amount: unknown;
	total_amount: unknown;
	destination_country: unknown;
	payment_status: unknown;
	fulfillment_status: unknown;
	styria_order_id: unknown;
	styria_status: unknown;
	tracking_number: unknown;
	submitted_at: unknown;
	shipped_at: unknown;
	updated_at: unknown;
	last_error_code: unknown;
};

type OrderLineRow = {
	order_id: unknown;
	line_index: unknown;
	stripe_product_id: unknown;
	stripe_price_id: unknown;
	product_name: unknown;
	variant_label: unknown;
	sku: unknown;
	styria_product_number: unknown;
	design_reference: unknown;
	design_json: unknown;
	quantity: unknown;
	unit_amount: unknown;
	currency: unknown;
};

type EventStateRow = {
	event_type: unknown;
	processing_status: unknown;
	stripe_checkout_session_id: unknown;
	stripe_payment_intent_id: unknown;
};

const paymentStatusRank: Record<PaymentStatus, number> = {
	paid: 0,
	partially_refunded: 1,
	refunded: 2
};

const fulfillmentStatuses = new Set([
	'pending_review',
	'submitting',
	'submitted',
	'awaiting_vendor_payment',
	'in_production',
	'shipped',
	'review_required',
	'cancelled'
]);

function fail(code: string): never {
	throw new RepositoryError(code);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || isNonEmptyString(value);
}

function isCents(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPaymentStatus(value: unknown): value is PaymentStatus {
	return value === 'paid' || value === 'partially_refunded' || value === 'refunded';
}

function isoTimestamp(value: Date, invalidCode: string): string {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(invalidCode);
	return value.toISOString();
}

function dateFromIso(value: unknown, invalidCode: string): Date {
	if (typeof value !== 'string') fail(invalidCode);
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(invalidCode);
	return parsed;
}

function nullableDateFromIso(value: unknown, invalidCode: string): Date | null {
	return value === null ? null : dateFromIso(value, invalidCode);
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

function designFromJson(value: unknown): Record<string, string> {
	if (typeof value !== 'string') fail('ORDER_LINE_ROW_INVALID');
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			fail('ORDER_LINE_ROW_INVALID');
		}
		const keys = Object.keys(parsed).sort();
		if (keys.length === 0 || keys.some((key) => key.trim().length === 0)) {
			fail('ORDER_LINE_ROW_INVALID');
		}
		const canonical: Record<string, string> = {};
		for (const key of keys) {
			const entry = (parsed as Record<string, unknown>)[key];
			if (!isNonEmptyString(entry) || !isHttpsUrl(entry)) fail('ORDER_LINE_ROW_INVALID');
			canonical[key] = entry;
		}
		if (JSON.stringify(canonical) !== value) fail('ORDER_LINE_ROW_INVALID');
		return canonical;
	} catch (error) {
		if (error instanceof RepositoryError) throw error;
		fail('ORDER_LINE_ROW_INVALID');
	}
}

function validateAmounts(input: PaidOrderInput): void {
	const { subtotal, discount, shipping, tax, total } = input.amounts;
	if (
		!isCents(subtotal) ||
		!isCents(discount) ||
		!isCents(shipping) ||
		!isCents(tax) ||
		!isCents(total) ||
		discount > subtotal
	) {
		fail('PAID_ORDER_INVALID');
	}

	if (!hasValidInclusiveShippingAmounts({ subtotal, discount, shipping, tax, total })) {
		fail('PAID_ORDER_INVALID');
	}
}

function hasValidInclusiveShippingAmounts(amounts: {
	subtotal: number;
	discount: number;
	shipping: number;
	tax: number;
	total: number;
}): boolean {
	const netSubtotal = BigInt(amounts.subtotal) - BigInt(amounts.discount);
	const beforeMerchandiseTax = netSubtotal + BigInt(amounts.shipping);
	const merchandiseTax = BigInt(amounts.total) - beforeMerchandiseTax;
	const inclusiveShippingTax = BigInt(amounts.tax) - merchandiseTax;
	return (
		merchandiseTax >= 0n &&
		inclusiveShippingTax >= 0n &&
		inclusiveShippingTax <= BigInt(amounts.shipping)
	);
}

function validatePaidOrder(input: PaidOrderInput): string {
	if (
		!input ||
		!isNonEmptyString(input.checkoutSessionId) ||
		!isNonEmptyString(input.paymentIntentId) ||
		!isNonEmptyString(input.customerId) ||
		!isNonEmptyString(input.checkoutDraftId) ||
		input.currency !== 'eur' ||
		!input.amounts ||
		!isMarketDestination(input.destinationCountry)
	) {
		fail('PAID_ORDER_INVALID');
	}
	validateAmounts(input);
	return isoTimestamp(input.updatedAt, 'PAID_ORDER_INVALID');
}

function mapOrder(row: OrderRow): Order {
	if (
		!isNonEmptyString(row.id) ||
		!isNonEmptyString(row.stripe_checkout_session_id) ||
		!isNonEmptyString(row.stripe_payment_intent_id) ||
		!isNonEmptyString(row.stripe_customer_id) ||
		!isNonEmptyString(row.checkout_draft_id) ||
		row.currency !== 'eur' ||
		!isCents(row.subtotal_amount) ||
		!isCents(row.discount_amount) ||
		!isCents(row.shipping_amount) ||
		!isCents(row.tax_amount) ||
		!isCents(row.total_amount) ||
		!isNonEmptyString(row.destination_country) ||
		!isMarketDestination(row.destination_country) ||
		!isPaymentStatus(row.payment_status) ||
		!isNonEmptyString(row.fulfillment_status) ||
		!fulfillmentStatuses.has(row.fulfillment_status) ||
		!isNullableString(row.styria_order_id) ||
		!isNullableString(row.styria_status) ||
		!isNullableString(row.tracking_number) ||
		(row.last_error_code !== null && !isStableErrorCode(row.last_error_code))
	) {
		fail('ORDER_ROW_INVALID');
	}

	const amounts = {
		subtotal: row.subtotal_amount,
		discount: row.discount_amount,
		shipping: row.shipping_amount,
		tax: row.tax_amount,
		total: row.total_amount
	};
	if (amounts.discount > amounts.subtotal || !hasValidInclusiveShippingAmounts(amounts)) {
		fail('ORDER_ROW_INVALID');
	}

	return {
		id: row.id,
		checkoutSessionId: row.stripe_checkout_session_id,
		paymentIntentId: row.stripe_payment_intent_id,
		customerId: row.stripe_customer_id,
		checkoutDraftId: row.checkout_draft_id,
		currency: 'eur',
		amounts,
		destinationCountry: row.destination_country,
		paymentStatus: row.payment_status,
		fulfillmentStatus: row.fulfillment_status as Order['fulfillmentStatus'],
		styriaOrderId: row.styria_order_id,
		styriaStatus: row.styria_status,
		trackingNumber: row.tracking_number,
		submittedAt: nullableDateFromIso(row.submitted_at, 'ORDER_ROW_INVALID'),
		shippedAt: nullableDateFromIso(row.shipped_at, 'ORDER_ROW_INVALID'),
		updatedAt: dateFromIso(row.updated_at, 'ORDER_ROW_INVALID'),
		lastErrorCode: row.last_error_code
	};
}

function mapOrderLine(
	row: OrderLineRow,
	expectedOrderId: string,
	expectedIndex: number
): OrderLine {
	if (
		row.order_id !== expectedOrderId ||
		row.line_index !== expectedIndex ||
		!isNonEmptyString(row.stripe_product_id) ||
		!isNonEmptyString(row.stripe_price_id) ||
		!isNonEmptyString(row.product_name) ||
		!isNonEmptyString(row.variant_label) ||
		!isNonEmptyString(row.sku) ||
		!isNonEmptyString(row.styria_product_number) ||
		!isNonEmptyString(row.design_reference) ||
		!Number.isSafeInteger(row.quantity) ||
		(row.quantity as number) < 1 ||
		(row.quantity as number) > 20 ||
		!isCents(row.unit_amount) ||
		row.currency !== 'eur'
	) {
		fail('ORDER_LINE_ROW_INVALID');
	}

	return {
		orderId: expectedOrderId,
		lineIndex: expectedIndex,
		stripeProductId: row.stripe_product_id,
		stripePriceId: row.stripe_price_id,
		productName: row.product_name,
		variantLabel: row.variant_label,
		sku: row.sku,
		styriaProductNumber: row.styria_product_number,
		designReference: row.design_reference,
		designPlacements: designFromJson(row.design_json),
		quantity: row.quantity as number,
		unitAmount: row.unit_amount,
		currency: 'eur'
	};
}

function commercialDataMatches(order: Order, input: PaidOrderInput): boolean {
	return (
		order.customerId === input.customerId &&
		order.currency === input.currency &&
		order.destinationCountry === input.destinationCountry &&
		order.amounts.subtotal === input.amounts.subtotal &&
		order.amounts.discount === input.amounts.discount &&
		order.amounts.shipping === input.amounts.shipping &&
		order.amounts.tax === input.amounts.tax &&
		order.amounts.total === input.amounts.total
	);
}

function providerIdentityMatches(order: Order, input: PaidOrderInput): boolean {
	return (
		order.checkoutSessionId === input.checkoutSessionId &&
		order.paymentIntentId === input.paymentIntentId &&
		order.checkoutDraftId === input.checkoutDraftId
	);
}

function lineMatchesDraft(orderLine: OrderLine, draftLine: CheckoutDraftLine): boolean {
	return (
		orderLine.lineIndex === draftLine.lineIndex &&
		orderLine.stripeProductId === draftLine.stripeProductId &&
		orderLine.stripePriceId === draftLine.stripePriceId &&
		orderLine.productName === draftLine.productName &&
		orderLine.variantLabel === draftLine.variantLabel &&
		orderLine.sku === draftLine.sku &&
		orderLine.styriaProductNumber === draftLine.styriaProductNumber &&
		orderLine.designReference === draftLine.designReference &&
		JSON.stringify(orderLine.designPlacements) === JSON.stringify(draftLine.designPlacements) &&
		orderLine.quantity === draftLine.quantity &&
		orderLine.unitAmount === draftLine.unitAmount &&
		orderLine.currency === draftLine.currency
	);
}

export class SqliteOrderRepository implements OrderRepository {
	constructor(private readonly database: ShopDatabase) {}

	createPaidOrder(input: PaidOrderInput): Order {
		const updatedAt = validatePaidOrder(input);
		const findDraft = this.database.prepare(
			'SELECT stripe_checkout_session_id, created_at FROM checkout_drafts WHERE id = ?'
		);
		const findConflicts = this.database.prepare(`
			SELECT * FROM orders
			WHERE stripe_checkout_session_id = ?
				OR stripe_payment_intent_id = ?
				OR checkout_draft_id = ?
		`);
		const insert = this.database.prepare(`
			INSERT INTO orders (
				id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
				checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
				tax_amount, total_amount, destination_country, payment_status, fulfillment_status,
				styria_order_id, styria_status, tracking_number, submitted_at, shipped_at,
				updated_at, last_error_code
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'pending_review',
				NULL, NULL, NULL, NULL, NULL, ?, NULL)
		`);
		const create = this.database.transaction((): Order => {
			const draft = findDraft.get(input.checkoutDraftId) as
				{ stripe_checkout_session_id: unknown; created_at: unknown } | undefined;
			if (!draft) fail('ORDER_DRAFT_NOT_FOUND');
			if (draft.stripe_checkout_session_id !== input.checkoutSessionId) {
				fail('ORDER_DRAFT_CORRELATION_FAILED');
			}
			if (input.updatedAt < dateFromIso(draft.created_at, 'CHECKOUT_DRAFT_ROW_INVALID')) {
				fail('ORDER_TIMESTAMP_REGRESSION');
			}

			const conflicts = findConflicts.all(
				input.checkoutSessionId,
				input.paymentIntentId,
				input.checkoutDraftId
			) as OrderRow[];
			if (conflicts.length > 1) fail('ORDER_PROVIDER_CONFLICT');
			if (conflicts.length === 1) {
				const existing = mapOrder(conflicts[0]);
				if (!providerIdentityMatches(existing, input)) fail('ORDER_PROVIDER_CONFLICT');
				if (!commercialDataMatches(existing, input)) fail('ORDER_DATA_CONFLICT');
				return existing;
			}

			const id = randomUUID();
			insert.run(
				id,
				input.checkoutSessionId,
				input.paymentIntentId,
				input.customerId,
				input.checkoutDraftId,
				input.currency,
				input.amounts.subtotal,
				input.amounts.discount,
				input.amounts.shipping,
				input.amounts.tax,
				input.amounts.total,
				input.destinationCountry,
				updatedAt
			);
			const row = this.database.prepare('SELECT * FROM orders WHERE id = ?').get(id) as
				OrderRow | undefined;
			if (!row) fail('ORDER_CREATE_FAILED');
			return mapOrder(row);
		});

		try {
			return create.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('ORDER_CREATE_FAILED');
		}
	}

	findByCheckoutSession(sessionId: string): OrderWithLines | null {
		if (!isNonEmptyString(sessionId)) fail('ORDER_SESSION_ID_INVALID');
		const row = this.database
			.prepare('SELECT * FROM orders WHERE stripe_checkout_session_id = ?')
			.get(sessionId) as OrderRow | undefined;
		if (!row) return null;
		const order = mapOrder(row);
		const lineRows = this.database
			.prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_index')
			.all(order.id) as OrderLineRow[];
		return {
			...order,
			lines: lineRows.map((line, index) => mapOrderLine(line, order.id, index))
		};
	}

	findById(orderId: string): OrderWithLines | null {
		if (!isNonEmptyString(orderId)) fail('ORDER_ID_INVALID');
		const row = this.database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
			OrderRow | undefined;
		if (!row) return null;
		const order = mapOrder(row);
		const lineRows = this.database
			.prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_index')
			.all(order.id) as OrderLineRow[];
		return {
			...order,
			lines: lineRows.map((line, index) => mapOrderLine(line, order.id, index))
		};
	}

	listByFulfillmentStatuses(statuses: readonly FulfillmentStatus[], limit: number): Order[] {
		if (
			!Array.isArray(statuses) ||
			statuses.length === 0 ||
			statuses.some((status) => !fulfillmentStatuses.has(status)) ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 100
		) {
			fail('ORDER_LIST_INVALID');
		}
		const placeholders = statuses.map(() => '?').join(', ');
		const rows = this.database
			.prepare(
				`SELECT * FROM orders
				WHERE fulfillment_status IN (${placeholders})
				ORDER BY updated_at, id
				LIMIT ?`
			)
			.all(...statuses, limit) as OrderRow[];
		return rows.map(mapOrder);
	}

	updatePaymentStatus(paymentIntentId: string, status: PaymentStatus, now: Date): void {
		if (!isNonEmptyString(paymentIntentId) || !isPaymentStatus(status)) {
			fail('PAYMENT_STATUS_UPDATE_INVALID');
		}
		const timestamp = isoTimestamp(now, 'PAYMENT_STATUS_UPDATE_INVALID');
		const find = this.database.prepare(`
			SELECT payment_status, updated_at FROM orders WHERE stripe_payment_intent_id = ?
		`);
		const update = this.database.prepare(`
			UPDATE orders SET payment_status = ?, updated_at = ?
			WHERE stripe_payment_intent_id = ? AND payment_status = ?
		`);
		const advance = this.database.transaction(() => {
			const row = find.get(paymentIntentId) as
				{ payment_status: unknown; updated_at: unknown } | undefined;
			if (!row) fail('ORDER_NOT_FOUND');
			if (!isPaymentStatus(row.payment_status)) fail('ORDER_ROW_INVALID');
			if (row.payment_status === status) return;
			if (paymentStatusRank[status] < paymentStatusRank[row.payment_status]) {
				fail('PAYMENT_STATUS_REGRESSION');
			}
			const previousTimestamp = dateFromIso(row.updated_at, 'ORDER_ROW_INVALID').toISOString();
			if (timestamp < previousTimestamp) fail('ORDER_TIMESTAMP_REGRESSION');
			if (update.run(status, timestamp, paymentIntentId, row.payment_status).changes !== 1) {
				fail('PAYMENT_STATUS_CONFLICT');
			}
		});

		try {
			advance.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('PAYMENT_STATUS_UPDATE_FAILED');
		}
	}
}

export class SqlitePaidOrderUnitOfWork implements PaidOrderUnitOfWork {
	private readonly drafts: SqliteCheckoutDraftRepository;
	private readonly orders: SqliteOrderRepository;
	private readonly events: SqliteStripeEventRepository;
	private readonly outbox: SqliteOutboxRepository;
	private readonly audit: SqliteOrderEventRepository;

	constructor(private readonly database: ShopDatabase) {
		this.drafts = new SqliteCheckoutDraftRepository(database);
		this.orders = new SqliteOrderRepository(database);
		this.events = new SqliteStripeEventRepository(database);
		this.outbox = new SqliteOutboxRepository(database);
		this.audit = new SqliteOrderEventRepository(database);
	}

	commitPaidOrder(input: PaidOrderInput, event: StripeEventInput): Order {
		validatePaidOrder(input);
		if (!event || !isNonEmptyString(event.eventId) || !isNonEmptyString(event.eventType)) {
			fail('STRIPE_EVENT_INVALID');
		}
		isoTimestamp(event.processedAt, 'STRIPE_EVENT_INVALID');

		const findEvent = this.database.prepare(`
			SELECT event_type, processing_status, stripe_checkout_session_id,
				stripe_payment_intent_id
			FROM stripe_events WHERE stripe_event_id = ?
		`);
		const findOrderLines = this.database.prepare(
			'SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_index'
		);
		const copyDraftLines = this.database.prepare(`
			INSERT INTO order_lines (
				order_id, line_index, stripe_product_id, stripe_price_id, product_name,
				variant_label, sku, styria_product_number, design_reference, design_json,
				quantity, unit_amount, currency
			)
			SELECT ?, line_index, stripe_product_id, stripe_price_id, product_name,
				variant_label, sku, styria_product_number, design_reference, design_json,
				quantity, unit_amount, currency
			FROM checkout_draft_lines WHERE draft_id = ? ORDER BY line_index
		`);
		const findAlert = this.database.prepare(`
			SELECT kind, order_id FROM outbox_jobs WHERE idempotency_key = ?
		`);

		const commit = this.database.transaction((): Order => {
			const eventState = findEvent.get(event.eventId) as EventStateRow | undefined;
			if (!eventState) fail('STRIPE_EVENT_NOT_FOUND');
			if (eventState.event_type !== event.eventType) fail('STRIPE_EVENT_TYPE_CONFLICT');
			if (eventState.processing_status === 'completed') {
				if (
					eventState.stripe_checkout_session_id !== input.checkoutSessionId ||
					eventState.stripe_payment_intent_id !== input.paymentIntentId
				) {
					fail('STRIPE_EVENT_REFERENCE_CONFLICT');
				}
				const existing = this.orders.findByCheckoutSession(input.checkoutSessionId);
				if (!existing) fail('ORDER_NOT_FOUND');
				return this.orders.createPaidOrder(input);
			}
			if (eventState.processing_status !== 'processing') fail('STRIPE_EVENT_STATE_CONFLICT');

			const draft = this.drafts.findById(input.checkoutDraftId);
			if (!draft) fail('ORDER_DRAFT_NOT_FOUND');
			if (draft.checkoutSessionId !== input.checkoutSessionId) {
				fail('ORDER_DRAFT_CORRELATION_FAILED');
			}
			const existingBeforeCommit = this.orders.findByCheckoutSession(input.checkoutSessionId);
			const order = this.orders.createPaidOrder(input);
			const lineRows = findOrderLines.all(order.id) as OrderLineRow[];
			if (lineRows.length === 0) {
				if (copyDraftLines.run(order.id, draft.id).changes !== draft.lines.length) {
					fail('ORDER_LINE_COPY_FAILED');
				}
			} else {
				const orderLines = lineRows.map((line, index) => mapOrderLine(line, order.id, index));
				if (
					orderLines.length !== draft.lines.length ||
					!orderLines.every((line, index) => lineMatchesDraft(line, draft.lines[index]))
				) {
					fail('ORDER_LINE_CONFLICT');
				}
			}

			if (draft.completedAt === null) this.drafts.markCompleted(draft.id, event.processedAt);
			this.audit.append({
				orderId: order.id,
				actor: 'stripe-webhook',
				action: existingBeforeCommit ? 'paid_order_converged' : 'paid_order_recorded',
				priorState: existingBeforeCommit?.fulfillmentStatus ?? null,
				nextState: order.fulfillmentStatus,
				result: 'succeeded',
				errorCode: null,
				createdAt: event.processedAt
			});

			const idempotencyKey = `paid-order-alert:${order.id}`;
			const alert = findAlert.get(idempotencyKey) as
				{ kind: unknown; order_id: unknown } | undefined;
			if (!alert) {
				this.outbox.enqueue({
					kind: 'paid-order-alert',
					idempotencyKey,
					orderId: order.id,
					nextAttemptAt: event.processedAt
				});
			} else if (alert.kind !== 'paid-order-alert' || alert.order_id !== order.id) {
				fail('OUTBOX_IDEMPOTENCY_CONFLICT');
			}

			this.events.complete(
				event.eventId,
				{
					checkoutSessionId: input.checkoutSessionId,
					paymentIntentId: input.paymentIntentId
				},
				event.processedAt
			);
			return order;
		});

		try {
			return commit.immediate();
		} catch (error) {
			if (
				error instanceof RepositoryError &&
				error.code !== 'OUTBOX_ENQUEUE_FAILED' &&
				error.code !== 'ORDER_EVENT_APPEND_FAILED' &&
				error.code !== 'STRIPE_EVENT_COMPLETE_FAILED' &&
				error.code !== 'ORDER_CREATE_FAILED'
			) {
				throw error;
			}
			fail('PAID_ORDER_COMMIT_FAILED');
		}
	}
}
