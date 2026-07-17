import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type { PreparationService } from '$lib/server/fulfillment/prepare.server';
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
const noticeSchema = v.strictObject({ code: v.string(), message: v.string() });
const payloadSchema = v.strictObject({
	external_id: v.string(),
	brandName: v.string(),
	comment: v.string(),
	shipping_address: v.strictObject({
		firstName: v.string(),
		lastName: v.string(),
		company: v.string(),
		address1: v.string(),
		address2: v.string(),
		city: v.string(),
		county: v.string(),
		postcode: v.string(),
		country: v.string(),
		phone1: v.string()
	}),
	shipping: v.strictObject({ shippingMethod: v.literal('courier') }),
	items: v.array(
		v.strictObject({
			pn: v.string(),
			quantity: v.number(),
			retailPrice: v.number(),
			description: v.string(),
			designs: v.record(v.string(), v.string())
		})
	)
});
const outputSchema = v.strictObject({
	status: v.optional(v.picklist(['ready', 'blocked'])),
	orderId: v.optional(v.string()),
	approvalId: v.optional(v.nullable(v.string())),
	expiresAt: v.optional(v.nullable(v.string())),
	payloadHash: v.optional(v.nullable(v.string())),
	payload: v.optional(v.nullable(payloadSchema)),
	warnings: v.optional(v.array(noticeSchema)),
	blockers: v.optional(v.array(noticeSchema)),
	error: toolErrorSchema
});

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
		async (input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			const { order_id } = input;
			if (!preparation) return toolError('MCP_PREPARATION_SERVICE_UNAVAILABLE');
			try {
				const result = await preparation.prepare(order_id);
				return toolResult({
					status: result.status,
					orderId: result.orderId,
					approvalId: result.approvalId,
					expiresAt: result.expiresAt,
					payloadHash: result.payloadHash,
					payload: result.payload,
					warnings: result.warnings,
					blockers: result.blockers
				});
			} catch (error) {
				return caughtToolError(error, 'FULFILLMENT_PREPARATION_FAILED');
			}
		}
	);
}
