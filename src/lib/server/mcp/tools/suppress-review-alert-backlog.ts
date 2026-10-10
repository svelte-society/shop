import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import {
	REVIEW_ALERT_BACKLOG_CONFIRMATION,
	type ReviewAlertBacklogSuppressionService
} from '$lib/server/maintenance/review-alert-backlog.server';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

const countSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const inputSchema = safeToolSchema(
	v.strictObject({
		expected_outstanding_count: v.pipe(
			v.number(),
			v.safeInteger(),
			v.minValue(1),
			v.maxValue(1_000_000)
		),
		confirmation: v.literal(REVIEW_ALERT_BACKLOG_CONFIRMATION)
	})
);
const outputSchema = v.strictObject({
	backup_id: v.optional(v.string()),
	backup_filename: v.optional(v.string()),
	backup_sha256: v.optional(v.string()),
	suppressed_count: v.optional(countSchema),
	previously_suppressed_count: v.optional(countSchema),
	remaining_active_count: v.optional(countSchema),
	targeted_row_count: v.optional(countSchema),
	completed_row_count: v.optional(countSchema),
	total_outbox_row_count: v.optional(countSchema),
	error: toolErrorSchema
});

export function registerSuppressReviewAlertBacklogTool(
	server: McpServer<GenericSchema>,
	suppression: ReviewAlertBacklogSuppressionService | undefined
): void {
	server.tool(
		{
			name: 'suppress_review_alert_backlog',
			description:
				'After an encrypted, verified local SQLite backup, suppress only incomplete ORDER_PENDING_REVIEW and STYRIA_REVIEW_REQUIRED outbox jobs. Requires the exact active count and explicit confirmation; preserves every outbox row and all completed history.',
			schema: inputSchema,
			outputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false
			}
		},
		async (input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			if (!suppression) return toolError('MCP_REVIEW_ALERT_SUPPRESSION_SERVICE_UNAVAILABLE');
			try {
				const result = await suppression.suppress({
					expectedOutstandingCount: input.expected_outstanding_count,
					confirmation: input.confirmation
				});
				return toolResult({
					backup_id: result.backupId,
					backup_filename: result.backupFilename,
					backup_sha256: result.backupChecksum,
					suppressed_count: result.suppressedCount,
					previously_suppressed_count: result.previouslySuppressedCount,
					remaining_active_count: result.remainingActiveCount,
					targeted_row_count: result.targetedRowCount,
					completed_row_count: result.completedRowCount,
					total_outbox_row_count: result.totalOutboxRowCount
				});
			} catch (error) {
				return caughtToolError(error, 'REVIEW_ALERT_SUPPRESSION_FAILED');
			}
		}
	);
}
