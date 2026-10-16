import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import { isStableErrorCode, RepositoryError } from '$lib/domain/orders';
import type { ShopDatabase } from '$lib/server/db/types';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

const deliveryStates = [
	'missing_tracking',
	'not_queued',
	'queued',
	'attempting',
	'retrying',
	'provider_accepted',
	'inconsistent'
] as const;

export type ShippingEmailDeliveryState = (typeof deliveryStates)[number];

export type ShippingEmailDeliveryDiagnostics = Readonly<{
	orderId: string;
	state: ShippingEmailDeliveryState;
	trackingPresent: boolean;
	outboxJob: Readonly<{
		state: 'pending' | 'completed';
		attemptCount: number;
		nextAttemptAt: Date;
		completedAt: Date | null;
		lastErrorCode: string | null;
	}> | null;
	deliveryAttemptCount: number | null;
	providerAccepted: boolean;
	providerAcceptedAt: Date | null;
}>;

export interface ShippingEmailDiagnosticsService {
	inspect(orderId: string): ShippingEmailDeliveryDiagnostics | null;
}

type OrderRow = {
	id: unknown;
	tracking_number: unknown;
};

type OutboxRow = {
	kind: unknown;
	order_id: unknown;
	attempt_count: unknown;
	next_attempt_at: unknown;
	completed_at: unknown;
	last_error_code: unknown;
};

type DeliveryRow = {
	kind: unknown;
	order_id: unknown;
	tracking_reference: unknown;
	completed_at: unknown;
	provider_delivery_id: unknown;
	attempt_count: unknown;
};

function fail(code: string): never {
	throw new RepositoryError(code);
}

function exactString(value: unknown, maximum: number): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum &&
		value === value.trim() &&
		!/[\r\n]/u.test(value)
	);
}

function dateFromIso(value: unknown): Date {
	if (typeof value !== 'string') fail('SHIPPING_EMAIL_DIAGNOSTICS_INVALID');
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
		fail('SHIPPING_EMAIL_DIAGNOSTICS_INVALID');
	}
	return parsed;
}

function mapOutboxRow(row: OutboxRow | undefined, orderId: string) {
	if (!row) return null;
	if (
		row.kind !== 'shipping-email' ||
		row.order_id !== orderId ||
		!Number.isSafeInteger(row.attempt_count) ||
		(row.attempt_count as number) < 0 ||
		(row.last_error_code !== null && !isStableErrorCode(row.last_error_code))
	) {
		fail('SHIPPING_EMAIL_DIAGNOSTICS_INVALID');
	}
	const completedAt = row.completed_at === null ? null : dateFromIso(row.completed_at);
	return {
		state: completedAt === null ? ('pending' as const) : ('completed' as const),
		attemptCount: row.attempt_count as number,
		nextAttemptAt: dateFromIso(row.next_attempt_at),
		completedAt,
		lastErrorCode: row.last_error_code as string | null
	};
}

function mapDeliveryRow(row: DeliveryRow | undefined, orderId: string, trackingNumber: string) {
	if (!row) return null;
	if (
		row.kind !== 'shipping' ||
		row.order_id !== orderId ||
		row.tracking_reference !== trackingNumber ||
		!Number.isSafeInteger(row.attempt_count) ||
		(row.attempt_count as number) < 1 ||
		(row.provider_delivery_id !== null &&
			(typeof row.provider_delivery_id !== 'string' ||
				row.provider_delivery_id.trim().length === 0))
	) {
		fail('SHIPPING_EMAIL_DIAGNOSTICS_INVALID');
	}
	return {
		completedAt: row.completed_at === null ? null : dateFromIso(row.completed_at),
		providerDeliveryRecorded: row.provider_delivery_id !== null,
		attemptCount: row.attempt_count as number
	};
}

function deliveryState(
	outboxJob: ShippingEmailDeliveryDiagnostics['outboxJob'],
	delivery: ReturnType<typeof mapDeliveryRow>
): ShippingEmailDeliveryState {
	if (!outboxJob && !delivery) return 'not_queued';
	const providerAccepted =
		delivery?.completedAt !== null && delivery?.providerDeliveryRecorded === true;
	const partialProviderAcceptance =
		delivery !== null &&
		(delivery.completedAt === null) !== (delivery.providerDeliveryRecorded === false);
	if (
		partialProviderAcceptance ||
		!outboxJob ||
		(outboxJob.completedAt === null && providerAccepted) ||
		(outboxJob.completedAt !== null && !providerAccepted)
	) {
		return 'inconsistent';
	}
	if (providerAccepted) return 'provider_accepted';
	if (delivery) {
		if (delivery.attemptCount < outboxJob.attemptCount) return 'inconsistent';
	}
	if (outboxJob.attemptCount > 0 || outboxJob.lastErrorCode !== null) return 'retrying';
	if (delivery && delivery.attemptCount > outboxJob.attemptCount) return 'attempting';
	return 'queued';
}

export class SqliteShippingEmailDiagnosticsService implements ShippingEmailDiagnosticsService {
	constructor(private readonly database: ShopDatabase) {}

	inspect(orderId: string): ShippingEmailDeliveryDiagnostics | null {
		const inspectSnapshot = this.database.transaction(() => {
			const order = this.database
				.prepare('SELECT id, tracking_number FROM orders WHERE id = ?')
				.get(orderId) as OrderRow | undefined;
			if (!order) return null;
			if (order.id !== orderId) fail('SHIPPING_EMAIL_DIAGNOSTICS_INVALID');
			if (order.tracking_number === null) {
				return {
					orderId,
					state: 'missing_tracking',
					trackingPresent: false,
					outboxJob: null,
					deliveryAttemptCount: null,
					providerAccepted: false,
					providerAcceptedAt: null
				} satisfies ShippingEmailDeliveryDiagnostics;
			}
			if (!exactString(order.tracking_number, 200)) {
				fail('SHIPPING_EMAIL_DIAGNOSTICS_INVALID');
			}

			const idempotencyKey = `shipping:${orderId}:${order.tracking_number}`;
			const outboxJob = mapOutboxRow(
				this.database
					.prepare(
						`SELECT kind, order_id, attempt_count, next_attempt_at, completed_at, last_error_code
						 FROM outbox_jobs WHERE idempotency_key = ?`
					)
					.get(idempotencyKey) as OutboxRow | undefined,
				orderId
			);
			const delivery = mapDeliveryRow(
				this.database
					.prepare(
						`SELECT kind, order_id, tracking_reference, completed_at, provider_delivery_id,
						        attempt_count
						 FROM email_deliveries WHERE idempotency_key = ?`
					)
					.get(idempotencyKey) as DeliveryRow | undefined,
				orderId,
				order.tracking_number
			);
			const providerAccepted =
				delivery?.completedAt !== null && delivery?.providerDeliveryRecorded === true;

			return {
				orderId,
				state: deliveryState(outboxJob, delivery),
				trackingPresent: true,
				outboxJob,
				deliveryAttemptCount: delivery?.attemptCount ?? null,
				providerAccepted,
				providerAcceptedAt: providerAccepted ? delivery.completedAt : null
			} satisfies ShippingEmailDeliveryDiagnostics;
		});
		return inspectSnapshot.deferred();
	}
}

const inputSchema = safeToolSchema(
	v.strictObject({
		order_id: v.pipe(
			v.string(),
			v.minLength(1),
			v.maxLength(200),
			v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/)
		)
	})
);

const outputSchema = v.strictObject({
	order_id: v.optional(v.string()),
	state: v.optional(v.picklist(deliveryStates)),
	tracking_present: v.optional(v.boolean()),
	outbox_job: v.optional(
		v.nullable(
			v.strictObject({
				state: v.picklist(['pending', 'completed']),
				attempt_count: v.number(),
				next_attempt_at: v.string(),
				completed_at: v.nullable(v.string()),
				last_error_code: v.nullable(v.string())
			})
		)
	),
	delivery_attempt_count: v.optional(v.nullable(v.number())),
	provider_accepted: v.optional(v.boolean()),
	provider_accepted_at: v.optional(v.nullable(v.string())),
	error: toolErrorSchema
});

export function registerInspectShippingEmailDeliveryTool(
	server: McpServer<GenericSchema>,
	diagnostics: ShippingEmailDiagnosticsService | undefined
): void {
	server.tool(
		{
			name: 'inspect_shipping_email_delivery',
			description:
				"Inspect privacy-safe local state for an order's current automatic shipping email. An attempting state means a delivery attempt started without a recorded provider acceptance or retry schedule, which can also indicate an interrupted process. Provider accepted means the email provider accepted the send request, not that the message reached the recipient's inbox.",
			schema: inputSchema,
			outputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		(input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			if (!diagnostics) return toolError('MCP_SHIPPING_DIAGNOSTICS_SERVICE_UNAVAILABLE');
			try {
				const result = diagnostics.inspect(input.order_id);
				if (!result) return toolError('ORDER_NOT_FOUND');
				return toolResult({
					order_id: result.orderId,
					state: result.state,
					tracking_present: result.trackingPresent,
					outbox_job: result.outboxJob
						? {
								state: result.outboxJob.state,
								attempt_count: result.outboxJob.attemptCount,
								next_attempt_at: result.outboxJob.nextAttemptAt.toISOString(),
								completed_at: result.outboxJob.completedAt?.toISOString() ?? null,
								last_error_code: result.outboxJob.lastErrorCode
							}
						: null,
					delivery_attempt_count: result.deliveryAttemptCount,
					provider_accepted: result.providerAccepted,
					provider_accepted_at: result.providerAcceptedAt?.toISOString() ?? null
				});
			} catch (error) {
				return caughtToolError(error, 'SHIPPING_EMAIL_DIAGNOSTICS_FAILED');
			}
		}
	);
}
