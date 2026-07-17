import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type {
	FulfillmentRepository,
	OrderWithLinesAndEvents
} from '$lib/server/fulfillment/repository.server';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import { caughtToolError, toolError, toolResult } from '../result';

const orderIdSchema = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(200),
	v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/)
);
const inputSchema = v.strictObject({
	order_id: orderIdSchema,
	include_shipping_details: v.optional(v.boolean(), false)
});
const outputSchema = v.looseObject({});
const reviewStatuses = new Set(['pending_review', 'review_required']);

function localSummary(order: OrderWithLinesAndEvents) {
	return {
		order_id: order.id,
		payment: {
			status: order.paymentStatus,
			currency: order.currency,
			amounts: { ...order.amounts }
		},
		destination_country: order.destinationCountry,
		fulfillment: {
			status: order.fulfillmentStatus,
			styria_order_id: order.styriaOrderId,
			styria_status: order.styriaStatus,
			tracking_number: order.trackingNumber,
			submitted_at: order.submittedAt?.toISOString() ?? null,
			shipped_at: order.shippedAt?.toISOString() ?? null,
			updated_at: order.updatedAt.toISOString(),
			last_error_code: order.lastErrorCode
		},
		lines: order.lines.map((line) => ({
			line_index: line.lineIndex,
			product_name: line.productName,
			variant_label: line.variantLabel,
			sku: line.sku,
			styria_product_number: line.styriaProductNumber,
			design_reference: line.designReference,
			design_placements: { ...line.designPlacements },
			quantity: line.quantity,
			unit_amount: line.unitAmount,
			currency: line.currency
		})),
		support: order.supportNotes.map((note) => ({
			outcome: note.outcome,
			external_reference: note.externalReference,
			created_at: note.createdAt.toISOString()
		}))
	};
}

export function registerInspectOrderTool(
	server: McpServer<GenericSchema>,
	dependencies: {
		fulfillment: Pick<FulfillmentRepository, 'inspect'> | undefined;
		stripe: Pick<StripeFulfillmentGateway, 'retrieveFulfillmentDetails'> | undefined;
	}
): void {
	server.tool(
		{
			name: 'inspect_order',
			description:
				'Inspect payment, line, support, and fulfillment summaries. Shipping details are fetched only for explicit review.',
			schema: inputSchema,
			outputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			}
		},
		async ({ order_id, include_shipping_details }) => {
			if (!dependencies.fulfillment) return toolError('MCP_FULFILLMENT_SERVICE_UNAVAILABLE');
			try {
				const order = dependencies.fulfillment.inspect(order_id);
				if (!order) return toolError('FULFILLMENT_ORDER_NOT_FOUND');
				const result: Record<string, unknown> = localSummary(order);
				if (include_shipping_details && reviewStatuses.has(order.fulfillmentStatus)) {
					if (!dependencies.stripe) return toolError('MCP_STRIPE_SERVICE_UNAVAILABLE');
					result.shipping_details = await dependencies.stripe.retrieveFulfillmentDetails(
						order.checkoutSessionId
					);
				}
				return toolResult(result);
			} catch (error) {
				return caughtToolError(error, 'ORDER_INSPECTION_FAILED');
			}
		}
	);
}
