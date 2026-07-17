import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

export type ShippingEmailTarget = {
	email: string;
	trackingNumber: string;
};

export interface ShippingEmailService {
	getTarget(orderId: string): Promise<ShippingEmailTarget>;
	send(input: {
		orderId: string;
		expectedEmail: string;
		expectedTrackingNumber: string;
	}): Promise<{ sent: true }>;
}

const exactString = (maximum: number) =>
	v.pipe(v.string(), v.minLength(1), v.maxLength(maximum), v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/));
const inputSchema = safeToolSchema(
	v.strictObject({
		order_id: exactString(200),
		mode: v.optional(v.picklist(['preview', 'send']), 'preview'),
		expected_email: v.optional(v.pipe(exactString(500), v.email())),
		expected_tracking_number: v.optional(exactString(200))
	})
);
const outputSchema = v.strictObject({
	order_id: v.optional(v.string()),
	mode: v.optional(v.picklist(['preview', 'send'])),
	email: v.optional(v.string()),
	tracking_number: v.optional(v.string()),
	sent: v.optional(v.boolean()),
	error: toolErrorSchema
});

export function registerResendShippingTool(
	server: McpServer<GenericSchema>,
	shipping: ShippingEmailService | undefined
): void {
	server.tool(
		{
			name: 'resend_shipping_email',
			description:
				'Preview the current shipping email target by default; send only after exact email and tracking review.',
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
			const { order_id, mode, expected_email, expected_tracking_number } = input;
			if (!shipping) return toolError('MCP_SHIPPING_SERVICE_UNAVAILABLE');
			if (
				mode === 'send' &&
				(expected_email === undefined || expected_tracking_number === undefined)
			) {
				return toolError('SHIPPING_EMAIL_REVIEW_REQUIRED');
			}
			try {
				const target = await shipping.getTarget(order_id);
				if (mode === 'preview') {
					return toolResult({
						order_id,
						mode,
						email: target.email,
						tracking_number: target.trackingNumber,
						sent: false
					});
				}
				if (expected_email !== target.email || expected_tracking_number !== target.trackingNumber) {
					return toolError('SHIPPING_EMAIL_REVIEW_MISMATCH');
				}
				await shipping.send({
					orderId: order_id,
					expectedEmail: expected_email as string,
					expectedTrackingNumber: expected_tracking_number as string
				});
				return toolResult({
					order_id,
					mode,
					email: target.email,
					tracking_number: target.trackingNumber,
					sent: true
				});
			} catch (error) {
				return caughtToolError(error, 'SHIPPING_EMAIL_ACTION_FAILED');
			}
		}
	);
}
