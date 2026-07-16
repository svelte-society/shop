import type { NewOrderEvent } from '$lib/domain/orders';
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
}
