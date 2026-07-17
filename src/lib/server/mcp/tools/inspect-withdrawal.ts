import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type { WithdrawalInspection } from '$lib/server/withdrawals/receipt.server';
import type { WithdrawalInspectionHistory } from '$lib/server/withdrawals/repository.server';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

export type WithdrawalCaseInspection = {
	inspection: WithdrawalInspection;
	history: WithdrawalInspectionHistory;
};

export type InspectWithdrawalCaseService = {
	inspectCase(reference: string): WithdrawalCaseInspection;
};

const referenceSchema = v.pipe(v.string(), v.regex(/^WDR-[A-Za-z0-9_-]{22}$/));

const inputSchema = safeToolSchema(v.strictObject({ reference: referenceSchema }));

const nullableTimestamp = v.nullable(v.string());
const reconciliationSchema = v.nullable(
	v.strictObject({
		internal_order_reference: v.string(),
		country_code: v.string(),
		customer_instructions: v.nullable(v.string()),
		return_outcome: v.nullable(
			v.picklist(['parcel_received', 'return_waived', 'return_not_received'])
		),
		parcel_reference: v.nullable(v.string())
	})
);

const outputSchema = v.strictObject({
	reference: v.optional(v.string()),
	status: v.optional(v.string()),
	revision: v.optional(v.number()),
	scope: v.optional(v.string()),
	eligibility: v.optional(v.string()),
	outcome_code: v.optional(v.nullable(v.string())),
	created_at: v.optional(v.string()),
	updated_at: v.optional(v.string()),
	reconciled_at: v.optional(nullableTimestamp),
	closed_at: v.optional(nullableTimestamp),
	pii_purge_due_at: v.optional(nullableTimestamp),
	purged_at: v.optional(nullableTimestamp),
	customer: v.optional(
		v.strictObject({
			full_name: v.string(),
			receipt_email: v.string(),
			entered_order_reference: v.string(),
			items: v.array(
				v.strictObject({
					description: v.string(),
					quantity: v.number()
				})
			),
			reconciliation: reconciliationSchema
		})
	),
	events: v.optional(
		v.array(
			v.strictObject({
				actor: v.string(),
				action: v.string(),
				prior_status: v.nullable(v.string()),
				next_status: v.string(),
				result_code: v.string(),
				created_at: v.string()
			})
		)
	),
	messages: v.optional(
		v.array(
			v.strictObject({
				kind: v.string(),
				attempt_count: v.number(),
				next_attempt_at: v.string(),
				provider_delivery_id: v.nullable(v.string()),
				completed_at: nullableTimestamp,
				last_error_code: v.nullable(v.string())
			})
		)
	),
	error: toolErrorSchema
});

function customer(inspection: WithdrawalInspection) {
	const reconciliation = inspection.payload.reconciliation;
	return {
		full_name: inspection.payload.fullName,
		receipt_email: inspection.payload.receiptEmail,
		entered_order_reference: inspection.payload.enteredOrderReference,
		items: inspection.payload.items.map(({ description, quantity }) => ({ description, quantity })),
		reconciliation:
			reconciliation === null
				? null
				: {
						internal_order_reference: reconciliation.internalOrderReference,
						country_code: reconciliation.countryCode,
						customer_instructions: reconciliation.customerInstructions,
						return_outcome: reconciliation.returnOutcome,
						parcel_reference: reconciliation.parcelReference
					}
	};
}

function inspectionResult(result: WithdrawalCaseInspection) {
	const { inspection, history } = result;
	return {
		reference: inspection.reference,
		status: inspection.status,
		revision: inspection.revision,
		scope: inspection.scope,
		eligibility: inspection.eligibility,
		outcome_code: inspection.outcomeCode,
		created_at: inspection.createdAt.toISOString(),
		updated_at: inspection.updatedAt.toISOString(),
		reconciled_at: inspection.reconciledAt?.toISOString() ?? null,
		closed_at: inspection.closedAt?.toISOString() ?? null,
		pii_purge_due_at: inspection.piiPurgeDueAt?.toISOString() ?? null,
		purged_at: inspection.purgedAt?.toISOString() ?? null,
		customer: customer(inspection),
		events: history.events.map((event) => ({
			actor: event.actor,
			action: event.action,
			prior_status: event.priorStatus,
			next_status: event.nextStatus,
			result_code: event.resultCode,
			created_at: event.createdAt.toISOString()
		})),
		messages: history.messages.map((message) => ({
			kind: message.kind,
			attempt_count: message.attemptCount,
			next_attempt_at: message.nextAttemptAt.toISOString(),
			provider_delivery_id: message.providerDeliveryId,
			completed_at: message.completedAt?.toISOString() ?? null,
			last_error_code: message.lastErrorCode
		}))
	};
}

export function registerInspectWithdrawalTool(
	server: McpServer<GenericSchema>,
	withdrawals: InspectWithdrawalCaseService | undefined
): void {
	server.tool(
		{
			name: 'inspect_withdrawal_case',
			description:
				'Inspect one active withdrawal case with customer data and PII-free operational history.',
			schema: inputSchema,
			outputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		(input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			if (!withdrawals) return toolError('MCP_WITHDRAWALS_SERVICE_UNAVAILABLE');
			try {
				return toolResult(inspectionResult(withdrawals.inspectCase(input.reference)));
			} catch (error) {
				return caughtToolError(error, 'WITHDRAWAL_CASE_INSPECTION_FAILED');
			}
		}
	);
}
