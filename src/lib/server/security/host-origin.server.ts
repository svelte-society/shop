import { isIP } from 'node:net';

export type SecurityConfig = {
	production: boolean;
	productionOrigin: URL;
	allowedHosts: readonly string[];
	valid: boolean;
};

export type SecurityBoundaryCode =
	| 'SECURITY_CONFIGURATION_INVALID'
	| 'REQUEST_HOST_INVALID'
	| 'REQUEST_ORIGIN_INVALID'
	| 'CLIENT_ADDRESS_INVALID';

export class SecurityBoundaryError extends Error {
	readonly code: SecurityBoundaryCode;
	readonly status: number;

	constructor(code: SecurityBoundaryCode) {
		super(code);
		this.name = 'SecurityBoundaryError';
		this.code = code;
		this.status = code === 'REQUEST_ORIGIN_INVALID' ? 403 : 400;
	}
}

function normalizedHost(value: string): string | null {
	const hasControlCharacter = [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
	if (
		value.length === 0 ||
		value !== value.trim() ||
		hasControlCharacter ||
		/[\s,@/\\?#]/u.test(value)
	) {
		return null;
	}

	try {
		const parsed = new URL(`https://${value}`);
		if (
			parsed.username ||
			parsed.password ||
			parsed.hostname.includes('*') ||
			parsed.pathname !== '/' ||
			parsed.search ||
			parsed.hash
		) {
			return null;
		}
		return parsed.host.toLowerCase();
	} catch {
		return null;
	}
}

function validHttpsOrigin(value: string | undefined): URL | null {
	if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null;
	try {
		const parsed = new URL(value);
		if (
			parsed.protocol !== 'https:' ||
			parsed.username ||
			parsed.password ||
			parsed.hostname.includes('*') ||
			parsed.pathname !== '/' ||
			parsed.search ||
			parsed.hash
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export function createSecurityConfig(
	environment: Record<string, string | undefined>,
	production: boolean
): SecurityConfig {
	const parsedOrigin = validHttpsOrigin(environment.PRODUCTION_ORIGIN);
	const productionOrigin = parsedOrigin ?? new URL('https://invalid.invalid');
	const configuredHosts = (environment.HOST_ALLOWLIST ?? '')
		.split(',')
		.map((entry) => normalizedHost(entry.trim()))
		.filter((entry): entry is string => entry !== null);
	const originHost = parsedOrigin ? normalizedHost(parsedOrigin.host) : null;
	const allowedHosts = [...new Set([...(originHost ? [originHost] : []), ...configuredHosts])];

	return {
		production,
		productionOrigin,
		allowedHosts,
		valid: parsedOrigin !== null && allowedHosts.length > 0
	};
}

function isLocalLiveness(request: Request, host: string | null): boolean {
	if (request.headers.get('origin') !== null || host === null) return false;
	let pathname: string;
	try {
		pathname = new URL(request.url).pathname;
	} catch {
		return false;
	}
	if (pathname !== '/health/live') return false;

	try {
		const parsed = new URL(`http://${host}`);
		const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
		return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
	} catch {
		return false;
	}
}

export function validateHostAndOrigin(request: Request, config: SecurityConfig): void {
	const host = normalizedHost(request.headers.get('host') ?? new URL(request.url).host);
	if (isLocalLiveness(request, host)) return;
	if (!config.valid) throw new SecurityBoundaryError('SECURITY_CONFIGURATION_INVALID');
	if (host === null || !config.allowedHosts.includes(host)) {
		throw new SecurityBoundaryError('REQUEST_HOST_INVALID');
	}

	const origin = request.headers.get('origin');
	if (origin === null) return;
	const parsedOrigin = validHttpsOrigin(origin);
	if (parsedOrigin === null || parsedOrigin.origin !== config.productionOrigin.origin) {
		throw new SecurityBoundaryError('REQUEST_ORIGIN_INVALID');
	}
}

function mappedIpv4(canonicalIpv6: string): string | null {
	if (!canonicalIpv6.startsWith('::ffff:')) return null;
	const tail = canonicalIpv6.slice('::ffff:'.length).split(':');
	if (tail.length !== 2) return null;
	const high = Number.parseInt(tail[0], 16);
	const low = Number.parseInt(tail[1], 16);
	if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
	return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

export function normalizeClientAddress(value: string): string {
	let address = value.trim();
	if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
	if (isIP(address) === 4) return address;
	if (isIP(address) !== 6) throw new SecurityBoundaryError('CLIENT_ADDRESS_INVALID');

	try {
		const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
		return mappedIpv4(canonical) ?? canonical;
	} catch {
		throw new SecurityBoundaryError('CLIENT_ADDRESS_INVALID');
	}
}
