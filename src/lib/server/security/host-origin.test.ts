import { describe, expect, it } from 'vitest';
import {
	SecurityBoundaryError,
	createSecurityConfig,
	normalizeClientAddress,
	validateHostAndOrigin,
	type SecurityConfig
} from './host-origin.server';

const config: SecurityConfig = {
	production: true,
	productionOrigin: new URL('https://shop.sveltesociety.dev'),
	allowedHosts: ['shop.sveltesociety.dev'],
	valid: true
};

function request(
	pathname: string,
	options: { host?: string; origin?: string | null; protocol?: 'http:' | 'https:' } = {}
): Request {
	const protocol = options.protocol ?? 'https:';
	const headers = new Headers({ host: options.host ?? 'shop.sveltesociety.dev' });
	if (options.origin !== null) {
		headers.set('origin', options.origin ?? 'https://shop.sveltesociety.dev');
	}
	return new Request(`${protocol}//shop.sveltesociety.dev${pathname}`, {
		headers
	});
}

function expectBoundaryError(action: () => void, code: string) {
	try {
		action();
		expect.unreachable('Expected a security boundary error');
	} catch (error) {
		expect(error).toBeInstanceOf(SecurityBoundaryError);
		expect((error as SecurityBoundaryError).code).toBe(code);
	}
}

describe('validateHostAndOrigin', () => {
	it.each(['shop.sveltesociety.dev', 'SHOP.SVELTESOCIETY.DEV', 'shop.sveltesociety.dev:443'])(
		'allows the configured production Host %s',
		(host) => {
			expect(() => validateHostAndOrigin(request('/', { host }), config)).not.toThrow();
		}
	);

	it.each([
		'attacker.example',
		'shop.sveltesociety.dev.attacker.example',
		'shop.sveltesociety.dev@attacker.example',
		'shop.sveltesociety.dev,attacker.example'
	])('rejects the unconfigured Host %s', (host) => {
		expectBoundaryError(
			() => validateHostAndOrigin(request('/', { host }), config),
			'REQUEST_HOST_INVALID'
		);
	});

	it('allows the exact configured browser Origin', () => {
		expect(() =>
			validateHostAndOrigin(
				request('/checkout', { origin: 'https://shop.sveltesociety.dev' }),
				config
			)
		).not.toThrow();
	});

	it.each([
		'http://shop.sveltesociety.dev',
		'https://attacker.example',
		'https://shop.sveltesociety.dev.attacker.example',
		'https://shop.sveltesociety.dev@attacker.example'
	])('rejects the unconfigured browser Origin %s', (origin) => {
		expectBoundaryError(
			() => validateHostAndOrigin(request('/checkout', { origin }), config),
			'REQUEST_ORIGIN_INVALID'
		);
	});

	it.each(['/webhooks/stripe', '/mcp'])(
		'allows a server-to-server %s request without Origin',
		(pathname) => {
			expect(() =>
				validateHostAndOrigin(request(pathname, { origin: null }), config)
			).not.toThrow();
		}
	);

	it('allows only local liveness through the container loopback Host', () => {
		expect(() =>
			validateHostAndOrigin(
				request('/health/live', {
					host: '127.0.0.1:3000',
					origin: null,
					protocol: 'http:'
				}),
				config
			)
		).not.toThrow();
		expectBoundaryError(
			() =>
				validateHostAndOrigin(
					request('/health/ready', {
						host: '127.0.0.1:3000',
						origin: null,
						protocol: 'http:'
					}),
					config
				),
			'REQUEST_HOST_INVALID'
		);
	});

	it('fails closed on invalid production security configuration except local liveness', () => {
		const invalid = createSecurityConfig(
			{ PRODUCTION_ORIGIN: 'javascript:alert(1)', HOST_ALLOWLIST: 'attacker.example' },
			true
		);
		expectBoundaryError(
			() => validateHostAndOrigin(request('/', { origin: null }), invalid),
			'SECURITY_CONFIGURATION_INVALID'
		);
		expect(() =>
			validateHostAndOrigin(
				request('/health/live', {
					host: '127.0.0.1:3000',
					origin: null,
					protocol: 'http:'
				}),
				invalid
			)
		).not.toThrow();
	});

	it('rejects wildcard production origins and ignores wildcard Host allowlist entries', () => {
		const wildcardOrigin = createSecurityConfig(
			{ PRODUCTION_ORIGIN: 'https://*.sveltesociety.dev' },
			true
		);
		const wildcardHost = createSecurityConfig(
			{
				PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
				HOST_ALLOWLIST: '*.sveltesociety.dev'
			},
			true
		);

		expect(wildcardOrigin.valid).toBe(false);
		expect(wildcardHost.allowedHosts).toEqual(['shop.sveltesociety.dev']);
		expectBoundaryError(
			() =>
				validateHostAndOrigin(
					request('/', { host: '*.sveltesociety.dev', origin: null }),
					wildcardHost
				),
			'REQUEST_HOST_INVALID'
		);
	});
});

describe('normalizeClientAddress', () => {
	it.each([
		['192.0.2.42', '192.0.2.42'],
		['::ffff:192.0.2.42', '192.0.2.42'],
		['0:0:0:0:0:ffff:c000:022a', '192.0.2.42'],
		['2001:0DB8:0000:0000:0000:ff00:0042:8329', '2001:db8::ff00:42:8329'],
		['[2001:db8::1]', '2001:db8::1'],
		['::1', '::1']
	])('canonicalizes %s as %s', (input, expected) => {
		expect(normalizeClientAddress(input)).toBe(expected);
	});

	it.each(['', 'unknown', '192.0.2.42, 198.51.100.1', '192.0.2.42:8080', 'fe80::1%eth0'])(
		'fails closed for the invalid address %j',
		(address) => {
			expectBoundaryError(() => normalizeClientAddress(address), 'CLIENT_ADDRESS_INVALID');
		}
	);
});
