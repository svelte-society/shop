import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type {
	BeginWithdrawalReviewInput,
	CloseWithdrawalCaseInput,
	RecordWithdrawalEligibilityInput,
	RecordWithdrawalReturnInput,
	WithdrawalMutationResult
} from '$lib/server/withdrawals/workflow.server';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

type WithoutNow<T> = Omit<T, 'now'>;

export type WithdrawalResendServiceInput = {
	reference: string;
	sourceMessageId: number;
	mode: 'preview' | 'confirm';
	previewToken?: string;
	idempotencyKey?: string;
};

export type WithdrawalResendServiceResult =
	| {
			mode: 'preview';
			reference: string;
			sourceMessageId: number;
			destination: string;
			subject: string;
			textBody: string;
			previewToken: string;
			expiresAt: Date;
			queued: false;
	  }
	| {
			mode: 'confirm';
			reference: string;
			sourceMessageId: number;
			messageId: number;
			queued: true;
	  };

export type WithdrawalCaseManagementService = {
	beginReview(input: WithoutNow<BeginWithdrawalReviewInput>): WithdrawalMutationResult;
	recordEligibility(input: WithoutNow<RecordWithdrawalEligibilityInput>): WithdrawalMutationResult;
	recordReturn(input: WithoutNow<RecordWithdrawalReturnInput>): WithdrawalMutationResult;
	closeCase(input: WithoutNow<CloseWithdrawalCaseInput>): WithdrawalMutationResult;
	resendMessage(input: WithdrawalResendServiceInput): WithdrawalResendServiceResult;
};

const referenceSchema = v.pipe(v.string(), v.regex(/^WDR-[A-Za-z0-9_-]{22}$/));
const positiveRevisionSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const safeText = (maximum: number) =>
	v.pipe(v.string(), v.minLength(1), v.maxLength(maximum), v.regex(/^(?!\s)(?!.*[\r\n]).*\S$/));
const baseOutputProperties = {
	reference: v.optional(v.string()),
	status: v.optional(
		v.picklist([
			'submitted',
			'reviewing',
			'awaiting_return',
			'ineligible',
			'support_handling',
			'closed'
		])
	),
	revision: v.optional(v.number()),
	current_status: v.optional(v.string()),
	current_revision: v.optional(v.number()),
	error: toolErrorSchema
};
const mutationOutputSchema = v.strictObject(baseOutputProperties);
const mutationAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false
} as const;

const beginInputSchema = safeToolSchema(
	v.strictObject({
		reference: referenceSchema,
		expected_status: v.literal('submitted'),
		expected_revision: positiveRevisionSchema
	})
);
const eligibilityInputSchema = safeToolSchema(
	v.strictObject({
		reference: referenceSchema,
		expected_status: v.literal('reviewing'),
		expected_revision: positiveRevisionSchema,
		decision: v.picklist(['eligible_eu', 'ineligible_non_eu', 'support_handling']),
		internal_order_reference: safeText(200),
		country_code: v.pipe(
			v.string(),
			v.minLength(2),
			v.maxLength(4),
			v.regex(/^\s*[A-Za-z]{2}\s*$/)
		),
		customer_instructions: v.optional(safeText(1_000))
	})
);
const returnInputSchema = safeToolSchema(
	v.strictObject({
		reference: referenceSchema,
		expected_status: v.literal('awaiting_return'),
		expected_revision: positiveRevisionSchema,
		outcome: v.picklist(['parcel_received', 'return_waived', 'return_not_received']),
		parcel_reference: v.optional(safeText(120))
	})
);
const closeInputSchema = safeToolSchema(
	v.strictObject({
		reference: referenceSchema,
		expected_status: v.picklist(['awaiting_return', 'ineligible', 'support_handling']),
		expected_revision: positiveRevisionSchema,
		outcome_code: v.picklist([
			'eligible_return_received',
			'eligible_return_waived',
			'eligible_return_not_received',
			'ineligible_non_eu',
			'support_handling_completed'
		])
	})
);
const resendInputSchema = safeToolSchema(
	v.strictObject({
		reference: referenceSchema,
		source_message_id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
		mode: v.picklist(['preview', 'confirm']),
		preview_token: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
		idempotency_key: v.optional(v.pipe(v.string(), v.uuid()))
	})
);
const resendOutputSchema = v.strictObject({
	reference: v.optional(v.string()),
	source_message_id: v.optional(v.number()),
	mode: v.optional(v.picklist(['preview', 'confirm'])),
	destination: v.optional(v.string()),
	subject: v.optional(v.string()),
	text_body: v.optional(v.string()),
	preview_token: v.optional(v.string()),
	expires_at: v.optional(v.string()),
	queued: v.optional(v.boolean()),
	message_id: v.optional(v.number()),
	current_status: v.optional(v.string()),
	current_revision: v.optional(v.number()),
	error: toolErrorSchema
});

function mutationResult(result: WithdrawalMutationResult) {
	return toolResult({
		reference: result.reference,
		status: result.status,
		revision: result.revision
	});
}

function actionError(error: unknown, fallbackCode: string) {
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'WITHDRAWAL_CASE_CONFLICT' &&
		'currentStatus' in error &&
		typeof error.currentStatus === 'string' &&
		'currentRevision' in error &&
		Number.isSafeInteger(error.currentRevision)
	) {
		const data = {
			error: { code: 'WITHDRAWAL_CASE_CONFLICT' },
			current_status: error.currentStatus,
			current_revision: error.currentRevision as number
		};
		return { ...toolResult(data), isError: true as const };
	}
	return caughtToolError(error, fallbackCode);
}

export function registerManageWithdrawalTools(
	server: McpServer<GenericSchema>,
	workflow: WithdrawalCaseManagementService | undefined
): void {
	server.tool(
		{
			name: 'begin_withdrawal_review',
			description: 'Start explicit administrator review of one submitted withdrawal case.',
			schema: beginInputSchema,
			outputSchema: mutationOutputSchema,
			annotations: mutationAnnotations
		},
		(input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			if (!workflow) return toolError('MCP_WITHDRAWALS_SERVICE_UNAVAILABLE');
			try {
				return mutationResult(
					workflow.beginReview({
						reference: input.reference,
						expectedStatus: input.expected_status,
						expectedRevision: input.expected_revision
					})
				);
			} catch (error) {
				return actionError(error, 'WITHDRAWAL_REVIEW_ACTION_FAILED');
			}
		}
	);

	server.tool(
		{
			name: 'record_withdrawal_eligibility',
			description:
				'Record the reviewed eligibility or support-handling path and queue its message.',
			schema: eligibilityInputSchema,
			outputSchema: mutationOutputSchema,
			annotations: mutationAnnotations
		},
		(input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			if (!workflow) return toolError('MCP_WITHDRAWALS_SERVICE_UNAVAILABLE');
			if (
				(input.decision === 'eligible_eu' && input.customer_instructions === undefined) ||
				(input.decision !== 'eligible_eu' && input.customer_instructions !== undefined)
			) {
				return toolError('WITHDRAWAL_ELIGIBILITY_INVALID');
			}
			try {
				return mutationResult(
					workflow.recordEligibility({
						reference: input.reference,
						expectedStatus: input.expected_status,
						expectedRevision: input.expected_revision,
						decision: input.decision,
						internalOrderReference: input.internal_order_reference,
						countryCode: input.country_code.trim().toUpperCase(),
						customerInstructions: input.customer_instructions
					})
				);
			} catch (error) {
				return actionError(error, 'WITHDRAWAL_ELIGIBILITY_ACTION_FAILED');
			}
		}
	);

	server.tool(
		{
			name: 'record_withdrawal_return',
			description: 'Record reviewed return outcome metadata without changing the waiting state.',
			schema: returnInputSchema,
			outputSchema: mutationOutputSchema,
			annotations: mutationAnnotations
		},
		(input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			if (!workflow) return toolError('MCP_WITHDRAWALS_SERVICE_UNAVAILABLE');
			try {
				return mutationResult(
					workflow.recordReturn({
						reference: input.reference,
						expectedStatus: input.expected_status,
						expectedRevision: input.expected_revision,
						outcome: input.outcome,
						parcelReference: input.parcel_reference
					})
				);
			} catch (error) {
				return actionError(error, 'WITHDRAWAL_RETURN_ACTION_FAILED');
			}
		}
	);

	server.tool(
		{
			name: 'close_withdrawal_case',
			description: 'Close one reviewed withdrawal case and schedule its encrypted-data purge.',
			schema: closeInputSchema,
			outputSchema: mutationOutputSchema,
			annotations: mutationAnnotations
		},
		(input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			if (!workflow) return toolError('MCP_WITHDRAWALS_SERVICE_UNAVAILABLE');
			try {
				return mutationResult(
					workflow.closeCase({
						reference: input.reference,
						expectedStatus: input.expected_status,
						expectedRevision: input.expected_revision,
						outcomeCode: input.outcome_code
					})
				);
			} catch (error) {
				return actionError(error, 'WITHDRAWAL_CLOSE_ACTION_FAILED');
			}
		}
	);

	server.tool(
		{
			name: 'resend_withdrawal_message',
			description: 'Preview exact withdrawal message content, then queue one reviewed resend.',
			schema: resendInputSchema,
			outputSchema: resendOutputSchema,
			annotations: mutationAnnotations
		},
		(input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			if (!workflow) return toolError('MCP_WITHDRAWALS_SERVICE_UNAVAILABLE');
			if (
				(input.mode === 'preview' &&
					(input.preview_token !== undefined || input.idempotency_key !== undefined)) ||
				(input.mode === 'confirm' &&
					(input.preview_token === undefined || input.idempotency_key === undefined))
			) {
				return toolError('WITHDRAWAL_MESSAGE_PREVIEW_REQUIRED');
			}
			try {
				const result = workflow.resendMessage({
					reference: input.reference,
					sourceMessageId: input.source_message_id,
					mode: input.mode,
					previewToken: input.preview_token,
					idempotencyKey: input.idempotency_key
				});
				return result.mode === 'preview'
					? toolResult({
							reference: result.reference,
							source_message_id: result.sourceMessageId,
							mode: result.mode,
							destination: result.destination,
							subject: result.subject,
							text_body: result.textBody,
							preview_token: result.previewToken,
							expires_at: result.expiresAt.toISOString(),
							queued: result.queued
						})
					: toolResult({
							reference: result.reference,
							source_message_id: result.sourceMessageId,
							mode: result.mode,
							queued: result.queued,
							message_id: result.messageId
						});
			} catch (error) {
				return actionError(error, 'WITHDRAWAL_MESSAGE_ACTION_FAILED');
			}
		}
	);
}
