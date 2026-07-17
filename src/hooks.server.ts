import { building } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import {
	applicationLifecycle,
	type ApplicationLifecycle,
	type ApplicationStartOptions
} from '$lib/server/app.server';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import { log, type LogEvent } from '$lib/server/logging/logger.server';
import { authorizeBearer, createMcpAuthFailureMonitor } from '$lib/server/mcp/auth.server';
import {
	enqueueAlert,
	SqliteAlertService,
	type AlertCode
} from '$lib/server/monitoring/alerts.server';
import {
	SecurityBoundaryError,
	createSecurityConfig,
	normalizeClientAddress,
	validateHostAndOrigin
} from '$lib/server/security/host-origin.server';
import {
	createFixedWindowRateLimiter,
	rateLimitPolicies,
	type RateLimitPolicy
} from '$lib/server/security/rate-limit.server';

type RuntimeEnvironment = Record<string, string | undefined>;

const baselineCsp: Readonly<Record<string, readonly string[]>> = Object.freeze({
	'default-src': Object.freeze(["'self'"]),
	'base-uri': Object.freeze(["'self'"]),
	'connect-src': Object.freeze(["'self'"]),
	'font-src': Object.freeze(["'self'"]),
	'form-action': Object.freeze(["'self'"]),
	'frame-ancestors': Object.freeze(["'none'"]),
	'frame-src': Object.freeze(["'none'"]),
	'img-src': Object.freeze(["'self'"]),
	'manifest-src': Object.freeze(["'self'"]),
	'media-src': Object.freeze(["'self'"]),
	'object-src': Object.freeze(["'none'"]),
	'script-src': Object.freeze(["'self'"]),
	'style-src': Object.freeze(["'self'"]),
	'worker-src': Object.freeze(["'self'"])
});

function exactHttpsOrigin(value: string): string | null {
	if (value.length === 0 || value !== value.trim()) return null;
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
		return parsed.origin;
	} catch {
		return null;
	}
}

function httpsScriptOrigin(value: string | undefined): string | null {
	if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null;
	try {
		const parsed = new URL(value);
		if (
			parsed.protocol !== 'https:' ||
			parsed.username ||
			parsed.password ||
			parsed.hostname.includes('*') ||
			parsed.hash
		) {
			return null;
		}
		return parsed.origin;
	} catch {
		return null;
	}
}

function configuredOrigins(value: string | undefined): string[] {
	if (typeof value !== 'string') return [];
	return [
		...new Set(
			value
				.split(',')
				.map((entry) => exactHttpsOrigin(entry.trim()))
				.filter((entry): entry is string => entry !== null)
		)
	];
}

function parseCsp(
	value: string | null,
	allowDevelopmentInlineStyles: boolean
): Map<string, string[]> {
	const directives = new Map(
		Object.entries(baselineCsp).map(([name, sources]) => [name, [...sources]])
	);
	if (value !== null) {
		for (const section of value.split(';')) {
			const tokens = section.trim().split(/\s+/u).filter(Boolean);
			const name = tokens.shift()?.toLowerCase();
			if (name !== 'script-src' && name !== 'style-src') continue;
			const generatedTokens = tokens.filter((token) =>
				/^'(?:nonce-[A-Za-z0-9+/_=-]+|sha(?:256|384|512)-[A-Za-z0-9+/=]+)'$/u.test(token)
			);
			if (
				allowDevelopmentInlineStyles &&
				name === 'style-src' &&
				tokens.includes("'unsafe-inline'")
			) {
				generatedTokens.push("'unsafe-inline'");
			}
			addCspSources(directives, name, generatedTokens);
		}
	}
	return directives;
}

function addCspSources(directives: Map<string, string[]>, name: string, sources: string[]): void {
	const current = directives.get(name) ?? [];
	for (const source of sources) {
		if (!current.includes(source)) current.push(source);
	}
	directives.set(name, current);
}

function contentSecurityPolicy(
	existing: string | null,
	environment: RuntimeEnvironment,
	production: boolean
): string {
	const directives = parseCsp(existing, !production);
	const umamiScript = httpsScriptOrigin(environment.UMAMI_SCRIPT_URL);
	const umamiConnect = exactHttpsOrigin(environment.UMAMI_CONNECT_ORIGIN?.trim() ?? '');
	const catalogImages = configuredOrigins(environment.CATALOG_IMAGE_ORIGINS);
	const societyAssets = configuredOrigins(environment.SOCIETY_ASSET_ORIGINS);

	if (umamiScript) addCspSources(directives, 'script-src', [umamiScript]);
	addCspSources(directives, 'connect-src', [
		...(umamiConnect ? [umamiConnect] : []),
		...(umamiScript && !umamiConnect ? [umamiScript] : [])
	]);
	addCspSources(directives, 'img-src', [...societyAssets, ...catalogImages]);
	addCspSources(directives, 'font-src', societyAssets);

	return [...directives]
		.map(([name, sources]) => `${name}${sources.length > 0 ? ` ${sources.join(' ')}` : ''}`)
		.join('; ');
}

export function applySecurityHeaders(
	response: Response,
	environment: RuntimeEnvironment,
	production: boolean
): Response {
	const headers = new Headers(response.headers);
	if (production) {
		headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
	} else {
		headers.delete('strict-transport-security');
	}
	headers.set('x-content-type-options', 'nosniff');
	headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	headers.set(
		'permissions-policy',
		'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), publickey-credentials-get=(), usb=()'
	);
	headers.set('x-frame-options', 'DENY');
	headers.set(
		'content-security-policy',
		contentSecurityPolicy(headers.get('content-security-policy'), environment, production)
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

function problem(status: number, title: string, code: string): Response {
	return new Response(JSON.stringify({ type: 'about:blank', title, status, code }), {
		status,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'application/problem+json'
		}
	});
}

function rateLimitProblem(policy: RateLimitPolicy): Response {
	const response = problem(429, 'Too many requests', 'RATE_LIMITED');
	response.headers.set('retry-after', String(Math.ceil(policy.windowMs / 1_000)));
	return response;
}

function routeTemplate(routeId: string | null | undefined): string {
	return typeof routeId === 'string' && /^\/[A-Za-z0-9_./()[\]+=-]{0,255}$/u.test(routeId)
		? routeId
		: 'unmatched';
}

type SecurityHandleOptions = {
	production?: boolean;
	now?: () => number;
	requestId?: () => string;
	emit?: (event: LogEvent) => void;
	enqueueOperationalAlert?: (code: AlertCode, subjectId: string, now: Date) => void | Promise<void>;
};

export function createSecurityHandle(
	environment: RuntimeEnvironment,
	options: SecurityHandleOptions = {}
): Handle {
	const production = options.production ?? process.env.NODE_ENV === 'production';
	const securityConfig = createSecurityConfig(environment, production);
	const limiter = createFixedWindowRateLimiter();
	const now = options.now ?? Date.now;
	const requestId = options.requestId ?? (() => crypto.randomUUID());
	const emit = options.emit ?? log;
	const enqueueOperationalAlert = options.enqueueOperationalAlert ?? enqueueAlert;
	const mcpAuthFailures = createMcpAuthFailureMonitor({
		async onRepeatedFailure(observedAt) {
			await enqueueOperationalAlert('MCP_AUTH_REPEATED_FAILURE', 'mcp-auth', observedAt);
		}
	});

	return async ({ event, resolve }) => {
		const startedAt = now();
		const id = requestId();
		event.locals.requestId = id;
		let response: Response;

		try {
			if (production) validateHostAndOrigin(event.request, securityConfig);

			const pathname = event.url.pathname;
			let policy: RateLimitPolicy | null = null;
			let keyPrefix = '';
			let rejectMcpAuth = false;
			if (pathname === '/checkout' && event.request.method === 'POST') {
				policy = rateLimitPolicies.checkout;
				keyPrefix = 'checkout';
			} else if (pathname === '/webhooks/stripe' && event.request.method === 'POST') {
				policy = rateLimitPolicies.webhook;
				keyPrefix = 'webhook';
			} else if (pathname === '/mcp' && environment.MCP_ENABLED === 'true') {
				const authorized = authorizeBearer(
					event.request.headers.get('authorization'),
					environment.MCP_BEARER_TOKEN ?? ''
				);
				policy = authorized ? rateLimitPolicies.mcp : rateLimitPolicies.invalidMcpAuth;
				keyPrefix = authorized ? 'mcp' : 'mcp-invalid-auth';
				rejectMcpAuth = !authorized;
				if (rejectMcpAuth) await mcpAuthFailures.record(new Date(startedAt));
				else mcpAuthFailures.reset();
			}

			if (policy !== null) {
				let address: string;
				try {
					address = normalizeClientAddress(event.getClientAddress());
				} catch {
					throw new SecurityBoundaryError('CLIENT_ADDRESS_INVALID');
				}
				if (!limiter.take(`${keyPrefix}:${address}`, policy, startedAt)) {
					response = rateLimitProblem(policy);
				} else if (rejectMcpAuth) {
					response = new Response(null, {
						status: 401,
						headers: {
							'cache-control': 'no-store',
							'www-authenticate': 'Bearer'
						}
					});
				} else {
					response = await resolve(event);
				}
			} else {
				response = await resolve(event);
			}
		} catch (error) {
			if (error instanceof SecurityBoundaryError) {
				response = problem(
					error.status,
					error.code === 'REQUEST_ORIGIN_INVALID' ? 'Forbidden' : 'Invalid request',
					error.code
				);
			} else {
				response = problem(500, 'Internal server error', 'INTERNAL_SERVER_ERROR');
			}
		}

		response = applySecurityHeaders(response, environment, production);
		response.headers.set('x-request-id', id);
		const duration = Math.max(0, Math.round(now() - startedAt));
		const code =
			response.status >= 500
				? 'HTTP_REQUEST_FAILED'
				: response.status >= 400
					? 'HTTP_REQUEST_REJECTED'
					: 'HTTP_REQUEST_COMPLETED';
		try {
			if (!event.locals.unexpectedErrorLogged)
				emit({
					level: response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info',
					code,
					fields: {
						request_id: id,
						method: event.request.method,
						route: routeTemplate(event.route.id),
						status: response.status,
						duration_ms: duration
					}
				});
		} catch {
			// Logging cannot change the HTTP result.
		}
		return response;
	};
}

export function createApplicationHandle(
	application: ApplicationLifecycle,
	options: ApplicationStartOptions
): Handle {
	let started = false;
	let startup: ReturnType<ApplicationLifecycle['start']> | undefined;

	return async ({ event, resolve }) => {
		if (event.url?.pathname === '/health/live' && event.request.method === 'GET') {
			return resolve(event);
		}

		if (!started) {
			const activeStartup = (startup ??= application.start(options));
			try {
				await activeStartup;
				started = true;
			} catch {
				if (startup === activeStartup) startup = undefined;
				return resolve(event);
			}
		}
		return resolve(event);
	};
}

type ComposedHandleOptions = Omit<SecurityHandleOptions, 'enqueueOperationalAlert'>;

export function createComposedHandle(
	application: ApplicationLifecycle,
	options: ApplicationStartOptions,
	securityOptions: ComposedHandleOptions = {}
): Handle {
	const applicationHandle = createApplicationHandle(application, options);
	const securityHandle = createSecurityHandle(options.environment, {
		...securityOptions,
		async enqueueOperationalAlert(code, subjectId, observedAt) {
			const runtime = await application.start(options);
			if (!runtime) throw new Error('APPLICATION_RUNTIME_UNAVAILABLE');
			new SqliteAlertService(new SqliteOutboxRepository(runtime.database)).enqueueAlert(
				code,
				subjectId,
				observedAt
			);
		}
	});
	return ({ event, resolve }) =>
		securityHandle({
			event,
			resolve: (securedEvent) => applicationHandle({ event: securedEvent, resolve })
		});
}

const applicationOptions: ApplicationStartOptions = {
	environment: env,
	building,
	test: process.env.NODE_ENV === 'test'
};

export const handle: Handle = createComposedHandle(applicationLifecycle, applicationOptions, {
	production: process.env.NODE_ENV === 'production' && !building
});

export const handleError: HandleServerError = ({ event, status }) => {
	if (status >= 500) {
		event.locals.unexpectedErrorLogged = true;
		log({
			level: 'error',
			code: 'HTTP_UNEXPECTED_ERROR',
			fields: {
				request_id: event.locals.requestId ?? 'request_unavailable',
				method: event.request.method,
				route: routeTemplate(event.route.id),
				status
			}
		});
		return { message: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' };
	}
	if (status === 404) return { message: 'Not found', code: 'NOT_FOUND' };
	return { message: 'Request failed', code: 'REQUEST_FAILED' };
};
