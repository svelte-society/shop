import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type { PreparationService } from '$lib/server/fulfillment/prepare.server';
import { caughtToolError, toolError, toolResult } from '../result';

const inputSchema = v.strictObject({
	order_id: v.pipe(
		v.string(),
		v.minLength(1),
		v.maxLength(200),
		v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/)
	)
});
const outputSchema = v.looseObject({});

export function registerPrepareStyriaTool(
	server: McpServer<GenericSchema>,
	preparation: PreparationService | undefined
): void {
	server.tool(
		{
			name: 'prepare_styria_submission',
			description: 'Validate an order and create a ten-minute, one-use Styria approval.',
			schema: inputSchema,
			outputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true
			}
		},
		async ({ order_id }) => {
			if (!preparation) return toolError('MCP_PREPARATION_SERVICE_UNAVAILABLE');
			try {
				return toolResult({ ...(await preparation.prepare(order_id)) });
			} catch (error) {
				return caughtToolError(error, 'FULFILLMENT_PREPARATION_FAILED');
			}
		}
	);
}
