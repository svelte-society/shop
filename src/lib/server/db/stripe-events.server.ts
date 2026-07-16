import type { ProviderReferences } from '$lib/domain/orders';
import { isStableErrorCode, RepositoryError } from '$lib/domain/orders';
import type { ShopDatabase } from './types';

export interface StripeEventRepository {
	begin(eventId: string, eventType: string, now: Date): 'new' | 'completed' | 'retry';
	complete(eventId: string, refs: ProviderReferences, now: Date): void;
	fail(eventId: string, errorCode: string): void;
}

type EventStateRow = {
	event_type: unknown;
	processing_status: unknown;
	stripe_checkout_session_id: unknown;
	stripe_payment_intent_id: unknown;
	last_error_code: unknown;
	first_seen_at: unknown;
};

function fail(code: string): never {
	throw new RepositoryError(code);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
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

function validateReferences(refs: ProviderReferences): void {
	if (
		!refs ||
		(refs.checkoutSessionId !== null && !isNonEmptyString(refs.checkoutSessionId)) ||
		(refs.paymentIntentId !== null && !isNonEmptyString(refs.paymentIntentId))
	) {
		fail('STRIPE_EVENT_REFERENCE_INVALID');
	}
}

export class SqliteStripeEventRepository implements StripeEventRepository {
	constructor(private readonly database: ShopDatabase) {}

	begin(eventId: string, eventType: string, now: Date): 'new' | 'completed' | 'retry' {
		if (!isNonEmptyString(eventId) || !isNonEmptyString(eventType)) {
			fail('STRIPE_EVENT_INVALID');
		}
		const timestamp = isoTimestamp(now, 'STRIPE_EVENT_INVALID');
		const find = this.database.prepare(`
			SELECT event_type, processing_status, stripe_checkout_session_id,
				stripe_payment_intent_id, last_error_code, first_seen_at
			FROM stripe_events WHERE stripe_event_id = ?
		`);
		const insert = this.database.prepare(`
			INSERT INTO stripe_events (
				stripe_event_id, event_type, processing_status, stripe_checkout_session_id,
				stripe_payment_intent_id, last_error_code, first_seen_at, completed_at
			) VALUES (?, ?, 'processing', NULL, NULL, NULL, ?, NULL)
		`);
		const retry = this.database.prepare(`
			UPDATE stripe_events
			SET processing_status = 'processing', last_error_code = NULL
			WHERE stripe_event_id = ? AND processing_status = 'failed'
		`);
		const claim = this.database.transaction((): 'new' | 'completed' | 'retry' => {
			const row = find.get(eventId) as EventStateRow | undefined;
			if (!row) {
				insert.run(eventId, eventType, timestamp);
				return 'new';
			}
			if (row.event_type !== eventType) fail('STRIPE_EVENT_TYPE_CONFLICT');
			if (row.processing_status === 'completed') return 'completed';
			if (row.processing_status === 'processing') return 'retry';
			if (row.processing_status !== 'failed') fail('STRIPE_EVENT_ROW_INVALID');
			if (retry.run(eventId).changes !== 1) fail('STRIPE_EVENT_BEGIN_CONFLICT');
			return 'retry';
		});

		try {
			return claim.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('STRIPE_EVENT_BEGIN_FAILED');
		}
	}

	complete(eventId: string, refs: ProviderReferences, now: Date): void {
		if (!isNonEmptyString(eventId)) fail('STRIPE_EVENT_INVALID');
		validateReferences(refs);
		const timestamp = isoTimestamp(now, 'STRIPE_EVENT_INVALID');
		const find = this.database.prepare(`
			SELECT event_type, processing_status, stripe_checkout_session_id,
				stripe_payment_intent_id, last_error_code, first_seen_at
			FROM stripe_events WHERE stripe_event_id = ?
		`);
		const update = this.database.prepare(`
			UPDATE stripe_events
			SET processing_status = 'completed', stripe_checkout_session_id = ?,
				stripe_payment_intent_id = ?, last_error_code = NULL, completed_at = ?
			WHERE stripe_event_id = ? AND processing_status = 'processing'
		`);
		const completeEvent = this.database.transaction(() => {
			const row = find.get(eventId) as EventStateRow | undefined;
			if (!row) fail('STRIPE_EVENT_NOT_FOUND');
			const firstSeenAt = dateFromIso(row.first_seen_at, 'STRIPE_EVENT_ROW_INVALID');
			if (now < firstSeenAt) fail('STRIPE_EVENT_COMPLETION_INVALID');
			if (row.processing_status === 'completed') {
				if (
					row.stripe_checkout_session_id !== refs.checkoutSessionId ||
					row.stripe_payment_intent_id !== refs.paymentIntentId
				) {
					fail('STRIPE_EVENT_REFERENCE_CONFLICT');
				}
				return;
			}
			if (row.processing_status !== 'processing') fail('STRIPE_EVENT_STATE_CONFLICT');
			if (
				update.run(refs.checkoutSessionId, refs.paymentIntentId, timestamp, eventId).changes !== 1
			) {
				fail('STRIPE_EVENT_STATE_CONFLICT');
			}
		});

		try {
			completeEvent.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('STRIPE_EVENT_COMPLETE_FAILED');
		}
	}

	fail(eventId: string, errorCode: string): void {
		if (!isNonEmptyString(eventId) || !isStableErrorCode(errorCode)) {
			fail('STRIPE_EVENT_FAILURE_INVALID');
		}
		const find = this.database.prepare(`
			SELECT event_type, processing_status, stripe_checkout_session_id,
				stripe_payment_intent_id, last_error_code
			FROM stripe_events WHERE stripe_event_id = ?
		`);
		const update = this.database.prepare(`
			UPDATE stripe_events
			SET processing_status = 'failed', last_error_code = ?, completed_at = NULL
			WHERE stripe_event_id = ? AND processing_status = 'processing'
		`);
		const failEvent = this.database.transaction(() => {
			const row = find.get(eventId) as EventStateRow | undefined;
			if (!row) fail('STRIPE_EVENT_NOT_FOUND');
			if (row.processing_status === 'failed' && row.last_error_code === errorCode) return;
			if (row.processing_status !== 'processing') fail('STRIPE_EVENT_STATE_CONFLICT');
			if (update.run(errorCode, eventId).changes !== 1) fail('STRIPE_EVENT_STATE_CONFLICT');
		});

		try {
			failEvent.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('STRIPE_EVENT_FAIL_FAILED');
		}
	}
}
