function caseInsensitiveAlternatives(values: readonly string[]): string {
	return values
		.map((value) =>
			Array.from(value, (character) => {
				const lower = character.toLowerCase();
				const upper = character.toUpperCase();
				return lower === upper ? character : `[${upper}${lower}]`;
			}).join('')
		)
		.join('|');
}

const boundedAddressTypePattern = `\\b(?:${caseInsensitiveAlternatives([
	'street',
	'st',
	'road',
	'rd',
	'avenue',
	'ave',
	'lane',
	'ln',
	'drive',
	'dr',
	'boulevard',
	'blvd',
	'court',
	'ct',
	'circle',
	'cir',
	'place',
	'pl',
	'parkway',
	'pkwy',
	'highway',
	'hwy',
	'route',
	'rte',
	'square',
	'sq',
	'terrace',
	'ter',
	'way'
])})(?:\\.|\\b)`;
const attachedAddressTypePattern = `(?:${caseInsensitiveAlternatives([
	'gata',
	'gatan',
	'vägen',
	'strasse'
])})`;
const addressTypePattern = `(?:${boundedAddressTypePattern}|${attachedAddressTypePattern})`;
const poBoxPattern = `\\b(?:[Pp](?:\\.|\\s)*[Oo](?:\\.|\\s)+[Bb][Oo][Xx]|${caseInsensitiveAlternatives(
	['post office box']
)})\\s*#?\\s*\\d+\\b`;

export const CONCISE_SUPPORT_TEXT_PATTERN = new RegExp(
	`^(?!\\s)(?!.*[\\r\\n])(?!.*\\b[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\b)(?!.*(?:\\+?\\d[\\d ()-]{6,}\\d))(?!.*${poBoxPattern})(?!.*(?:\\d.*${addressTypePattern}|${addressTypePattern}.*\\d)).*\\S$`
);

export function isConciseSupportText(value: unknown, maximum: number): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum &&
		CONCISE_SUPPORT_TEXT_PATTERN.test(value)
	);
}
