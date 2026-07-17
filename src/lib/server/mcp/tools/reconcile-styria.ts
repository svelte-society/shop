import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type { ReconciliationService } from '$lib/server/fulfillment/reconcile.server';
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

export function registerReconcileStyriaTool(
	server: McpServer<GenericSchema>,
	reconciliation: ReconciliationService | undefined
): void {
	server.tool(
		{
			name: 'reconcile_styria_order',
			description: 'Reconcile an ambiguous Styria create using reviewed local evidence.',
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
			if (!reconciliation) return toolError('MCP_RECONCILIATION_SERVICE_UNAVAILABLE');
			try {
				return toolResult({ ...(await reconciliation.reconcile(order_id)) });
			} catch (error) {
				return caughtToolError(error, 'STYRIA_RECONCILIATION_FAILED');
			}
		}
	);
}
