import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type { SubmissionService } from '$lib/server/fulfillment/submit.server';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

const exactString = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(200),
	v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/)
);
const inputSchema = safeToolSchema(
	v.strictObject({
		order_id: exactString,
		approval_id: exactString
	})
);
const outputSchema = v.strictObject({
	orderId: v.optional(v.string()),
	styriaOrderId: v.optional(v.string()),
	fulfillmentStatus: v.optional(v.literal('awaiting_vendor_payment')),
	manualPaymentRequired: v.optional(v.literal(true)),
	error: toolErrorSchema
});

export function registerSubmitStyriaTool(
	server: McpServer<GenericSchema>,
	submission: SubmissionService | undefined
): void {
	server.tool(
		{
			name: 'submit_styria_order',
			description: 'Submit an approved order to Styria. Never retry an ambiguous create.',
			schema: inputSchema,
			outputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true
			}
		},
		async (input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			const { order_id, approval_id } = input;
			if (!submission) return toolError('MCP_SUBMISSION_SERVICE_UNAVAILABLE');
			try {
				const result = await submission.submit({ orderId: order_id, approvalId: approval_id });
				return toolResult({
					orderId: result.orderId,
					styriaOrderId: result.styriaOrderId,
					fulfillmentStatus: result.fulfillmentStatus,
					manualPaymentRequired: result.manualPaymentRequired
				});
			} catch (error) {
				return caughtToolError(error, 'FULFILLMENT_SUBMISSION_FAILED');
			}
		}
	);
}
