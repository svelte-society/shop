export type ProductionDetails = {
	mockupPlacements: Record<string, string>;
	threadColors: Record<string, string[]>;
};

export function emptyProductionDetails(): ProductionDetails {
	return { mockupPlacements: {}, threadColors: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.username === '' && url.password === '';
	} catch {
		return false;
	}
}

function isThreadColor(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 100 &&
		value === value.trim() &&
		!/[\r\n]/.test(value)
	);
}

export function normalizeProductionDetails(value: unknown): ProductionDetails | null {
	if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'mockupPlacements,threadColors') {
		return null;
	}
	if (!isRecord(value.mockupPlacements) || !isRecord(value.threadColors)) return null;

	const mockupPlacements: Record<string, string> = {};
	for (const key of Object.keys(value.mockupPlacements).sort()) {
		const url = value.mockupPlacements[key];
		if (key.length === 0 || key !== key.trim() || !isHttpsUrl(url)) return null;
		mockupPlacements[key] = url;
	}

	const threadColors: Record<string, string[]> = {};
	for (const key of Object.keys(value.threadColors).sort()) {
		const colors = value.threadColors[key];
		if (
			key.length === 0 ||
			key !== key.trim() ||
			!Array.isArray(colors) ||
			colors.length === 0 ||
			colors.length > 20 ||
			!colors.every(isThreadColor) ||
			new Set(colors).size !== colors.length
		) {
			return null;
		}
		threadColors[key] = [...colors];
	}

	return { mockupPlacements, threadColors };
}

export function canonicalProductionDetails(value: unknown): string | null {
	const normalized = normalizeProductionDetails(value);
	return normalized ? JSON.stringify(normalized) : null;
}

export function productionDetailsFromJson(value: unknown): ProductionDetails | null {
	if (typeof value !== 'string') return null;
	try {
		const parsed: unknown = JSON.parse(value);
		const canonical = canonicalProductionDetails(parsed);
		return canonical === value ? (parsed as ProductionDetails) : null;
	} catch {
		return null;
	}
}
