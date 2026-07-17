import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type { SubmissionService } from '$lib/server/fulfillment/submit.server';
import { caughtToolError, toolError, toolResult } from '../result';

const exactString = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(200),
	v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/)
);
const inputSchema = v.strictObject({
	order_id: exactString,
	approval_id: exactString
});
const outputSchema = v.looseObject({});

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
		async ({ order_id, approval_id }) => {
			if (!submission) return toolError('MCP_SUBMISSION_SERVICE_UNAVAILABLE');
			try {
				return toolResult({
					...(await submission.submit({ orderId: order_id, approvalId: approval_id }))
				});
			} catch (error) {
				return caughtToolError(error, 'FULFILLMENT_SUBMISSION_FAILED');
			}
		}
	);
}
