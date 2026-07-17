const addressWordPattern =
	'[Ss][Tt][Rr][Ee][Ee][Tt]|[Rr][Oo][Aa][Dd]|[Aa][Vv][Ee][Nn][Uu][Ee]|[Ll][Aa][Nn][Ee]|[Dd][Rr][Ii][Vv][Ee]|[Bb][Oo][Uu][Ll][Ee][Vv][Aa][Rr][Dd]|[Gg][Aa][Tt][Aa][Nn]?|[Vv][ÄäAa][Gg][Ee][Nn]|[Ss][Tt][Rr][Aa][Ss][Ss][Ee]';

export const CONCISE_SUPPORT_TEXT_PATTERN = new RegExp(
	`^(?!\\s)(?!.*[\\r\\n])(?!.*\\b[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\b)(?!.*(?:\\+?\\d[\\d ()-]{6,}\\d))(?!.*(?:\\d.*(?:${addressWordPattern})|(?:${addressWordPattern}).*\\d)).*\\S$`
);

export function isConciseSupportText(value: unknown, maximum: number): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum &&
		CONCISE_SUPPORT_TEXT_PATTERN.test(value)
	);
}
