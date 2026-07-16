import { assertTransition, mapStyriaStatus } from '$lib/domain/fulfillment';
import type {
	FulfillmentStatus,
	Order,
	OrderEvent,
	OrderWithLines,
	PaymentStatus
} from '$lib/domain/orders';
import { isStableErrorCode, RepositoryError } from '$lib/domain/orders';
import { SqliteOrderEventRepository } from '$lib/server/audit/order-events.server';
import { SqliteOrderRepository } from '$lib/server/db/orders.server';
import type { ShopDatabase } from '$lib/server/db/types';

const ACTOR = 'codex-admin';
const REVIEW_ERROR_CODE = 'STYRIA_STATUS_REVIEW_REQUIRED';

const fulfillmentStatuses = new Set<FulfillmentStatus>([
	'pending_review',
	'submitting',
	'submitted',
	'awaiting_vendor_payment',
	'in_production',
	'shipped',
	'review_required',
	'cancelled'
]);

export type OrderSummary = {
	id: string;
	checkoutSessionId: string;
	paymentStatus: PaymentStatus;
	fulfillmentStatus: FulfillmentStatus;
	currency: 'eur';
	totalAmount: number;
	destinationCountry: string;
	styriaOrderId: string | null;
	styriaStatus: string | null;
	trackingNumber: string | null;
	updatedAt: Date;
	lastErrorCode: string | null;
};

export type SupportOutcome =
	| 'return_approved'
	| 'return_received'
	| 'replacement_ordered'
	| 'replacement_shipped'
	| 'refund_processed'
	| 'request_declined'
	| 'other_reviewed';

export type NewSupportNote = {
	orderId: string;
	outcome: SupportOutcome;
	externalReference: string | null;
	createdAt: Date;
};

export type SupportNote = NewSupportNote & {
	id: number;
	actor: typeof ACTOR;
};

export type OrderWithLinesAndEvents = OrderWithLines & {
	events: OrderEvent[];
	supportNotes: SupportNote[];
};

export type StyriaStatusUpdate = {
	status: string;
	deleted: boolean;
	trackingNumber: string | null;
};

export interface FulfillmentRepository {
	listPending(limit: number): OrderSummary[];
	inspect(orderId: string): OrderWithLinesAndEvents | null;
	beginSubmission(orderId: string, approvalId: string, payloadHash: string, now: Date): void;
	recordSubmitted(orderId: string, styriaOrderId: string, styriaStatus: string, now: Date): void;
	requireReview(orderId: string, errorCode: string, now: Date): void;
	applyStyriaStatus(orderId: string, update: StyriaStatusUpdate, now: Date): void;
	recordSupportNote(input: NewSupportNote): void;
}

type ApprovalRow = {
	id: unknown;
	order_id: unknown;
	payload_hash: unknown;
	actor: unknown;
	expires_at: unknown;
	used_at: unknown;
};

type SupportNoteRow = {
	id: unknown;
	order_id: unknown;
	outcome: unknown;
	external_reference: unknown;
	actor: unknown;
	created_at: unknown;
};

const supportOutcomes = new Set<SupportOutcome>([
	'return_approved',
	'return_received',
	'replacement_ordered',
	'replacement_shipped',
	'refund_processed',
	'request_declined',
	'other_reviewed'
]);

function fail(code: string): never {
	throw new RepositoryError(code);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isExactString(value: unknown, maxLength: number): value is string {
	return (
		isNonEmptyString(value) &&
		value === value.trim() &&
		value.length <= maxLength &&
		!/[\r\n]/.test(value)
	);
}

function isFulfillmentStatus(value: unknown): value is FulfillmentStatus {
	return typeof value === 'string' && fulfillmentStatuses.has(value as FulfillmentStatus);
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

function requireCurrentTimestamp(order: Order, timestamp: string): void {
	if (timestamp < order.updatedAt.toISOString()) fail('ORDER_TIMESTAMP_REGRESSION');
}

function toSummary(order: Order): OrderSummary {
	return {
		id: order.id,
		checkoutSessionId: order.checkoutSessionId,
		paymentStatus: order.paymentStatus,
		fulfillmentStatus: order.fulfillmentStatus,
		currency: order.currency,
		totalAmount: order.amounts.total,
		destinationCountry: order.destinationCountry,
		styriaOrderId: order.styriaOrderId,
		styriaStatus: order.styriaStatus,
		trackingNumber: order.trackingNumber,
		updatedAt: new Date(order.updatedAt),
		lastErrorCode: order.lastErrorCode
	};
}

function mapSupportNote(row: SupportNoteRow, orderId: string): SupportNote {
	if (
		!Number.isSafeInteger(row.id) ||
		(row.id as number) < 1 ||
		row.order_id !== orderId ||
		!supportOutcomes.has(row.outcome as SupportOutcome) ||
		(row.external_reference !== null && !isExactString(row.external_reference, 120)) ||
		row.actor !== ACTOR
	) {
		fail('SUPPORT_NOTE_ROW_INVALID');
	}
	return {
		id: row.id as number,
		orderId,
		outcome: row.outcome as SupportOutcome,
		externalReference: row.external_reference as string | null,
		actor: ACTOR,
		createdAt: dateFromIso(row.created_at, 'SUPPORT_NOTE_ROW_INVALID')
	};
}

export class SqliteFulfillmentRepository implements FulfillmentRepository {
	private readonly orders: SqliteOrderRepository;
	private readonly audit: SqliteOrderEventRepository;

	constructor(private readonly database: ShopDatabase) {
		this.orders = new SqliteOrderRepository(database);
		this.audit = new SqliteOrderEventRepository(database);
	}

	listPending(limit: number): OrderSummary[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			fail('FULFILLMENT_LIST_LIMIT_INVALID');
		}
		return this.orders
			.listByFulfillmentStatuses(['pending_review', 'review_required'], limit)
			.map(toSummary);
	}

	inspect(orderId: string): OrderWithLinesAndEvents | null {
		if (!isExactString(orderId, 200)) fail('FULFILLMENT_ORDER_ID_INVALID');
		const order = this.orders.findById(orderId);
		if (!order) return null;
		const noteRows = this.database
			.prepare('SELECT * FROM support_notes WHERE order_id = ? ORDER BY id')
			.all(orderId) as SupportNoteRow[];
		return {
			...order,
			events: this.audit.listByOrderId(orderId),
			supportNotes: noteRows.map((row) => mapSupportNote(row, orderId))
		};
	}

	beginSubmission(orderId: string, approvalId: string, payloadHash: string, now: Date): void {
		if (
			!isExactString(orderId, 200) ||
			!isExactString(approvalId, 200) ||
			!isExactString(payloadHash, 256)
		) {
			fail('SUBMISSION_APPROVAL_INVALID');
		}
		const timestamp = isoTimestamp(now, 'SUBMISSION_APPROVAL_INVALID');
		const findApproval = this.database.prepare('SELECT * FROM submission_approvals WHERE id = ?');
		const consumeApproval = this.database.prepare(`
			UPDATE submission_approvals SET used_at = ?
			WHERE id = ? AND used_at IS NULL
		`);
		const updateOrder = this.database.prepare(`
			UPDATE orders
			SET fulfillment_status = 'submitting', updated_at = ?, last_error_code = NULL
			WHERE id = ? AND fulfillment_status = ? AND updated_at = ?
		`);
		const begin = this.database.transaction(() => {
			const approval = findApproval.get(approvalId) as ApprovalRow | undefined;
			if (!approval) fail('SUBMISSION_APPROVAL_NOT_FOUND');
			if (
				!isNonEmptyString(approval.id) ||
				!isNonEmptyString(approval.order_id) ||
				!isNonEmptyString(approval.payload_hash)
			) {
				fail('SUBMISSION_APPROVAL_ROW_INVALID');
			}
			if (approval.used_at !== null) {
				dateFromIso(approval.used_at, 'SUBMISSION_APPROVAL_ROW_INVALID');
				fail('SUBMISSION_APPROVAL_USED');
			}
			if (approval.actor !== ACTOR) fail('SUBMISSION_APPROVAL_ACTOR_INVALID');
			if (approval.order_id !== orderId) fail('SUBMISSION_APPROVAL_ORDER_MISMATCH');
			if (approval.payload_hash !== payloadHash) fail('SUBMISSION_APPROVAL_HASH_MISMATCH');
			if (
				dateFromIso(approval.expires_at, 'SUBMISSION_APPROVAL_ROW_INVALID').getTime() <=
				now.getTime()
			) {
				fail('SUBMISSION_APPROVAL_EXPIRED');
			}

			const order = this.orders.findById(orderId);
			if (!order) fail('ORDER_NOT_FOUND');
			assertTransition(order.fulfillmentStatus, 'submitting');
			requireCurrentTimestamp(order, timestamp);
			if (consumeApproval.run(timestamp, approvalId).changes !== 1) {
				fail('SUBMISSION_APPROVAL_USED');
			}
			if (
				updateOrder.run(timestamp, orderId, order.fulfillmentStatus, order.updatedAt.toISOString())
					.changes !== 1
			) {
				fail('FULFILLMENT_STATE_CONFLICT');
			}
			this.audit.append({
				orderId,
				actor: ACTOR,
				action: 'fulfillment_submission_started',
				priorState: order.fulfillmentStatus,
				nextState: 'submitting',
				result: 'succeeded',
				errorCode: null,
				createdAt: now
			});
		});

		try {
			begin.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('FULFILLMENT_BEGIN_FAILED');
		}
	}

	recordSubmitted(orderId: string, styriaOrderId: string, styriaStatus: string, now: Date): void {
		if (
			!isExactString(orderId, 200) ||
			!isExactString(styriaOrderId, 200) ||
			!isExactString(styriaStatus, 200)
		) {
			fail('STYRIA_SUBMISSION_INVALID');
		}
		const timestamp = isoTimestamp(now, 'STYRIA_SUBMISSION_INVALID');
		const update = this.database.prepare(`
			UPDATE orders SET
				fulfillment_status = 'awaiting_vendor_payment',
				styria_order_id = ?,
				styria_status = ?,
				submitted_at = COALESCE(submitted_at, ?),
				updated_at = ?,
				last_error_code = NULL
			WHERE id = ? AND fulfillment_status = ? AND updated_at = ?
		`);
		const record = this.database.transaction(() => {
			const order = this.orders.findById(orderId);
			if (!order) fail('ORDER_NOT_FOUND');
			assertTransition(order.fulfillmentStatus, 'awaiting_vendor_payment');
			requireCurrentTimestamp(order, timestamp);
			if (order.styriaOrderId !== null && order.styriaOrderId !== styriaOrderId) {
				fail('STYRIA_ORDER_ID_CONFLICT');
			}
			if (
				update.run(
					styriaOrderId,
					styriaStatus,
					timestamp,
					timestamp,
					orderId,
					order.fulfillmentStatus,
					order.updatedAt.toISOString()
				).changes !== 1
			) {
				fail('FULFILLMENT_STATE_CONFLICT');
			}
			this.audit.append({
				orderId,
				actor: ACTOR,
				action: 'styria_submission_recorded',
				priorState: order.fulfillmentStatus,
				nextState: 'awaiting_vendor_payment',
				result: 'succeeded',
				errorCode: null,
				createdAt: now
			});
		});

		try {
			record.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('STYRIA_SUBMISSION_RECORD_FAILED');
		}
	}

	requireReview(orderId: string, errorCode: string, now: Date): void {
		if (!isExactString(orderId, 200) || !isStableErrorCode(errorCode)) {
			fail('FULFILLMENT_REVIEW_INVALID');
		}
		const timestamp = isoTimestamp(now, 'FULFILLMENT_REVIEW_INVALID');
		const update = this.database.prepare(`
			UPDATE orders SET
				fulfillment_status = 'review_required', updated_at = ?, last_error_code = ?
			WHERE id = ? AND fulfillment_status = ? AND updated_at = ?
		`);
		const requireReview = this.database.transaction(() => {
			const order = this.orders.findById(orderId);
			if (!order) fail('ORDER_NOT_FOUND');
			if (order.fulfillmentStatus !== 'review_required') {
				assertTransition(order.fulfillmentStatus, 'review_required');
			}
			requireCurrentTimestamp(order, timestamp);
			if (
				update.run(
					timestamp,
					errorCode,
					orderId,
					order.fulfillmentStatus,
					order.updatedAt.toISOString()
				).changes !== 1
			) {
				fail('FULFILLMENT_STATE_CONFLICT');
			}
			this.audit.append({
				orderId,
				actor: ACTOR,
				action: 'fulfillment_review_required',
				priorState: order.fulfillmentStatus,
				nextState: 'review_required',
				result: 'failed',
				errorCode,
				createdAt: now
			});
		});

		try {
			requireReview.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('FULFILLMENT_REVIEW_FAILED');
		}
	}

	applyStyriaStatus(orderId: string, update: StyriaStatusUpdate, now: Date): void {
		if (
			!isExactString(orderId, 200) ||
			!update ||
			!isExactString(update.status, 200) ||
			typeof update.deleted !== 'boolean' ||
			(update.trackingNumber !== null && !isExactString(update.trackingNumber, 200))
		) {
			fail('STYRIA_STATUS_UPDATE_INVALID');
		}
		const timestamp = isoTimestamp(now, 'STYRIA_STATUS_UPDATE_INVALID');
		const updateOrder = this.database.prepare(`
			UPDATE orders SET
				fulfillment_status = ?,
				styria_status = ?,
				tracking_number = ?,
				shipped_at = ?,
				updated_at = ?,
				last_error_code = ?
			WHERE id = ? AND fulfillment_status = ? AND updated_at = ?
		`);
		const apply = this.database.transaction(() => {
			const order = this.orders.findById(orderId);
			if (!order) fail('ORDER_NOT_FOUND');
			if (order.styriaOrderId === null) fail('STYRIA_ORDER_NOT_RECORDED');
			requireCurrentTimestamp(order, timestamp);
			if (
				order.trackingNumber !== null &&
				update.trackingNumber !== null &&
				order.trackingNumber !== update.trackingNumber
			) {
				fail('STYRIA_TRACKING_CONFLICT');
			}
			const trackingNumber = update.trackingNumber ?? order.trackingNumber;
			const next = mapStyriaStatus({ ...update, trackingNumber });
			if (!isFulfillmentStatus(next)) fail('STYRIA_STATUS_UPDATE_INVALID');
			if (order.fulfillmentStatus !== next) assertTransition(order.fulfillmentStatus, next);
			const errorCode = next === 'review_required' ? REVIEW_ERROR_CODE : null;
			const shippedAt = order.shippedAt?.toISOString() ?? (next === 'shipped' ? timestamp : null);
			if (
				updateOrder.run(
					next,
					update.status,
					trackingNumber,
					shippedAt,
					timestamp,
					errorCode,
					orderId,
					order.fulfillmentStatus,
					order.updatedAt.toISOString()
				).changes !== 1
			) {
				fail('FULFILLMENT_STATE_CONFLICT');
			}
			this.audit.append({
				orderId,
				actor: ACTOR,
				action: 'styria_status_updated',
				priorState: order.fulfillmentStatus,
				nextState: next,
				result: errorCode === null ? 'succeeded' : 'failed',
				errorCode,
				createdAt: now
			});
		});

		try {
			apply.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('STYRIA_STATUS_UPDATE_FAILED');
		}
	}

	recordSupportNote(input: NewSupportNote): void {
		if (
			!input ||
			!isExactString(input.orderId, 200) ||
			!supportOutcomes.has(input.outcome) ||
			(input.externalReference !== null && !isExactString(input.externalReference, 120))
		) {
			fail('SUPPORT_NOTE_INVALID');
		}
		const timestamp = isoTimestamp(input.createdAt, 'SUPPORT_NOTE_INVALID');
		const insert = this.database.prepare(`
			INSERT INTO support_notes (order_id, outcome, external_reference, actor, created_at)
			VALUES (?, ?, ?, '${ACTOR}', ?)
		`);
		const record = this.database.transaction(() => {
			const order = this.orders.findById(input.orderId);
			if (!order) fail('ORDER_NOT_FOUND');
			if (timestamp < order.updatedAt.toISOString()) fail('ORDER_TIMESTAMP_REGRESSION');
			insert.run(input.orderId, input.outcome, input.externalReference, timestamp);
			this.audit.append({
				orderId: input.orderId,
				actor: ACTOR,
				action: 'support_note_recorded',
				priorState: order.fulfillmentStatus,
				nextState: order.fulfillmentStatus,
				result: 'succeeded',
				errorCode: null,
				createdAt: input.createdAt
			});
		});

		try {
			record.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('SUPPORT_NOTE_RECORD_FAILED');
		}
	}
}
