import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type {
	FulfillmentRepository,
	SupportOutcome
} from '$lib/server/fulfillment/repository.server';
import { caughtToolError, toolError, toolResult } from '../result';

const outcomes = [
	'return_approved',
	'return_received',
	'replacement_ordered',
	'replacement_shipped',
	'refund_processed',
	'request_declined',
	'other_reviewed'
] as const satisfies readonly SupportOutcome[];

const addressWordPattern =
	'[Ss][Tt][Rr][Ee][Ee][Tt]|[Rr][Oo][Aa][Dd]|[Aa][Vv][Ee][Nn][Uu][Ee]|[Ll][Aa][Nn][Ee]|[Dd][Rr][Ii][Vv][Ee]|[Bb][Oo][Uu][Ll][Ee][Vv][Aa][Rr][Dd]|[Gg][Aa][Tt][Aa][Nn]?|[Vv][ÄäAa][Gg][Ee][Nn]|[Ss][Tt][Rr][Aa][Ss][Ss][Ee]';
const conciseNonContactPattern = new RegExp(
	`^(?!\\s)(?!.*[\\r\\n])(?!.*\\b[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\b)(?!.*(?:\\+?\\d[\\d ()-]{6,}\\d))(?!.*(?:\\d.*(?:${addressWordPattern})|(?:${addressWordPattern}).*\\d)).*\\S$`
);

const exactString = (maximum: number) =>
	v.pipe(v.string(), v.minLength(1), v.maxLength(maximum), v.regex(conciseNonContactPattern));
const inputSchema = v.strictObject({
	order_id: v.pipe(
		v.string(),
		v.minLength(1),
		v.maxLength(200),
		v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/)
	),
	outcome: v.picklist(outcomes),
	note: v.optional(exactString(160)),
	external_reference: v.optional(exactString(120))
});
const outputSchema = v.looseObject({});

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
		({ order_id, outcome, external_reference }) => {
			if (!dependencies.fulfillment) return toolError('MCP_FULFILLMENT_SERVICE_UNAVAILABLE');
			try {
				dependencies.fulfillment.recordSupportNote({
					orderId: order_id,
					outcome,
					externalReference: external_reference ?? null,
					createdAt: dependencies.now()
				});
				return toolResult({
					order_id,
					outcome,
					external_reference: external_reference ?? null,
					recorded: true
				});
			} catch (error) {
				return caughtToolError(error, 'SUPPORT_NOTE_RECORD_FAILED');
			}
		}
	);
}
