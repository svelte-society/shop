import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type { ReconciliationService } from '$lib/server/fulfillment/reconcile.server';
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
		order_id: v.pipe(
			v.string(),
			v.minLength(1),
			v.maxLength(200),
			v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/)
		)
	})
);
const outputSchema = v.strictObject({
	outcome: v.optional(v.picklist(['reconciled', 'not_found', 'ambiguous'])),
	matches: v.optional(v.number()),
	fulfillmentStatus: v.optional(v.string()),
	error: toolErrorSchema
});

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
		async (input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			const { order_id } = input;
			if (!reconciliation) return toolError('MCP_RECONCILIATION_SERVICE_UNAVAILABLE');
			try {
				const result = await reconciliation.reconcile(order_id);
				return toolResult({
					outcome: result.outcome,
					matches: result.matches,
					fulfillmentStatus: result.fulfillmentStatus
				});
			} catch (error) {
				return caughtToolError(error, 'STYRIA_RECONCILIATION_FAILED');
			}
		}
	);
}
