export function swedishReferenceGrossCents(netCents: number): number {
	if (!Number.isSafeInteger(netCents) || netCents < 0) throw new Error('INVALID_CENTS');

	const grossCents = (BigInt(netCents) * 125n + 50n) / 100n;

	if (grossCents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_CENTS');
	return Number(grossCents);
}

export function formatEur(cents: number, locale?: string): string {
	if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('INVALID_CENTS');

	const centsValue = BigInt(cents);
	const fractionalCents = (centsValue % 100n).toString().padStart(2, '0');
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
