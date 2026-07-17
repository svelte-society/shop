import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type { FulfillmentStatus } from '$lib/domain/orders';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

export interface FulfillmentStatusService {
	check(orderId: string): Promise<{
		orderId: string;
		fulfillmentStatus: FulfillmentStatus;
		styriaStatus: string;
		trackingNumber: string | null;
	}>;
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
	orderId: v.optional(v.string()),
	fulfillmentStatus: v.optional(v.string()),
	styriaStatus: v.optional(v.string()),
	trackingNumber: v.optional(v.nullable(v.string())),
	error: toolErrorSchema
});

export function registerCheckStatusTool(
	server: McpServer<GenericSchema>,
	status: FulfillmentStatusService | undefined
): void {
	server.tool(
		{
			name: 'check_fulfillment_status',
			description: 'Fetch current Styria status and apply the normalized local fulfillment state.',
			schema: inputSchema,
			outputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true
			}
		},
		async (input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			const { order_id } = input;
			if (!status) return toolError('MCP_STATUS_SERVICE_UNAVAILABLE');
			try {
				const result = await status.check(order_id);
				return toolResult({
					orderId: result.orderId,
					fulfillmentStatus: result.fulfillmentStatus,
					styriaStatus: result.styriaStatus,
					trackingNumber: result.trackingNumber
				});
			} catch (error) {
				return caughtToolError(error, 'FULFILLMENT_STATUS_CHECK_FAILED');
			}
		}
	);
}
