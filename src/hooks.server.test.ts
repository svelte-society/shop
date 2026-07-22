import { describe, expect, it, vi } from 'vitest';
import { createApplicationLifecycle, type ApplicationLifecycle } from '$lib/server/app.server';
import {
	applySecurityHeaders,
	createApplicationHandle,
	createComposedHandle,
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
			event: {
				url: new URL('https://shop.sveltesociety.dev/health/live'),
				request: { method: 'GET' }
			},
			resolve
		} as unknown as Parameters<typeof handle>[0]);

		expect(response).toBeInstanceOf(Response);
		expect(resolve).toHaveBeenCalledOnce();
		expect(application.start).not.toHaveBeenCalled();
	});

	it('does not grant the static liveness lifecycle bypass to other methods', async () => {
		const application: ApplicationLifecycle = {
			current: () => null,
			start: vi.fn(async () => null),
			stop: vi.fn(async () => undefined)
		};
		const handle = createApplicationHandle(application, {
			environment: {},
			building: false,
			test: false
		});
		const resolve = vi.fn(async () => new Response(null, { status: 405 }));

		const response = await handle({
			event: {
				url: new URL('https://shop.sveltesociety.dev/health/live'),
				request: { method: 'POST' }
			},
			resolve
		} as unknown as Parameters<typeof handle>[0]);

		expect(response.status).toBe(405);
		expect(application.start).toHaveBeenCalledOnce();
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
	PORT: '3000',
	MCP_ENABLED: 'true',
	MCP_BEARER_TOKEN: 'test-mcp-token',
	UMAMI_SCRIPT_URL: 'https://analytics.sveltesociety.dev/script.js',
	UMAMI_CONNECT_ORIGIN: 'https://analytics-api.sveltesociety.dev',
	CATALOG_IMAGE_ORIGINS:
		'https://images.stripe.com,https://cdn.sveltesociety.dev,http://unsafe.example,https://*.wild.example,not-a-url'
};

const WITHDRAWAL_RUNTIME_ENV = {
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	PLUNK_SECRET_KEY: 'sk_test_hooks',
	PLUNK_FROM_NAME: 'Svelte Society Shop',
	PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
	WITHDRAWAL_DATA_KEY: Buffer.alloc(32, 13).toString('base64'),
	SELLER_LEGAL_NAME: 'Svelte Society Merch AB',
	SELLER_REGISTRATION_NUMBER: '559999-0000',
	SELLER_VAT_NUMBER: 'SE559999000001',
	SELLER_ADDRESS_LINE1: 'Registered Street 1',
	SELLER_POSTAL_CODE: '111 11',
	SELLER_CITY: 'Stockholm',
	SELLER_COUNTRY: 'Sweden',
	SELLER_EMAIL: 'merch@sveltesociety.dev',
	DELIVERY_ESTIMATE_EU: '3–7 business days',
	DELIVERY_ESTIMATE_ASIA: '7–15 business days',
	POLICY_EFFECTIVE_DATE: '2026-07-17'
};

function cspSources(policy: string, directive: string): string[] {
	const section = policy
		.split(';')
		.map((candidate) => candidate.trim().split(/\s+/u))
		.find(([name]) => name === directive);

	return section?.slice(1) ?? [];
}

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
		routeId?: string | null;
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
		route: { id: options.routeId === undefined ? pathname : options.routeId },
		locals: {},
		getClientAddress: vi.fn(() => options.clientAddress ?? '192.0.2.10')
	};
}

describe('HTTP security hook', () => {
	it.each([
		['GET', '/withdraw'],
		['POST', '/withdraw?/review'],
		['GET', '/withdraw/receipt/WDR-AAAAAAAAAAAAAAAAAAAAAA']
	])(
		'adds private no-store and no-referrer to withdrawal %s responses',
		async (method, pathname) => {
			const handle = createSecurityHandle(SECURITY_ENV, { production: true, emit: vi.fn() });
			const event = securityEvent(pathname, { method, routeId: '/withdraw' });
			const response = await handle({
				event,
				resolve: async () => new Response('withdrawal')
			} as never);
			expect(response.headers.get('cache-control')).toBe('private, no-store');
			expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		}
	);
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

	it('alerts after repeated invalid MCP auth without forwarding request secrets or client data', async () => {
		const enqueueOperationalAlert = vi.fn();
		let current = Date.parse('2026-07-17T08:00:00.000Z');
		const handle = createSecurityHandle(SECURITY_ENV, {
			production: true,
			now: () => current,
			requestId: () => 'req_repeated_invalid_auth',
			emit: () => undefined,
			enqueueOperationalAlert
		});
		const resolve = vi.fn(async () => new Response('must not resolve'));

		for (let index = 0; index < 6; index += 1) {
			current += 60_000;
			const response = await handle({
				event: securityEvent('/mcp', {
					method: 'POST',
					authorization: `Bearer private-token-${index}`,
					sessionId: `private-session-${index}`,
					clientAddress: `192.0.2.${index + 1}`
				}),
				resolve
			} as unknown as Parameters<typeof handle>[0]);
			expect(response.status).toBe(401);
		}

		expect(enqueueOperationalAlert).toHaveBeenCalledOnce();
		expect(enqueueOperationalAlert).toHaveBeenCalledWith(
			'MCP_AUTH_REPEATED_FAILURE',
			'mcp-auth',
			new Date(current)
		);
		const observable = JSON.stringify(enqueueOperationalAlert.mock.calls);
		expect(observable).not.toContain('private-token');
		expect(observable).not.toContain('private-session');
		expect(observable).not.toContain('192.0.2.');
		expect(resolve).not.toHaveBeenCalled();
	});

	it('persists one safe alert from a composed cold process after liveness and six invalid MCP requests', async () => {
		const application = createApplicationLifecycle();
		const environment = {
			...SECURITY_ENV,
			...WITHDRAWAL_RUNTIME_ENV,
			DATABASE_PATH: ':memory:',
			DATABASE_BOOTSTRAP: 'true',
			SCHEDULER_ENABLED: 'false'
		};
		const handle = createComposedHandle(
			application,
			{ environment, building: false, test: false },
			{
				production: true,
				requestId: () => 'req_cold_mcp_auth',
				emit: () => undefined
			}
		);
		const resolve = vi.fn(async () => new Response('live'));

		try {
			const liveness = await handle({
				event: securityEvent('/health/live', { method: 'GET' }),
				resolve
			} as unknown as Parameters<typeof handle>[0]);
			expect(liveness.status).toBe(200);
			expect(application.current()).toBeNull();

			for (let index = 0; index < 6; index += 1) {
				const response = await handle({
					event: securityEvent('/mcp', {
						method: 'POST',
						authorization: `Bearer cold-private-token-${index}`,
						sessionId: `cold-private-session-${index}`,
						clientAddress: `192.0.2.${index + 20}`
					}),
					resolve
				} as unknown as Parameters<typeof handle>[0]);
				expect(response.status).toBe(401);
			}

			const runtime = application.current();
			expect(runtime).not.toBeNull();
			const rows = runtime?.database
				.prepare("SELECT * FROM outbox_jobs WHERE kind = 'operational-alert'")
				.all();
			expect(rows).toHaveLength(1);
			expect(rows?.[0]).toMatchObject({
				kind: 'operational-alert',
				alert_code: 'MCP_AUTH_REPEATED_FAILURE',
				alert_subject_id: 'mcp-auth'
			});
			const observable = JSON.stringify(rows);
			expect(observable).not.toContain('cold-private-token');
			expect(observable).not.toContain('cold-private-session');
			expect(observable).not.toContain('192.0.2.');
			expect(resolve).toHaveBeenCalledOnce();
		} finally {
			await application.stop();
		}
	});

	it('resets accumulated MCP failures after a valid bearer authentication', async () => {
		const enqueueOperationalAlert = vi.fn();
		let current = Date.parse('2026-07-17T08:00:00.000Z');
		const handle = createSecurityHandle(SECURITY_ENV, {
			production: true,
			now: () => current,
			requestId: () => 'req_auth_recovery',
			emit: () => undefined,
			enqueueOperationalAlert
		});
		const resolve = vi.fn(async () => new Response('ok'));

		for (let index = 0; index < 5; index += 1) {
			current += 60_000;
			await handle({
				event: securityEvent('/mcp', {
					method: 'POST',
					authorization: `Bearer private-before-recovery-${index}`
				}),
				resolve
			} as unknown as Parameters<typeof handle>[0]);
		}
		await handle({
			event: securityEvent('/mcp', {
				method: 'POST',
				authorization: 'Bearer test-mcp-token'
			}),
			resolve
		} as unknown as Parameters<typeof handle>[0]);
		current += 60_000;
		await handle({
			event: securityEvent('/mcp', {
				method: 'POST',
				authorization: 'Bearer private-after-recovery-0'
			}),
			resolve
		} as unknown as Parameters<typeof handle>[0]);
		expect(enqueueOperationalAlert).not.toHaveBeenCalled();

		for (let index = 1; index < 6; index += 1) {
			current += 60_000;
			await handle({
				event: securityEvent('/mcp', {
					method: 'POST',
					authorization: `Bearer private-after-recovery-${index}`
				}),
				resolve
			} as unknown as Parameters<typeof handle>[0]);
		}
		expect(enqueueOperationalAlert).toHaveBeenCalledOnce();
	});

	it.each([undefined, '', 'false', 'TRUE', 'True', '1', 'yes'])(
		'bypasses MCP auth, address, session, and rate work unless MCP_ENABLED is exactly true (%j)',
		async (enabled) => {
			const handle = createSecurityHandle(
				{ ...SECURITY_ENV, MCP_ENABLED: enabled },
				{
					production: true,
					now: () => 31_000,
					requestId: () => 'req_mcp_disabled',
					emit: () => undefined
				}
			);
			const event = securityEvent('/mcp', {
				method: 'POST',
				authorization: 'Bearer wrong-private-token',
				sessionId: 'private-session'
			});
			event.getClientAddress.mockImplementation(() => {
				throw new Error('must not inspect the client address');
			});
			const resolve = vi.fn(async () => new Response(null, { status: 404 }));

			const response = await handle({ event, resolve } as unknown as Parameters<typeof handle>[0]);

			expect(response.status).toBe(404);
			expect(resolve).toHaveBeenCalledOnce();
			expect(event.getClientAddress).not.toHaveBeenCalled();
		}
	);

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
			expect(cspSources(csp, 'script-src')).toEqual([
				"'self'",
				"'nonce-generated123'",
				'https://analytics.sveltesociety.dev'
			]);
			expect(cspSources(csp, 'connect-src')).toEqual([
				"'self'",
				'https://analytics-api.sveltesociety.dev'
			]);
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

	it('logs only the stable route template and sanitized unexpected failures', async () => {
		const emitted: Array<{ code: string; fields?: Record<string, unknown> }> = [];
		const handle = createSecurityHandle(SECURITY_ENV, {
			production: true,
			now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(108),
			requestId: () => 'req_query_safe',
			emit: (event) => emitted.push(event)
		});
		const event = securityEvent('/products/person%2540example.test', {
			routeId: '/products/[slug]',
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
					route: '/products/[slug]',
					status: 500,
					duration_ms: 8
				}
			}
		]);
		expect(JSON.stringify(emitted)).not.toContain('session_id');
		expect(JSON.stringify(emitted)).not.toContain('private');
		expect(JSON.stringify(emitted)).not.toContain('person');
	});
});

describe('handleError', () => {
	it('returns a stable public 500 and logs only the route template once', () => {
		const error = new Error('sk_live_private private@example.test');
		error.stack = 'private stack at /data/shop.sqlite';
		const event = securityEvent('/checkout/success/private%40example.test', {
			routeId: '/checkout/success/[session_id]',
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
		expect(consoleError).toHaveBeenCalledOnce();
		expect(serializedLogs).toContain('/checkout/success/[session_id]');
		expect(serializedLogs).not.toContain('cs_private');
		expect(serializedLogs).not.toContain('sk_live');
		expect(serializedLogs).not.toContain('example.test');
		expect(serializedLogs).not.toContain('/data/');
		consoleError.mockRestore();
	});

	it('returns a safe 404 without error telemetry', () => {
		const event = securityEvent('/private%40example.test', { routeId: null });
		event.locals = { requestId: 'req_not_found' };
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const result = handleError({
			error: new Error('private@example.test'),
			event,
			status: 404,
			message: 'private@example.test'
		} as unknown as Parameters<typeof handleError>[0]);

		expect(result).toEqual({ message: 'Not found', code: 'NOT_FOUND' });
		expect(consoleError).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it('does not duplicate the error request log after handleError records an unexpected 5xx', async () => {
		const emitted: Array<{ code: string }> = [];
		const handle = createSecurityHandle(SECURITY_ENV, {
			production: true,
			now: () => 1,
			requestId: () => 'req_one_error',
			emit: (event) => emitted.push(event)
		});
		const event = securityEvent('/products/private%40example.test', {
			routeId: '/products/[slug]'
		});
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const response = await handle({
			event,
			resolve: async () => {
				handleError({
					error: new Error('private@example.test'),
					event,
					status: 500,
					message: 'private@example.test'
				} as unknown as Parameters<typeof handleError>[0]);
				return new Response(null, { status: 500 });
			}
		} as unknown as Parameters<typeof handle>[0]);

		expect(response.status).toBe(500);
		expect(consoleError).toHaveBeenCalledOnce();
		expect(emitted).toEqual([]);
		consoleError.mockRestore();
	});
});
