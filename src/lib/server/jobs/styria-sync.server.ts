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
	run(now?: Date): Promise<{ checked: number; updated: number; shippingQueued: number }>;
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

export class SqliteStyriaSyncJob implements StyriaSyncJob {
	private readonly clock: () => Date;

	constructor(private readonly dependencies: SqliteStyriaSyncDependencies) {
		this.clock = dependencies.clock ?? (() => new Date());
	}

	async run(
		now = this.clock()
	): Promise<{ checked: number; updated: number; shippingQueued: number }> {
		if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('STYRIA_SYNC_TIME_INVALID');
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
				ORDER BY o.updated_at, o.id
				LIMIT ?`
			)
			.all(SYNC_LIMIT) as CandidateRow[];
		let updated = 0;
		let shippingQueued = 0;

		for (const candidate of candidates) {
			if (
				!exactString(candidate.id) ||
				!exactString(candidate.fulfillment_status) ||
				(candidate.tracking_number !== null && !exactString(candidate.tracking_number))
			) {
				fail('STYRIA_SYNC_ROW_INVALID');
			}
			if (
				candidate.tracking_number !== null &&
				this.dependencies.outbox.ensureShipping(candidate.id, candidate.tracking_number, now)
			) {
				shippingQueued += 1;
			}
			if (isTerminal(candidate.fulfillment_status)) continue;
			try {
				const result = await this.check(candidate.id, now);
				if (result.updated) updated += 1;
				if (result.shippingQueued) shippingQueued += 1;
			} catch (error) {
				// Provider failures must not mutate local state. The next hourly run tries again.
				if (error instanceof StyriaError) continue;
				throw error;
			}
		}

		return { checked: candidates.length, updated, shippingQueued };
	}

	async check(orderId: string, now = this.clock()): Promise<StyriaStatusResult> {
		const before = this.dependencies.fulfillment.inspect(orderId);
		if (!before) fail('ORDER_NOT_FOUND');
		if (before.styriaOrderId === null) fail('STYRIA_ORDER_NOT_RECORDED');
		const provider = await this.dependencies.styria.get(before.styriaOrderId);
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

		const apply = this.dependencies.database.transaction(() => {
			if (changed) this.dependencies.fulfillment.applyStyriaStatus(orderId, update, now);
			if (trackingNumber !== null) {
				shippingQueued = this.dependencies.outbox.ensureShipping(orderId, trackingNumber, now);
			}
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
}
