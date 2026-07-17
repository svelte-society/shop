import { isStableErrorCode } from '$lib/domain/orders';

export type ToolData = Record<string, unknown>;

export function toolResult<T extends ToolData>(data: T) {
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(data) }],
		structuredContent: data
	};
}

export function toolError(code: string) {
	const data = { error: { code } };
	return {
		...toolResult(data),
		isError: true as const
	};
}

export function caughtToolError(error: unknown, fallbackCode: string) {
	const code =
		typeof error === 'object' && error !== null && 'code' in error && isStableErrorCode(error.code)
			? error.code
			: fallbackCode;
	return toolError(code);
}
