import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type { WithdrawalStatus } from '$lib/domain/withdrawals';
import type {
	WithdrawalCaseSummary,
	WithdrawalListInput
} from '$lib/server/withdrawals/repository.server';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

export type ListWithdrawalCasesService = {
	listCases(input: WithdrawalListInput): WithdrawalCaseSummary[];
};

const withdrawalStatuses = [
	'submitted',
	'reviewing',
	'awaiting_return',
	'ineligible',
	'support_handling',
	'closed'
] as const satisfies readonly WithdrawalStatus[];

const inputSchema = safeToolSchema(
	v.strictObject({
		status: v.optional(v.picklist(withdrawalStatuses)),
		limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(100)), 50)
	})
);

const outputSchema = v.strictObject({
	cases: v.optional(
		v.array(
			v.strictObject({
				reference: v.string(),
				status: v.picklist(withdrawalStatuses),
				scope: v.picklist(['entire_order', 'specific_items']),
				eligibility: v.picklist([
					'pending',
					'eligible_eu',
					'ineligible_non_eu',
					'support_handling'
				]),
				outcome_code: v.nullable(v.string()),
				created_at: v.string(),
				updated_at: v.string(),
				closed_at: v.nullable(v.string()),
				purged_at: v.nullable(v.string())
			})
		)
	),
	error: toolErrorSchema
});

function publicCase(record: WithdrawalCaseSummary) {
	return {
		reference: record.reference,
		status: record.status,
		scope: record.scope,
		eligibility: record.eligibility,
		outcome_code: record.outcomeCode,
		created_at: record.createdAt.toISOString(),
		updated_at: record.updatedAt.toISOString(),
		closed_at: record.closedAt?.toISOString() ?? null,
		purged_at: record.purgedAt?.toISOString() ?? null
	};
}

export function registerListWithdrawalsTool(
	server: McpServer<GenericSchema>,
	withdrawals: ListWithdrawalCasesService | undefined
): void {
	server.tool(
		{
			name: 'list_withdrawal_cases',
			description:
				'List PII-free withdrawal case summaries for administrator review, newest first.',
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
			const { status, limit } = input;
			try {
				const query =
					status === undefined ? { limit: limit ?? 50 } : { status, limit: limit ?? 50 };
				const cases = withdrawals
					.listCases(query)
					.slice()
					.sort(
						(left, right) =>
							right.createdAt.getTime() - left.createdAt.getTime() ||
							right.reference.localeCompare(left.reference)
					)
					.map(publicCase);
				return toolResult({ cases });
			} catch (error) {
				return caughtToolError(error, 'WITHDRAWAL_CASES_LIST_FAILED');
			}
		}
	);
}
