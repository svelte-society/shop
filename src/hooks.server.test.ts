import { describe, expect, it, vi } from 'vitest';
import type { ApplicationLifecycle } from '$lib/server/app.server';
import {
	applySecurityHeaders,
	createApplicationHandle,
	createSecurityHandle,
	handleError
} from './hooks.server';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe('server application hook', () => {
	it('serves static liveness without starting the database lifecycle', async () => {
		const application: ApplicationLifecycle = {
			current: () => null,
			start: vi.fn(),
			stop: vi.fn(async () => undefined)
		};
		const handle = createApplicationHandle(application, {
			environment: {},
			building: false,
			test: false
		});
		const resolve = vi.fn(async () => new Response('live'));

		const response = await handle({
			event: { url: new URL('https://shop.sveltesociety.dev/health/live') },
			resolve
		} as unknown as Parameters<typeof handle>[0]);

		expect(response).toBeInstanceOf(Response);
		expect(resolve).toHaveBeenCalledOnce();
		expect(application.start).not.toHaveBeenCalled();
	});

	it('starts the application once before resolving repeated requests', async () => {
		const order: string[] = [];
		const ready = deferred<null>();
		const application: ApplicationLifecycle = {
			current: () => null,
			start: vi.fn(() => {
				order.push('application-start');
				return ready.promise;
			}),
			stop: vi.fn(async () => undefined)
		};
		const handle = createApplicationHandle(application, {
			environment: {},
			building: false,
			test: true
		});
		const resolve = vi.fn(async () => {
			order.push('resolve');
			return new Response('ok');
		});
		const input = { event: {}, resolve } as unknown as Parameters<typeof handle>[0];

		const firstRequest = handle(input);
		await Promise.resolve();
		expect(resolve).not.toHaveBeenCalled();
		ready.resolve(null);
		await expect(firstRequest).resolves.toBeInstanceOf(Response);
		await expect(handle(input)).resolves.toBeInstanceOf(Response);

		expect(application.start).toHaveBeenCalledOnce();
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(order).toEqual(['application-start', 'resolve', 'resolve']);
	});

	it('keeps local-independent routes available when startup readiness fails and retries later', async () => {
		const application: ApplicationLifecycle = {
			current: () => null,
			start: vi
				.fn<ApplicationLifecycle['start']>()
				.mockRejectedValueOnce(new Error('STARTUP_NOT_READY'))
				.mockResolvedValue(null),
			stop: vi.fn(async () => undefined)
		};
		const handle = createApplicationHandle(application, {
			environment: {},
			building: false,
			test: false
		});
		const resolve = vi.fn(async () => new Response('ok'));
		const input = { event: {}, resolve } as unknown as Parameters<typeof handle>[0];

		await expect(handle(input)).resolves.toBeInstanceOf(Response);
		expect(resolve).toHaveBeenCalledOnce();
		await expect(handle(input)).resolves.toBeInstanceOf(Response);

		expect(application.start).toHaveBeenCalledTimes(2);
		expect(resolve).toHaveBeenCalledTimes(2);
	});
});

const SECURITY_ENV = {
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	HOST_ALLOWLIST: 'shop.sveltesociety.dev',
	MCP_ENABLED: 'true',
	MCP_BEARER_TOKEN: 'test-mcp-token',
	UMAMI_SCRIPT_URL: 'https://analytics.sveltesociety.dev/script.js',
	UMAMI_CONNECT_ORIGIN: 'https://analytics-api.sveltesociety.dev',
	CATALOG_IMAGE_ORIGINS:
		'https://images.stripe.com,https://cdn.sveltesociety.dev,http://unsafe.example,https://*.wild.example,not-a-url'
};

function securityEvent(
	pathname: string,
	options: {
		method?: string;
		origin?: string | null;
		authorization?: string;
		sessionId?: string;
		clientAddress?: string;
		query?: string;
		host?: string;
	} = {}
) {
	const host = options.host ?? 'shop.sveltesociety.dev';
	const headers = new Headers({ host, 'x-forwarded-for': '203.0.113.250, 198.51.100.250' });
	if (options.origin !== null) {
		headers.set('origin', options.origin ?? 'https://shop.sveltesociety.dev');
	}
	if (options.authorization) headers.set('authorization', options.authorization);
	if (options.sessionId) headers.set('mcp-session-id', options.sessionId);
	const url = new URL(`https://${host}${pathname}${options.query ?? ''}`);
	const request = new Request(url, { method: options.method ?? 'GET', headers });
	return {
		request,
		url,
		locals: {},
		getClientAddress: vi.fn(() => options.clientAddress ?? '192.0.2.10')
	};
}

describe('HTTP security hook', () => {
	it('uses only SvelteKit getClientAddress for direct and adapter-provided proxy addresses', async () => {
		const emitted: unknown[] = [];
		const handle = createSecurityHandle(SECURITY_ENV, {
			production: true,
			now: () => 1,
			requestId: () => 'req_address',
			emit: (event) => emitted.push(event)
		});
		const direct = securityEvent('/checkout', {
			method: 'POST',
			clientAddress: '192.0.2.1'
		});
		const proxied = securityEvent('/checkout', {
			method: 'POST',
			clientAddress: '::ffff:192.0.2.2'
		});
		const resolve = vi.fn(async () => new Response('ok'));

		await handle({ event: direct, resolve } as unknown as Parameters<typeof handle>[0]);
		await handle({ event: proxied, resolve } as unknown as Parameters<typeof handle>[0]);

		expect(direct.getClientAddress).toHaveBeenCalledOnce();
		expect(proxied.getClientAddress).toHaveBeenCalledOnce();
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(emitted)).not.toContain('203.0.113.250');
		expect(JSON.stringify(emitted)).not.toContain('198.51.100.250');
	});

	it.each([
		['checkout', '/checkout', 'POST', 10],
		['webhook', '/webhooks/stripe', 'POST', 120],
		['MCP', '/mcp', 'POST', 60]
	] as const)(
		'enforces the %s route limit per normalized IP',
		async (_label, pathname, method, limit) => {
			const handle = createSecurityHandle(SECURITY_ENV, {
				production: true,
				now: () => 20_000,
				requestId: () => 'req_limit',
				emit: () => undefined
			});
			const resolve = vi.fn(async () => new Response('ok'));

			for (let index = 0; index < limit; index += 1) {
				const event = securityEvent(pathname, {
					method,
					authorization: pathname === '/mcp' ? 'Bearer test-mcp-token' : undefined
				});
				const response = await handle({ event, resolve } as unknown as Parameters<
					typeof handle
				>[0]);
				expect(response.status).toBe(200);
			}
			const blocked = await handle({
				event: securityEvent(pathname, {
					method,
					authorization: pathname === '/mcp' ? 'Bearer test-mcp-token' : undefined
				}),
				resolve
			} as unknown as Parameters<typeof handle>[0]);

			expect(blocked.status).toBe(429);
			expect(blocked.headers.get('content-type')).toBe('application/problem+json');
			await expect(blocked.json()).resolves.toEqual({
				type: 'about:blank',
				title: 'Too many requests',
				status: 429,
				code: 'RATE_LIMITED'
			});
		}
	);

	it('counts rejected MCP auth independently before the general limit and ignores sessions', async () => {
		const handle = createSecurityHandle(SECURITY_ENV, {
			production: true,
			now: () => 30_000,
			requestId: () => 'req_invalid_auth',
			emit: () => undefined
		});
		const resolve = vi.fn(async ({ request }) =>
			request.headers.get('authorization') === 'Bearer test-mcp-token'
				? new Response('ok')
				: new Response(null, { status: 401 })
		);

		for (let index = 0; index < 10; index += 1) {
			const response = await handle({
				event: securityEvent('/mcp', {
					method: 'POST',
					authorization: 'Bearer wrong-private-token',
					sessionId: `session-${index}`
				}),
				resolve
			} as unknown as Parameters<typeof handle>[0]);
			expect(response.status).toBe(401);
			expect(response.headers.get('www-authenticate')).toBe('Bearer');
			expect(response.headers.get('cache-control')).toBe('no-store');
		}

		const blocked = await handle({
			event: securityEvent('/mcp', {
				method: 'POST',
				authorization: 'Bearer another-private-token',
				sessionId: 'fresh-session'
			}),
			resolve
		} as unknown as Parameters<typeof handle>[0]);
		const valid = await handle({
			event: securityEvent('/mcp', {
				method: 'POST',
				authorization: 'Bearer test-mcp-token'
			}),
			resolve
		} as unknown as Parameters<typeof handle>[0]);

		expect(blocked.status).toBe(429);
		expect(valid.status).toBe(200);
		expect(resolve).toHaveBeenCalledOnce();
		expect(await blocked.text()).not.toContain('private-token');
	});

	it('fails closed when the adapter cannot provide a valid client address', async () => {
		const handle = createSecurityHandle(SECURITY_ENV, {
			production: true,
			now: () => 1,
			requestId: () => 'req_bad_address',
			emit: () => undefined
		});
		const event = securityEvent('/checkout', { method: 'POST' });
		event.getClientAddress.mockImplementation(() => {
			throw new Error('adapter address unavailable');
		});
		const resolve = vi.fn(async () => new Response('should not resolve'));

		const response = await handle({ event, resolve } as unknown as Parameters<typeof handle>[0]);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({ code: 'CLIENT_ADDRESS_INVALID' });
		expect(resolve).not.toHaveBeenCalled();
	});

	it('returns stable Host and Origin problems before application resolution', async () => {
		const handle = createSecurityHandle(SECURITY_ENV, {
			production: true,
			requestId: () => 'req_boundary',
			emit: () => undefined
		});
		const resolve = vi.fn(async () => new Response('should not resolve'));
		const badHost = securityEvent('/', { host: 'attacker.example', origin: null });
		const badOrigin = securityEvent('/checkout', {
			method: 'POST',
			origin: 'https://attacker.example'
		});

		const hostResponse = await handle({ event: badHost, resolve } as unknown as Parameters<
			typeof handle
		>[0]);
		const originResponse = await handle({ event: badOrigin, resolve } as unknown as Parameters<
			typeof handle
		>[0]);

		expect(hostResponse.status).toBe(400);
		await expect(hostResponse.json()).resolves.toMatchObject({ code: 'REQUEST_HOST_INVALID' });
		expect(originResponse.status).toBe(403);
		await expect(originResponse.json()).resolves.toMatchObject({ code: 'REQUEST_ORIGIN_INVALID' });
		expect(resolve).not.toHaveBeenCalled();
	});

	it('adds security headers and a nonce-preserving CSP to success, error, health, MCP, and webhook responses', async () => {
		const paths = ['/', '/missing', '/health/live', '/mcp', '/webhooks/stripe'];
		for (const [index, pathname] of paths.entries()) {
			const original = new Response(pathname, {
				status: index === 1 ? 500 : 200,
				headers: {
					'content-security-policy':
						"default-src 'self'; script-src 'self' 'nonce-generated123'; style-src 'self' 'nonce-generated123'; frame-ancestors 'none'"
				}
			});
			const response = applySecurityHeaders(original, SECURITY_ENV, true);
			const csp = response.headers.get('content-security-policy') ?? '';

			expect(response.headers.get('strict-transport-security')).toBe(
				'max-age=31536000; includeSubDomains'
			);
			expect(response.headers.get('x-content-type-options')).toBe('nosniff');
			expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
			expect(response.headers.get('permissions-policy')).toContain('camera=()');
			expect(csp).toContain(
				"script-src 'self' 'nonce-generated123' https://analytics.sveltesociety.dev"
			);
			expect(csp).toContain('connect-src');
			expect(csp).toContain('https://analytics-api.sveltesociety.dev');
			expect(csp).toContain('https://images.stripe.com');
			expect(csp).toContain('https://cdn.sveltesociety.dev');
			expect(csp).not.toContain('http://unsafe.example');
			expect(csp).not.toContain('wild.example');
			expect(csp).not.toContain('checkout.stripe.com');
			expect(csp).not.toContain('unsafe-inline');
			expect(csp).toContain("frame-ancestors 'none'");
		}
	});

	it('omits HSTS outside production while retaining the other headers', () => {
		const response = applySecurityHeaders(new Response('ok'), SECURITY_ENV, false);

		expect(response.headers.get('strict-transport-security')).toBeNull();
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline');
	});

	it('ignores wildcard, credentialed, and malformed Umami origins', () => {
		const response = applySecurityHeaders(
			new Response('ok'),
			{
				UMAMI_SCRIPT_URL: 'https://*.analytics.example/script.js',
				UMAMI_CONNECT_ORIGIN: 'https://user:password@analytics.example'
			},
			true
		);
		const csp = response.headers.get('content-security-policy') ?? '';

		expect(csp).not.toContain('analytics.example');
		expect(csp).not.toContain('*');
		expect(csp).not.toContain('user');
		expect(csp).not.toContain('password');
	});

	it('keeps only SvelteKit nonces from an existing CSP and replaces unsafe route directives', () => {
		const response = applySecurityHeaders(
			new Response('ok', {
				headers: {
					'content-security-policy':
						"script-src 'unsafe-inline' https://attacker.example 'nonce-generated123'; style-src 'unsafe-inline' 'nonce-generated123'; frame-src https://checkout.stripe.com"
				}
			}),
			SECURITY_ENV,
			true
		);
		const csp = response.headers.get('content-security-policy') ?? '';

		expect(csp).toContain("script-src 'self' 'nonce-generated123'");
		expect(csp).toContain("style-src 'self' 'nonce-generated123'");
		expect(csp).toContain("frame-src 'none'");
		expect(csp).not.toContain('unsafe-inline');
		expect(csp).not.toContain('attacker.example');
		expect(csp).not.toContain('checkout.stripe.com');
	});

	it('keeps SvelteKit dev inline styles only outside production while still rejecting inline scripts', () => {
		const response = applySecurityHeaders(
			new Response('ok', {
				headers: {
					'content-security-policy':
						"script-src 'self' 'unsafe-inline' 'nonce-generated123'; style-src 'self' 'unsafe-inline'"
				}
			}),
			SECURITY_ENV,
			false
		);
		const csp = response.headers.get('content-security-policy') ?? '';

		expect(csp).toContain("script-src 'self' 'nonce-generated123'");
		expect(csp).toContain("style-src 'self' 'unsafe-inline'");
		expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
	});

	it('logs request results with pathname only and sanitized unexpected failures', async () => {
		const emitted: Array<{ code: string; fields?: Record<string, unknown> }> = [];
		const handle = createSecurityHandle(SECURITY_ENV, {
			production: true,
			now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(108),
			requestId: () => 'req_query_safe',
			emit: (event) => emitted.push(event)
		});
		const event = securityEvent('/checkout/success', {
			query: '?session_id=cs_private&email=private%40example.test'
		});

		const response = await handle({
			event,
			resolve: async () => {
				throw new Error('sk_live_private /data/shop.sqlite');
			}
		} as unknown as Parameters<typeof handle>[0]);

		expect(response.status).toBe(500);
		expect(response.headers.get('x-request-id')).toBe('req_query_safe');
		expect(emitted).toEqual([
			{
				level: 'error',
				code: 'HTTP_REQUEST_FAILED',
				fields: {
					request_id: 'req_query_safe',
					method: 'GET',
					pathname: '/checkout/success',
					status: 500,
					duration_ms: 8
				}
			}
		]);
		expect(JSON.stringify(emitted)).not.toContain('session_id');
		expect(JSON.stringify(emitted)).not.toContain('private');
	});
});

describe('handleError', () => {
	it('returns a stable public error and never logs query, stack, secret, or PII', () => {
		const error = new Error('sk_live_private private@example.test');
		error.stack = 'private stack at /data/shop.sqlite';
		const event = securityEvent('/checkout/success', {
			query: '?session_id=cs_private&email=private%40example.test'
		});
		event.locals = { requestId: 'req_handle_error' };
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const result = handleError({
			error,
			event,
			status: 500,
			message: 'Internal Error'
		} as unknown as Parameters<typeof handleError>[0]);
		const serializedLogs = JSON.stringify(consoleError.mock.calls);

		expect(result).toEqual({ message: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
		expect(serializedLogs).toContain('/checkout/success');
		expect(serializedLogs).not.toContain('session_id');
		expect(serializedLogs).not.toContain('sk_live');
		expect(serializedLogs).not.toContain('example.test');
		expect(serializedLogs).not.toContain('/data/');
		consoleError.mockRestore();
	});
});
