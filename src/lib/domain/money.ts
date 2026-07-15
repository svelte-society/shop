export function swedishReferenceGrossCents(netCents: number): number {
	if (!Number.isSafeInteger(netCents) || netCents < 0) throw new Error('INVALID_CENTS');
	return Math.round((netCents * 125) / 100);
}

export function formatEur(cents: number, locale?: string): string {
	if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('INVALID_CENTS');

	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: 'EUR'
	}).format(cents / 100);
}
