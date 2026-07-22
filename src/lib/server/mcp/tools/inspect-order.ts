import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type {
	FulfillmentRepository,
	OrderWithLinesAndEvents
} from '$lib/server/fulfillment/repository.server';
import { emptyProductionDetails } from '$lib/domain/production';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

const orderIdSchema = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(200),
	v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/)
);
const inputSchema = safeToolSchema(
	v.strictObject({
		order_id: orderIdSchema,
		include_shipping_details: v.optional(v.boolean(), false)
	})
);
const outputSchema = v.strictObject({
	order_id: v.optional(v.string()),
	payment: v.optional(
		v.strictObject({
			status: v.string(),
			currency: v.literal('eur'),
			amounts: v.strictObject({
				subtotal: v.number(),
				discount: v.number(),
				shipping: v.number(),
				shipping_tax: v.number(),
				tax: v.number(),
				total: v.number()
			})
		})
	),
	destination_country: v.optional(v.string()),
	fulfillment: v.optional(
		v.strictObject({
			status: v.string(),
			styria_order_id: v.nullable(v.string()),
			styria_status: v.nullable(v.string()),
			tracking_number: v.nullable(v.string()),
			submitted_at: v.nullable(v.string()),
			shipped_at: v.nullable(v.string()),
			updated_at: v.string(),
			last_error_code: v.nullable(v.string())
		})
	),
	lines: v.optional(
		v.array(
			v.strictObject({
				line_index: v.number(),
				product_name: v.string(),
				variant_label: v.string(),
				sku: v.string(),
				styria_product_number: v.string(),
				design_reference: v.string(),
				design_placements: v.record(v.string(), v.string()),
				production_details: v.strictObject({
					mockup_placements: v.record(v.string(), v.string()),
					thread_colors: v.record(v.string(), v.array(v.string()))
				}),
				quantity: v.number(),
				unit_amount: v.number(),
				retail_unit_amount: v.number(),
				currency: v.literal('eur')
			})
		)
	),
	support: v.optional(
		v.array(
			v.strictObject({
				outcome: v.string(),
				note: v.nullable(v.string()),
				external_reference: v.nullable(v.string()),
				created_at: v.string()
			})
		)
	),
	shipping_details: v.optional(
		v.strictObject({
			recipient: v.strictObject({
				firstName: v.string(),
				lastName: v.string(),
				company: v.string(),
				phone: v.string()
			}),
			address: v.strictObject({
				line1: v.string(),
				line2: v.string(),
				city: v.string(),
				state: v.string(),
				postalCode: v.string(),
				countryCode: v.string()
			}),
			email: v.string()
		})
	),
	error: toolErrorSchema
});
const reviewStatuses = new Set(['pending_review', 'review_required']);

function localSummary(order: OrderWithLinesAndEvents) {
	return {
		order_id: order.id,
		payment: {
			status: order.paymentStatus,
			currency: order.currency,
			amounts: {
				subtotal: order.amounts.subtotal,
				discount: order.amounts.discount,
				shipping: order.amounts.shipping,
				shipping_tax: order.amounts.shippingTax,
				tax: order.amounts.tax,
				total: order.amounts.total
			}
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
		lines: order.lines.map((line) => {
			const productionDetails = line.productionDetails ?? emptyProductionDetails();
			return {
				line_index: line.lineIndex,
				product_name: line.productName,
				variant_label: line.variantLabel,
				sku: line.sku,
				styria_product_number: line.styriaProductNumber,
				design_reference: line.designReference,
				design_placements: { ...line.designPlacements },
				production_details: {
					mockup_placements: { ...productionDetails.mockupPlacements },
					thread_colors: Object.fromEntries(
						Object.entries(productionDetails.threadColors).map(([position, colors]) => [
							position,
							[...colors]
						])
					)
				},
				quantity: line.quantity,
				unit_amount: line.unitAmount,
				retail_unit_amount: line.retailUnitAmount,
				currency: line.currency
			};
		}),
		support: order.supportNotes.map((note) => ({
			outcome: note.outcome,
			note: note.note,
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
		async (input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			const { order_id, include_shipping_details } = input;
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
