import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type {
	FulfillmentRepository,
	SupportOutcome
} from '$lib/server/fulfillment/repository.server';
import { CONCISE_SUPPORT_TEXT_PATTERN } from '$lib/domain/support';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

const outcomes = [
	'return_approved',
	'return_received',
	'replacement_ordered',
	'replacement_shipped',
	'refund_processed',
	'request_declined',
	'other_reviewed'
] as const satisfies readonly SupportOutcome[];

const exactString = (maximum: number) =>
	v.pipe(v.string(), v.minLength(1), v.maxLength(maximum), v.regex(CONCISE_SUPPORT_TEXT_PATTERN));
const inputSchema = safeToolSchema(
	v.strictObject({
		order_id: v.pipe(
			v.string(),
			v.minLength(1),
			v.maxLength(200),
			v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/)
		),
		outcome: v.picklist(outcomes),
		note: v.optional(exactString(160)),
		external_reference: v.optional(exactString(120))
	})
);
const outputSchema = v.strictObject({
	order_id: v.optional(v.string()),
	outcome: v.optional(v.picklist(outcomes)),
	note: v.optional(v.nullable(v.string())),
	external_reference: v.optional(v.nullable(v.string())),
	recorded: v.optional(v.literal(true)),
	error: toolErrorSchema
});

export function registerRecordSupportTool(
	server: McpServer<GenericSchema>,
	dependencies: {
		fulfillment: Pick<FulfillmentRepository, 'recordSupportNote'> | undefined;
		now: () => Date;
	}
): void {
	server.tool(
		{
			name: 'record_return_or_replacement',
			description:
				'Record a concise reviewed support outcome and external reference. Refunds remain in Stripe Dashboard.',
			schema: inputSchema,
			outputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false
			}
		},
		(input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			const { order_id, outcome, note, external_reference } = input;
			if (!dependencies.fulfillment) return toolError('MCP_FULFILLMENT_SERVICE_UNAVAILABLE');
			try {
				dependencies.fulfillment.recordSupportNote({
					orderId: order_id,
					outcome,
					note: note ?? null,
					externalReference: external_reference ?? null,
					createdAt: dependencies.now()
				});
				return toolResult({
					order_id,
					outcome,
					note: note ?? null,
					external_reference: external_reference ?? null,
					recorded: true as const
				});
			} catch (error) {
				return caughtToolError(error, 'SUPPORT_NOTE_RECORD_FAILED');
			}
		}
	);
}
