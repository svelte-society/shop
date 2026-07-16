import type { NewOrderEvent, OrderEvent } from '$lib/domain/orders';
import { isStableErrorCode, RepositoryError } from '$lib/domain/orders';
import type { ShopDatabase } from '$lib/server/db/types';

export interface OrderEventRepository {
	append(input: NewOrderEvent): void;
}

function fail(code: string): never {
	throw new RepositoryError(code);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isoTimestamp(value: Date): string {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('ORDER_EVENT_INVALID');
	return value.toISOString();
}

function dateFromIso(value: unknown): Date {
	if (typeof value !== 'string') fail('ORDER_EVENT_ROW_INVALID');
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
		fail('ORDER_EVENT_ROW_INVALID');
	}
	return parsed;
}

type OrderEventRow = {
	id: unknown;
	order_id: unknown;
	actor: unknown;
	action: unknown;
	prior_state: unknown;
	next_state: unknown;
	result: unknown;
	error_code: unknown;
	created_at: unknown;
};

function mapEvent(row: OrderEventRow, orderId: string): OrderEvent {
	if (
		!Number.isSafeInteger(row.id) ||
		(row.id as number) < 1 ||
		row.order_id !== orderId ||
		!isNonEmptyString(row.actor) ||
		!isNonEmptyString(row.action) ||
		(row.prior_state !== null && !isNonEmptyString(row.prior_state)) ||
		(row.next_state !== null && !isNonEmptyString(row.next_state)) ||
		!isNonEmptyString(row.result) ||
		(row.error_code !== null && !isStableErrorCode(row.error_code))
	) {
		fail('ORDER_EVENT_ROW_INVALID');
	}
	return {
		id: row.id as number,
		orderId,
		actor: row.actor,
		action: row.action,
		priorState: row.prior_state as string | null,
		nextState: row.next_state as string | null,
		result: row.result,
		errorCode: row.error_code as string | null,
		createdAt: dateFromIso(row.created_at)
	};
}

export class SqliteOrderEventRepository implements OrderEventRepository {
	constructor(private readonly database: ShopDatabase) {}

	append(input: NewOrderEvent): void {
		if (
			!input ||
			!isNonEmptyString(input.orderId) ||
			!isNonEmptyString(input.actor) ||
			!isNonEmptyString(input.action) ||
			(input.priorState !== null && !isNonEmptyString(input.priorState)) ||
			(input.nextState !== null && !isNonEmptyString(input.nextState)) ||
			!isNonEmptyString(input.result) ||
			(input.errorCode !== null && !isStableErrorCode(input.errorCode))
		) {
			fail('ORDER_EVENT_INVALID');
		}

		const createdAt = isoTimestamp(input.createdAt);
		try {
			this.database
				.prepare(
					`
					INSERT INTO order_events (
						order_id, actor, action, prior_state, next_state,
						result, error_code, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`
				)
				.run(
					input.orderId,
					input.actor,
					input.action,
					input.priorState,
					input.nextState,
					input.result,
					input.errorCode,
					createdAt
				);
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('ORDER_EVENT_APPEND_FAILED');
		}
	}

	listByOrderId(orderId: string): OrderEvent[] {
		if (!isNonEmptyString(orderId)) fail('ORDER_EVENT_ORDER_ID_INVALID');
		const rows = this.database
			.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id')
			.all(orderId) as OrderEventRow[];
		return rows.map((row) => mapEvent(row, orderId));
	}
}
