import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type { FulfillmentStatus } from '$lib/domain/orders';
import { caughtToolError, toolError, toolResult } from '../result';

export interface FulfillmentStatusService {
	check(orderId: string): Promise<{
		orderId: string;
		fulfillmentStatus: FulfillmentStatus;
		styriaStatus: string;
		trackingNumber: string | null;
	}>;
}

const inputSchema = v.strictObject({
	order_id: v.pipe(
		v.string(),
		v.minLength(1),
		v.maxLength(200),
		v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/)
	)
});
const outputSchema = v.looseObject({});

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
		async ({ order_id }) => {
			if (!status) return toolError('MCP_STATUS_SERVICE_UNAVAILABLE');
			try {
				return toolResult({ ...(await status.check(order_id)) });
			} catch (error) {
				return caughtToolError(error, 'FULFILLMENT_STATUS_CHECK_FAILED');
			}
		}
	);
}
