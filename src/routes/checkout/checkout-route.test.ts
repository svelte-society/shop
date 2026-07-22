import { describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CheckoutService } from '$lib/server/checkout/service.server';
import { CheckoutError } from '$lib/server/checkout/service.server';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { migrate } from '$lib/server/db/migrate.server';
import { createReadinessChecker } from '$lib/server/health/readiness.server';
import type { Scheduler } from '$lib/server/jobs/scheduler.server';
import { _createCheckoutPost } from './+server';

const BASE_ENV = {
	STOREFRONT_ENABLED: 'true',
	CHECKOUT_ENABLED: 'true',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	STRIPE_SECRET_KEY: 'sk_test_route',
	STRIPE_WEBHOOK_SECRET: 'whsec_test_route',
	STRIPE_PAID_SHIPPING_RATE_ID: 'shr_paid',
	STRIPE_FREE_SHIPPING_RATE_ID: 'shr_free',
	DATABASE_PATH: ':memory:'
};

function request(
	options: {
		body?: string;
		contentType?: string | null;
		origin?: string | null;
	} = {}
): Request {
	const headers = new Headers();
	if (options.contentType !== null) {
		headers.set('content-type', options.contentType ?? 'application/json');
	}
	if (options.origin !== null) {
		headers.set('origin', options.origin ?? 'https://shop.sveltesociety.dev');
	}

	return new Request('https://shop.sveltesociety.dev/checkout', {
		method: 'POST',
		headers,
		body: options.body ?? JSON.stringify([{ priceId: 'price_tee_m', quantity: 1 }])
	});
}

async function responseBody(response: Response): Promise<unknown> {
	return response.json();
}

function routeFixture(
	options: {
		env?: Record<string, string | undefined>;
		start?: CheckoutService['start'];
		readiness?: () => Promise<{ ready: boolean }>;
	} = {}
) {
	const starts: Array<{ input: unknown; destinationCountry: string }> = [];
	let serviceFactories = 0;
	const handler = _createCheckoutPost(
		options.env ?? BASE_ENV,
		() => {
			serviceFactories += 1;
			return {
				async start(input, destinationCountry) {
					starts.push({ input: structuredClone(input), destinationCountry });
					return options.start
						? options.start(input, destinationCountry)
						: { redirectUrl: 'https://checkout.stripe.com/c/pay/cs_test_route' };
				}
			};
		},
		options.readiness ?? (async () => ({ ready: true }))
	);

	return {
		handler,
		starts,
		get serviceFactories() {
			return serviceFactories;
		}
	};
}

async function invoke(
	handler: ReturnType<typeof _createCheckoutPost>,
	checkoutRequest: Request,
	cookieValue?: string
) {
	return handler({
		request: checkoutRequest,
		cookies: { get: () => cookieValue }
	} as unknown as Parameters<typeof handler>[0]);
}

describe('POST /checkout', () => {
	it('resolves the frozen destination from request state without trusting checkout JSON', async () => {
		const fixture = routeFixture();
		const checkoutRequest = request();
		checkoutRequest.headers.set('cf-ipcountry', 'JP');

		const response = await invoke(fixture.handler, checkoutRequest, 'TW');

		expect(response.status).toBe(200);
		expect(fixture.starts).toEqual([
			{
				input: [{ priceId: 'price_tee_m', quantity: 1 }],
				destinationCountry: 'TW'
			}
		]);
	});
	it('preserves the opening-soon storefront guard when readiness is green', async () => {
		const fixture = routeFixture({
			env: {
				STOREFRONT_ENABLED: 'false',
				CHECKOUT_ENABLED: 'true',
				PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
				SUPPORT_EMAIL: 'merch@sveltesociety.dev'
			}
		});

		const response = await invoke(fixture.handler, request());

		expect(response.status).toBe(404);
		expect(response.headers.get('content-type')).toBe('application/problem+json');
		await expect(responseBody(response)).resolves.toEqual({
			type: 'about:blank',
			title: 'Not found',
			status: 404,
			code: 'STOREFRONT_DISABLED'
		});
		expect(fixture.serviceFactories).toBe(0);
	});

	it('checks local readiness before parsing invalid public configuration', async () => {
		const readiness = vi.fn(async () => ({ ready: false }));
		const fixture = routeFixture({ env: {}, readiness });

		const response = await invoke(fixture.handler, request());

		expect(readiness).toHaveBeenCalledOnce();
		expect(response.status).toBe(503);
		await expect(responseBody(response)).resolves.toMatchObject({ code: 'SERVICE_NOT_READY' });
		expect(fixture.serviceFactories).toBe(0);
	});

	it.each(['PRODUCTION_ORIGIN', 'SUPPORT_EMAIL'])(
		'maps invalid public configuration %s to SERVICE_NOT_READY after a green probe',
		async (name) => {
			const readiness = vi.fn(async () => ({ ready: true }));
			const fixture = routeFixture({
				env: { ...BASE_ENV, [name]: undefined },
				readiness
			});

			const response = await invoke(fixture.handler, request());

			expect(readiness).toHaveBeenCalledOnce();
			expect(response.status).toBe(503);
			await expect(responseBody(response)).resolves.toMatchObject({ code: 'SERVICE_NOT_READY' });
			expect(fixture.serviceFactories).toBe(0);
		}
	);

	it('enforces the server-side checkout flag before private config or provider construction', async () => {
		const fixture = routeFixture({
			env: {
				STOREFRONT_ENABLED: 'true',
				CHECKOUT_ENABLED: 'false',
				PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
				SUPPORT_EMAIL: 'merch@sveltesociety.dev'
			}
		});

		const response = await invoke(fixture.handler, request());

		expect(response.status).toBe(503);
		await expect(responseBody(response)).resolves.toMatchObject({
			status: 503,
			code: 'CHECKOUT_DISABLED'
		});
		expect(fixture.serviceFactories).toBe(0);
	});

	it('fails closed with SERVICE_NOT_READY before provider construction when local readiness is red', async () => {
		const readiness = vi.fn(async () => ({ ready: false }));
		const fixture = routeFixture({ readiness });

		const response = await invoke(fixture.handler, request());

		expect(response.status).toBe(503);
		await expect(responseBody(response)).resolves.toEqual({
			type: 'about:blank',
			title: 'Checkout unavailable',
			status: 503,
			code: 'SERVICE_NOT_READY'
		});
		expect(readiness).toHaveBeenCalledOnce();
		expect(fixture.serviceFactories).toBe(0);
		expect(fixture.starts).toEqual([]);
	});

	it('does not admit checkout until a required scheduler is actually running', async () => {
		closeDatabase();
		const directory = await mkdtemp(join(tmpdir(), 'svelte-shop-checkout-scheduler-'));
		const databasePath = join(directory, 'shop.sqlite');
		const database = openDatabase(databasePath);
		const migrationsDirectory = resolve('migrations');
		migrate(database, migrationsDirectory);
		const environment = {
			...BASE_ENV,
			MCP_ENABLED: 'false',
			SCHEDULER_ENABLED: 'true',
			DATABASE_BOOTSTRAP: 'false',
			DATABASE_PATH: databasePath,
			PLUNK_SECRET_KEY: 'plunk-checkout',
			PLUNK_FROM_NAME: 'Svelte Society Shop',
			PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
			ADMIN_EMAIL: 'shop-ops@sveltesociety.dev',
			STYRIA_APP_ID: 'checkout-app',
			STYRIA_SECRET_KEY: 'checkout-secret',
			S3_ENDPOINT: 'https://s3.checkout.test',
			S3_BUCKET: 'checkout-backups',
			S3_REGION: 'eu-north-1',
			S3_ACCESS_KEY_ID: 'checkout-access',
			S3_SECRET_ACCESS_KEY: 'checkout-private',
			S3_PREFIX: 'shop-backups',
			S3_FORCE_PATH_STYLE: 'true',
			BACKUP_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 11).toString('base64')
		};
		let scheduler: Scheduler | null = null;
		const readiness = createReadinessChecker({
			getRuntime: () => ({
				database,
				databasePath,
				environment,
				migrationsDirectory,
				scheduler
			})
		});
		const fixture = routeFixture({ env: environment, readiness });

		try {
			const blocked = await invoke(fixture.handler, request());
			expect(blocked.status).toBe(503);
			await expect(responseBody(blocked)).resolves.toMatchObject({ code: 'SERVICE_NOT_READY' });
			expect(fixture.serviceFactories).toBe(0);

			scheduler = {
				start() {},
				async stop() {},
				async runOutboxOnce() {},
				async runStyriaSyncOnce() {},
				async runBackupOnce() {}
			};
			const admitted = await invoke(fixture.handler, request());
			expect(admitted.status).toBe(200);
			expect(fixture.serviceFactories).toBe(1);
		} finally {
			closeDatabase();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('fails closed with SERVICE_NOT_READY when local readiness cannot complete', async () => {
		const fixture = routeFixture({
			readiness: async () => {
				throw new Error('private readiness failure');
			}
		});

		const response = await invoke(fixture.handler, request());
		const text = await response.text();

		expect(response.status).toBe(503);
		expect(JSON.parse(text)).toMatchObject({ code: 'SERVICE_NOT_READY' });
		expect(text).not.toContain('private readiness failure');
		expect(fixture.serviceFactories).toBe(0);
	});

	it.each([
		'STRIPE_SECRET_KEY',
		'STRIPE_WEBHOOK_SECRET',
		'STRIPE_PAID_SHIPPING_RATE_ID',
		'STRIPE_FREE_SHIPPING_RATE_ID'
	])('maps missing enabled-checkout configuration %s to SERVICE_NOT_READY', async (name) => {
		const fixture = routeFixture({ env: { ...BASE_ENV, [name]: undefined } });

		const response = await invoke(fixture.handler, request());

		expect(response.status).toBe(503);
		await expect(responseBody(response)).resolves.toMatchObject({ code: 'SERVICE_NOT_READY' });
		expect(fixture.serviceFactories).toBe(0);
	});

	it('does not silently create a missing database through the direct checkout factory', async () => {
		closeDatabase();
		const directory = await mkdtemp(join(tmpdir(), 'svelte-shop-checkout-missing-'));
		const databasePath = join(directory, 'missing.sqlite');
		const handler = _createCheckoutPost(
			{ ...BASE_ENV, DATABASE_PATH: databasePath },
			undefined,
			async () => ({ ready: true })
		);

		try {
			const response = await invoke(handler, request({ body: '[]' }));

			expect(response.status).toBe(503);
			await expect(responseBody(response)).resolves.toMatchObject({ code: 'SERVICE_NOT_READY' });
			await expect(access(databasePath)).rejects.toThrow();
		} finally {
			closeDatabase();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		['missing content type', null],
		['form content type', 'application/x-www-form-urlencoded'],
		['JSON suffix type', 'application/merge-patch+json']
	])('rejects %s without parsing or starting checkout', async (_label, contentType) => {
		const fixture = routeFixture();

		const response = await invoke(fixture.handler, request({ contentType }));

		expect(response.status).toBe(415);
		await expect(responseBody(response)).resolves.toMatchObject({
			status: 415,
			code: 'CHECKOUT_JSON_REQUIRED'
		});
		expect(fixture.serviceFactories).toBe(0);
		expect(fixture.starts).toEqual([]);
	});

	it('accepts application/json with charset', async () => {
		const fixture = routeFixture();

		const response = await invoke(
			fixture.handler,
			request({ contentType: 'application/json; charset=utf-8' })
		);

		expect(response.status).toBe(200);
		expect(fixture.starts).toHaveLength(1);
	});

	it('rejects a cross-origin browser request before private config or provider construction', async () => {
		const fixture = routeFixture();

		const response = await invoke(fixture.handler, request({ origin: 'https://attacker.example' }));

		expect(response.status).toBe(403);
		await expect(responseBody(response)).resolves.toMatchObject({
			status: 403,
			code: 'CHECKOUT_ORIGIN_INVALID'
		});
		expect(fixture.serviceFactories).toBe(0);
	});

	it('permits a non-browser request without Origin while retaining JSON validation', async () => {
		const fixture = routeFixture();

		const response = await invoke(fixture.handler, request({ origin: null }));

		expect(response.status).toBe(200);
		expect(fixture.starts).toHaveLength(1);
	});

	it('returns stable problem JSON for malformed JSON without exposing parser text', async () => {
		const fixture = routeFixture();

		const response = await invoke(fixture.handler, request({ body: '{"priceId":' }));

		expect(response.status).toBe(400);
		await expect(responseBody(response)).resolves.toEqual({
			type: 'about:blank',
			title: 'Invalid checkout request',
			status: 400,
			code: 'CHECKOUT_REQUEST_INVALID'
		});
		expect(fixture.serviceFactories).toBe(0);
	});

	it('passes only the decoded JSON value to the checkout service and returns its redirect', async () => {
		const fixture = routeFixture();
		const input = [
			{ priceId: 'price_tee_m', quantity: 1 },
			{ priceId: 'price_mug', quantity: 1 }
		];

		const response = await invoke(
			fixture.handler,
			request({ body: JSON.stringify(input), origin: 'https://shop.sveltesociety.dev' })
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		await expect(responseBody(response)).resolves.toEqual({
			redirectUrl: 'https://checkout.stripe.com/c/pay/cs_test_route'
		});
		expect(fixture.starts).toEqual([{ input, destinationCountry: 'SE' }]);
	});

	it.each([
		['CHECKOUT_REQUEST_INVALID', 400],
		['CHECKOUT_VARIANT_UNAVAILABLE', 409],
		['CHECKOUT_CATALOG_UNAVAILABLE', 503],
		['CHECKOUT_DRAFT_FAILED', 503],
		['CHECKOUT_PROVIDER_UNAVAILABLE', 503],
		['CHECKOUT_CORRELATION_FAILED', 503]
	] as const)('maps %s to non-secret stable problem JSON', async (code, status) => {
		const fixture = routeFixture({
			start: async () => {
				throw new CheckoutError(code);
			}
		});

		const response = await invoke(fixture.handler, request());

		expect(response.status).toBe(status);
		await expect(responseBody(response)).resolves.toEqual({
			type: 'about:blank',
			title: status === 400 ? 'Invalid checkout request' : 'Checkout unavailable',
			status,
			code
		});
	});

	it('does not expose unexpected error messages', async () => {
		const fixture = routeFixture({
			start: async () => {
				throw new Error('sk_test_secret at /data/private/shop.sqlite');
			}
		});

		const response = await invoke(fixture.handler, request());
		const body = await response.text();

		expect(response.status).toBe(500);
		expect(JSON.parse(body)).toEqual({
			type: 'about:blank',
			title: 'Checkout unavailable',
			status: 500,
			code: 'CHECKOUT_INTERNAL_ERROR'
		});
		expect(body).not.toContain('sk_test_secret');
		expect(body).not.toContain('/data/private/shop.sqlite');
	});
});
