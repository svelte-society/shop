export function formatEur(cents: number, locale?: string): string {
	if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('INVALID_CENTS');

	const centsValue = BigInt(cents);
	const fractionalCents = new Intl.NumberFormat(locale, {
		useGrouping: false,
		minimumIntegerDigits: 2,
		maximumFractionDigits: 0
	}).format(Number(centsValue % 100n));
	const formatter = new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: 'EUR',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	});

	return formatter
		.formatToParts(centsValue / 100n)
		.map((part) => (part.type === 'fraction' ? fractionalCents : part.value))
		.join('');
}
