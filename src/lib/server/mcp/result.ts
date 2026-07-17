import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import { isStableErrorCode } from '$lib/domain/orders';

export type ToolData = Record<string, unknown>;

const invalidToolInput = Object.freeze({ invalidToolInput: true });

export const toolErrorSchema = v.optional(
	v.strictObject({
		code: v.pipe(v.string(), v.minLength(1), v.maxLength(128))
	})
);

type StandardValidation = {
	value?: unknown;
	issues?: readonly unknown[];
};

function privateValidationResult(result: StandardValidation): StandardValidation {
	return result.issues ? { value: invalidToolInput } : result;
}

/**
 * TMCP normally serializes Valibot issues into the protocol response. Those issues can contain
 * rejected administrator input, so convert validation failure to an opaque value that the tool
 * handler can turn into our stable mirrored error envelope.
 */
export function safeToolSchema<TSchema extends GenericSchema>(schema: TSchema): TSchema {
	const standard = schema['~standard'];
	return {
		...schema,
		'~standard': {
			...standard,
			validate(value: unknown) {
				const result = standard.validate(value);
				return result instanceof Promise
					? result.then(privateValidationResult)
					: privateValidationResult(result);
			}
		}
	} as TSchema;
}

export function isInvalidToolInput(value: unknown): boolean {
	return value === invalidToolInput;
}

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
