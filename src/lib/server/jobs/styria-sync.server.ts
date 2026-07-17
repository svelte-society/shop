import { mapStyriaStatus } from '$lib/domain/fulfillment';
import type { FulfillmentStatus } from '$lib/domain/orders';
import { RepositoryError } from '$lib/domain/orders';
import type { OutboxRepository } from '$lib/server/db/outbox.server';
import type { ShopDatabase } from '$lib/server/db/types';
import type { FulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import { StyriaError, type StyriaGateway } from '$lib/server/styria/gateway';

// Runtime configuration caps Styria calls at 10 seconds, so 100 sequential checks remain
// comfortably inside the scheduler's 55-minute lease.
const SYNC_LIMIT = 100;

export interface StyriaSyncJob {
	run(
		now?: Date,
		signal?: AbortSignal
	): Promise<{ checked: number; updated: number; shippingQueued: number }>;
}

export type StyriaStatusResult = {
	orderId: string;
	fulfillmentStatus: FulfillmentStatus;
	styriaStatus: string;
	trackingNumber: string | null;
	updated: boolean;
	shippingQueued: boolean;
};

type CandidateRow = {
	id: unknown;
	fulfillment_status: unknown;
	tracking_number: unknown;
};

export type SqliteStyriaSyncDependencies = {
	database: ShopDatabase;
	styria: StyriaGateway;
	fulfillment: Pick<FulfillmentRepository, 'inspect' | 'applyStyriaStatus'>;
	outbox: OutboxRepository;
	clock?: () => Date;
};

function fail(code: string): never {
	throw new RepositoryError(code);
}

function exactString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function isTerminal(status: unknown): boolean {
	return status === 'shipped' || status === 'cancelled';
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error('STYRIA_SYNC_ABORTED');
}

export class SqliteStyriaSyncJob implements StyriaSyncJob {
	private readonly clock: () => Date;

	constructor(private readonly dependencies: SqliteStyriaSyncDependencies) {
		this.clock = dependencies.clock ?? (() => new Date());
	}

	async run(
		now = this.clock(),
		signal?: AbortSignal
	): Promise<{ checked: number; updated: number; shippingQueued: number }> {
		if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('STYRIA_SYNC_TIME_INVALID');
		throwIfAborted(signal);
		const candidates = this.dependencies.database
			.prepare(
				`SELECT o.id, o.fulfillment_status, o.tracking_number
				FROM orders o
				WHERE o.styria_order_id IS NOT NULL
				AND (
					o.fulfillment_status NOT IN ('shipped', 'cancelled')
					OR (
						o.tracking_number IS NOT NULL
						AND NOT EXISTS (
							SELECT 1 FROM email_deliveries ed
							WHERE ed.idempotency_key =
								'shipping:' || o.id || ':' || o.tracking_number
							AND ed.completed_at IS NOT NULL
						)
					)
				)
				ORDER BY o.styria_last_checked_at, o.updated_at, o.id
				LIMIT ?`
			)
			.all(SYNC_LIMIT) as CandidateRow[];
		let updated = 0;
		let shippingQueued = 0;

		for (const candidate of candidates) {
			throwIfAborted(signal);
			if (
				!exactString(candidate.id) ||
				!exactString(candidate.fulfillment_status) ||
				(candidate.tracking_number !== null && !exactString(candidate.tracking_number))
			) {
				fail('STYRIA_SYNC_ROW_INVALID');
			}
			if (isTerminal(candidate.fulfillment_status)) {
				if (this.recordHandled(candidate.id, candidate.tracking_number, now)) {
					shippingQueued += 1;
				}
				continue;
			}
			try {
				const result = await this.check(candidate.id, now, signal);
				if (result.updated) updated += 1;
				if (result.shippingQueued) shippingQueued += 1;
			} catch (error) {
				throwIfAborted(signal);
				// Provider failures retain fulfillment state; a later fair rotation tries again.
				if (error instanceof StyriaError) {
					if (this.recordHandled(candidate.id, candidate.tracking_number, now)) {
						shippingQueued += 1;
					}
					continue;
				}
				throw error;
			}
		}

		return { checked: candidates.length, updated, shippingQueued };
	}

	async check(
		orderId: string,
		now = this.clock(),
		signal?: AbortSignal
	): Promise<StyriaStatusResult> {
		throwIfAborted(signal);
		const before = this.dependencies.fulfillment.inspect(orderId);
		if (!before) fail('ORDER_NOT_FOUND');
		if (before.styriaOrderId === null) fail('STYRIA_ORDER_NOT_RECORDED');
		const provider = await this.dependencies.styria.get(before.styriaOrderId, signal);
		throwIfAborted(signal);
		if (provider.id !== before.styriaOrderId) throw new StyriaError('STYRIA_RESPONSE_INVALID');
		const update = {
			status: provider.status,
			deleted: provider.deleted,
			trackingNumber: provider.shipping.trackingNumber
		};
		const trackingNumber = update.trackingNumber ?? before.trackingNumber;
		const next = mapStyriaStatus({ ...update, trackingNumber });
		const changed =
			before.fulfillmentStatus !== next ||
			before.styriaStatus !== update.status ||
			before.trackingNumber !== trackingNumber ||
			update.deleted;
		let shippingQueued = false;

		throwIfAborted(signal);
		const apply = this.dependencies.database.transaction(() => {
			if (changed) this.dependencies.fulfillment.applyStyriaStatus(orderId, update, now);
			if (trackingNumber !== null) {
				shippingQueued = this.dependencies.outbox.ensureShipping(orderId, trackingNumber, now);
			}
			this.markChecked(orderId, now);
		});
		apply.immediate();

		const after = this.dependencies.fulfillment.inspect(orderId);
		if (!after || after.styriaStatus === null) fail('STYRIA_SYNC_STATE_INVALID');
		return {
			orderId,
			fulfillmentStatus: after.fulfillmentStatus,
			styriaStatus: after.styriaStatus,
			trackingNumber: after.trackingNumber,
			updated: changed,
			shippingQueued
		};
	}

	private recordHandled(orderId: string, trackingNumber: string | null, now: Date): boolean {
		let shippingQueued = false;
		const record = this.dependencies.database.transaction(() => {
			if (trackingNumber !== null) {
				shippingQueued = this.dependencies.outbox.ensureShipping(orderId, trackingNumber, now);
			}
			this.markChecked(orderId, now);
		});
		record.immediate();
		return shippingQueued;
	}

	private markChecked(orderId: string, now: Date): void {
		const result = this.dependencies.database
			.prepare(
				`UPDATE orders SET styria_last_checked_at =
					CASE
						WHEN styria_last_checked_at IS NULL OR styria_last_checked_at < ? THEN ?
						ELSE styria_last_checked_at
					END
				WHERE id = ?`
			)
			.run(now.toISOString(), now.toISOString(), orderId);
		if (result.changes !== 1) fail('STYRIA_SYNC_CURSOR_FAILED');
	}
}
