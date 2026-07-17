export function normalizeHttpsProviderBaseUrl(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null;

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (
		parsed.protocol !== 'https:' ||
		parsed.username !== '' ||
		parsed.password !== '' ||
		parsed.search !== '' ||
		parsed.hash !== '' ||
		value.includes('?') ||
		value.includes('#')
	) {
		return null;
	}

	const pathPrefix = parsed.pathname.replace(/\/+$/u, '');
	return `${parsed.origin}${pathPrefix}`;
}
