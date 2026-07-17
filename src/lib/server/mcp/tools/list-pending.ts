import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type {
	FulfillmentRepository,
	OrderSummary
} from '$lib/server/fulfillment/repository.server';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

const inputSchema = safeToolSchema(
	v.strictObject({
		limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(100)), 50)
	})
);
const outputSchema = v.strictObject({
	orders: v.optional(
		v.array(
			v.strictObject({
				order_id: v.string(),
				payment_status: v.string(),
				fulfillment_status: v.string(),
				currency: v.literal('eur'),
				total_amount: v.number(),
				destination_country: v.string(),
				updated_at: v.string(),
				last_error_code: v.nullable(v.string())
			})
		)
	),
	error: toolErrorSchema
});

function toPendingOrder(order: OrderSummary) {
	return {
		order_id: order.id,
		payment_status: order.paymentStatus,
		fulfillment_status: order.fulfillmentStatus,
		currency: order.currency,
		total_amount: order.totalAmount,
		destination_country: order.destinationCountry,
		updated_at: order.updatedAt.toISOString(),
		last_error_code: order.lastErrorCode
	};
}

export function registerListPendingTool(
	server: McpServer<GenericSchema>,
	fulfillment: Pick<FulfillmentRepository, 'listPending'> | undefined
): void {
	server.tool(
		{
			name: 'list_pending_orders',
			description: 'List paid fulfillment orders awaiting administrator review, oldest first.',
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
			const { limit } = input;
			if (!fulfillment) return toolError('MCP_FULFILLMENT_SERVICE_UNAVAILABLE');
			try {
				const orders = fulfillment
					.listPending(limit ?? 50)
					.slice()
					.sort(
						(left, right) =>
							left.updatedAt.getTime() - right.updatedAt.getTime() ||
							left.id.localeCompare(right.id)
					)
					.map(toPendingOrder);
				return toolResult({ orders });
			} catch (error) {
				return caughtToolError(error, 'PENDING_ORDERS_LIST_FAILED');
			}
		}
	);
}
