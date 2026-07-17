const REDACTED = '[REDACTED]';

function normalizedKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSafeKey(key: string): boolean {
	const normalized = normalizedKey(key);
	return (
		normalized === 'level' ||
		normalized === 'method' ||
		normalized === 'pathname' ||
		normalized === 'route' ||
		normalized === 'status' ||
		normalized === 'country' ||
		normalized === 'countrycode' ||
		normalized === 'durationms' ||
		normalized === 'code' ||
		normalized.endsWith('errorcode') ||
		normalized.endsWith('count') ||
		normalized.endsWith('id') ||
		normalized.endsWith('ids')
	);
}

function isSensitiveKey(key: string): boolean {
	const normalized = normalizedKey(key);
	if (normalized === 'pathname') return false;
	return (
		normalized.includes('authorization') ||
		normalized.includes('cookie') ||
		normalized.includes('secret') ||
		normalized.includes('signature') ||
		normalized.includes('email') ||
		normalized === 'name' ||
		normalized.startsWith('name') ||
		normalized.endsWith('name') ||
		normalized.includes('address') ||
		normalized.includes('phone') ||
		normalized === 'vat' ||
		normalized.startsWith('vat') ||
		normalized.endsWith('vat') ||
		normalized.includes('body') ||
		normalized.includes('payload') ||
		normalized === 'headers' ||
		normalized.endsWith('headers') ||
		normalized.includes('providerresponse') ||
		normalized.includes('rawresponse')
	);
}

function containsSensitiveScalar(value: string): boolean {
	const hasControlCharacter = [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
	if (
		hasControlCharacter ||
		/@|\b(?:bearer|basic)\s+|\b(?:sk|rk)_(?:live|test)_|\bwhsec_|\bt=\d+,v\d+=/iu.test(value)
	) {
		return true;
	}
	return false;
}

function safePathname(value: string): string {
	if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(value)) return REDACTED;
	const forms = [value];
	for (let depth = 0; depth < 4; depth += 1) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(forms[forms.length - 1]);
		} catch {
			return REDACTED;
		}
		if (decoded === forms[forms.length - 1]) break;
		forms.push(decoded);
	}
	if (forms.some((form) => containsSensitiveScalar(form) || (form.match(/\d/gu)?.length ?? 0) >= 7))
		return REDACTED;
	if (/%[0-9a-f]{2}/iu.test(forms[forms.length - 1])) return REDACTED;
	return value;
}

function safeScalar(key: string, value: unknown): unknown {
	const normalized = normalizedKey(key);
	if (typeof value === 'number') {
		return Number.isFinite(value) && value >= 0 ? value : REDACTED;
	}
	if (typeof value !== 'string') return REDACTED;
	if (containsSensitiveScalar(value)) {
		return REDACTED;
	}
	if (normalized === 'method') {
		return /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/u.test(value) ? value : REDACTED;
	}
	if (normalized === 'pathname') {
		return safePathname(value);
	}
	if (normalized === 'route') {
		return /^(?:unmatched|\/[A-Za-z0-9_./()[\]+=-]{0,255})$/u.test(value) ? value : REDACTED;
	}
	if (normalized === 'country' || normalized === 'countrycode') {
		return /^[A-Z]{2}$/u.test(value) ? value : REDACTED;
	}
	return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : REDACTED;
}

function isPlainObject(value: object): boolean {
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function redactValue(value: unknown, key: string | null, seen: WeakSet<object>): unknown {
	if (key !== null && isSensitiveKey(key)) return REDACTED;
	if (value === null) return key !== null && isSafeKey(key) ? null : REDACTED;
	if (typeof value !== 'object') {
		return key !== null && isSafeKey(key) ? safeScalar(key, value) : REDACTED;
	}
	if (seen.has(value)) return REDACTED;
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((entry) => redactValue(entry, key, seen));
	}
	if (!isPlainObject(value)) return REDACTED;

	let keys: string[];
	try {
		keys = Object.keys(value);
	} catch {
		return REDACTED;
	}

	const output: Record<string, unknown> = {};
	for (const childKey of keys) {
		let childValue: unknown;
		if (isSensitiveKey(childKey)) {
			childValue = REDACTED;
		} else {
			try {
				childValue = redactValue((value as Record<string, unknown>)[childKey], childKey, seen);
			} catch {
				childValue = REDACTED;
			}
		}
		Object.defineProperty(output, childKey, {
			value: childValue,
			enumerable: true,
			writable: true,
			configurable: true
		});
	}
	return output;
}

export function redact(value: unknown): unknown {
	try {
		return redactValue(value, null, new WeakSet());
	} catch {
		return REDACTED;
	}
}
