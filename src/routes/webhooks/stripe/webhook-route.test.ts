import { afterEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { access, mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applicationLifecycle } from '$lib/server/app.server';
import { closeDatabase, openDatabase } from '$lib/server/db/connection.server';
import { SqliteCheckoutDraftRepository } from '$lib/server/db/checkout-drafts.server';
import { migrate } from '$lib/server/db/migrate.server';
import { SqlitePaidOrderUnitOfWork } from '$lib/server/db/orders.server';
import { SqliteStripeEventRepository } from '$lib/server/db/stripe-events.server';
import { checkReadiness } from '$lib/server/health/readiness.server';
import { SqliteRefundOrderUnitOfWork } from '$lib/server/orders/intake.server';
import { PaidCheckoutError } from '$lib/server/stripe/paid-checkout';
import type { StripeWebhookService } from '$lib/server/stripe/webhook.server';
import {
	createStripeWebhookService,
	createStripeWebhookVerifier,
	StripeWebhookError
} from '$lib/server/stripe/webhook.server';
import { _createStripeWebhookPost, POST } from './+server';

const RAW_BODY = '{\n  "id": "evt_exact",\n  "customer_email": "private@example.test"\n}\n';
const migrationsDirectory = resolve('migrations');

function request(signature: string | null = 't=123,v1=valid', rawBody = RAW_BODY): Request {
	const headers = new Headers({ 'content-type': 'application/json' });
	if (signature !== null) headers.set('stripe-signature', signature);
	return new Request('https://shop.sveltesociety.dev/webhooks/stripe', {
		method: 'POST',
		headers,
		body: rawBody
	});
}

function fixture(handle: StripeWebhookService['handle'] = async () => ({ duplicate: false })) {
	const calls: Array<{ rawBody: string; signature: string }> = [];
	let factories = 0;
	const handler = _createStripeWebhookPost(() => {
		factories += 1;
		return {
			async handle(rawBody, signature) {
				calls.push({ rawBody, signature });
				return handle(rawBody, signature);
			}
		};
	});
	return {
		handler,
		calls,
		get factories() {
			return factories;
		}
	};
}

async function invoke(
	handler: ReturnType<typeof _createStripeWebhookPost>,
	webhookRequest: Request
) {
	return handler({ request: webhookRequest } as Parameters<typeof handler>[0]);
}

function runtimeEnvironment(databasePath: string, bootstrap: 'true' | 'false') {
	return {
		STOREFRONT_ENABLED: 'false',
		CHECKOUT_ENABLED: 'false',
		MCP_ENABLED: 'false',
		SCHEDULER_ENABLED: 'false',
		DATABASE_BOOTSTRAP: bootstrap,
		PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
		SUPPORT_EMAIL: 'merch@sveltesociety.dev',
		PLUNK_SECRET_KEY: 'sk_test_webhook_runtime',
		PLUNK_FROM_NAME: 'Svelte Society Shop',
		PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
		WITHDRAWAL_DATA_KEY: Buffer.alloc(32, 15).toString('base64'),
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
		POLICY_EFFECTIVE_DATE: '2026-07-17',
		STRIPE_WEBHOOK_SECRET: 'whsec_runtime_readiness',
		STYRIA_SUPPORTED_COUNTRIES: 'SE,JP,TW',
		DATABASE_PATH: databasePath
	};
}

function paidRequest(webhookSecret: string, eventId: string): Request {
	const body = JSON.stringify({
		id: eventId,
		object: 'event',
		type: 'checkout.session.completed',
		data: { object: { id: 'cs_runtime_readiness', object: 'checkout.session' } }
	});
	const signature = Stripe.webhooks.generateTestHeaderString({
		payload: body,
		secret: webhookSecret
	});
	return request(signature, body);
}

function runtimeService(webhookSecret: string, paidCalls: string[]): StripeWebhookService {
	return createStripeWebhookService({
		webhookSecret,
		verifier: createStripeWebhookVerifier({ webhooks: Stripe.webhooks }),
		checkReadiness,
		loadProcessingDependencies() {
			const database = applicationLifecycle.current()?.database;
			if (!database?.open) throw new Error('APPLICATION_NOT_READY');
			return {
				stripeEvents: new SqliteStripeEventRepository(database),
				drafts: new SqliteCheckoutDraftRepository(database),
				stripeOrders: {
					async retrievePaidCheckout(sessionId: string) {
						paidCalls.push(sessionId);
						throw new PaidCheckoutError('STRIPE_PAID_CHECKOUT_SESSION_UNPAID');
					},
					async retrieveRefundStatus() {
						return 'paid' as const;
					}
				},
				paidOrders: new SqlitePaidOrderUnitOfWork(database),
				refunds: new SqliteRefundOrderUnitOfWork(database)
			};
		}
	});
}

afterEach(async () => {
	await applicationLifecycle.stop();
	closeDatabase();
});

describe('POST /webhooks/stripe', () => {
	it('exports the production handler while keeping missing-signature rejection config independent', async () => {
		const response = await invoke(POST, request(null));

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			code: 'STRIPE_WEBHOOK_SIGNATURE_MISSING'
		});
	});

	it('does not silently create a missing database after a valid production signature', async () => {
		closeDatabase();
		const directory = await mkdtemp(join(tmpdir(), 'svelte-shop-webhook-missing-'));
		const databasePath = join(directory, 'missing.sqlite');
		const webhookSecret = 'whsec_missing_database';
		const body = JSON.stringify({
			id: 'evt_missing_database',
			type: 'checkout.session.completed',
			data: { object: { object: 'checkout.session', id: 'cs_missing_database' } }
		});
		const signature = Stripe.webhooks.generateTestHeaderString({
			payload: body,
			secret: webhookSecret
		});
		const configured = {
			STOREFRONT_ENABLED: 'false',
			CHECKOUT_ENABLED: 'false',
			PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
			SUPPORT_EMAIL: 'merch@sveltesociety.dev',
			STRIPE_SECRET_KEY: 'sk_test_missing_database',
			STRIPE_WEBHOOK_SECRET: webhookSecret,
			STRIPE_PAID_SHIPPING_RATE_ID: 'shr_paid',
			STRIPE_FREE_SHIPPING_RATE_ID: 'shr_free',
			STYRIA_SUPPORTED_COUNTRIES: 'SE,JP,TW',
			DATABASE_PATH: databasePath
		};

		try {
			const routeModule = await import('./+server');
			const createDefault = (
				routeModule as unknown as {
					_createDefaultStripeWebhookServiceFactory?: (
						environment: Record<string, string | undefined>
					) => StripeWebhookService;
				}
			)._createDefaultStripeWebhookServiceFactory;
			expect(createDefault).toBeTypeOf('function');
			if (!createDefault) return;
			const handler = _createStripeWebhookPost(() => createDefault(configured));
			const response = await invoke(handler, request(signature, body));

			expect(response.status).toBe(500);
			await expect(response.json()).resolves.toMatchObject({
				code: 'STRIPE_WEBHOOK_SERVICE_NOT_READY'
			});
			await expect(access(databasePath)).rejects.toThrow();
		} finally {
			closeDatabase();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('rechecks real local readiness before cached processing after the SQLite path is unlinked', async () => {
		await applicationLifecycle.stop();
		closeDatabase();
		const directory = await mkdtemp(join(tmpdir(), 'svelte-shop-webhook-unlinked-'));
		const databasePath = join(directory, 'shop.sqlite');
		const created = openDatabase(databasePath);
		migrate(created, migrationsDirectory);
		closeDatabase();
		const environment = runtimeEnvironment(databasePath, 'false');

		try {
			const runtime = await applicationLifecycle.start({
				environment,
				building: false,
				test: false
			});
			expect(runtime).not.toBeNull();
			const paidCalls: string[] = [];
			const service = runtimeService(environment.STRIPE_WEBHOOK_SECRET, paidCalls);
			const handler = _createStripeWebhookPost(() => service);

			const primed = await invoke(
				handler,
				paidRequest(environment.STRIPE_WEBHOOK_SECRET, 'evt_before_unlink')
			);
			expect(primed.status).toBe(200);
			expect(paidCalls).toEqual(['cs_runtime_readiness']);
			expect(
				runtime?.database.prepare('SELECT count(*) AS count FROM stripe_events').get()
			).toEqual({ count: 1 });

			await unlink(databasePath);
			const blocked = await invoke(
				handler,
				paidRequest(environment.STRIPE_WEBHOOK_SECRET, 'evt_after_unlink')
			);

			expect(blocked.status).toBe(500);
			await expect(blocked.json()).resolves.toMatchObject({
				code: 'STRIPE_WEBHOOK_SERVICE_NOT_READY'
			});
			expect(paidCalls).toEqual(['cs_runtime_readiness']);
			expect(
				runtime?.database.prepare('SELECT count(*) AS count FROM stripe_events').get()
			).toEqual({ count: 1 });
			expect(runtime?.database.prepare('SELECT count(*) AS count FROM orders').get()).toEqual({
				count: 0
			});
		} finally {
			await applicationLifecycle.stop();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects paid events while bootstrap mode is active before provider or database work', async () => {
		await applicationLifecycle.stop();
		closeDatabase();
		const directory = await mkdtemp(join(tmpdir(), 'svelte-shop-webhook-bootstrap-'));
		const databasePath = join(directory, 'shop.sqlite');
		const environment = runtimeEnvironment(databasePath, 'true');

		try {
			const runtime = await applicationLifecycle.start({
				environment,
				building: false,
				test: false
			});
			const paidCalls: string[] = [];
			const handler = _createStripeWebhookPost(() =>
				runtimeService(environment.STRIPE_WEBHOOK_SECRET, paidCalls)
			);
			const response = await invoke(
				handler,
				paidRequest(environment.STRIPE_WEBHOOK_SECRET, 'evt_bootstrap_red')
			);

			expect(response.status).toBe(500);
			await expect(response.json()).resolves.toMatchObject({
				code: 'STRIPE_WEBHOOK_SERVICE_NOT_READY'
			});
			expect(paidCalls).toEqual([]);
			expect(
				runtime?.database.prepare('SELECT count(*) AS count FROM stripe_events').get()
			).toEqual({ count: 0 });
		} finally {
			await applicationLifecycle.stop();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('returns 400 for an invalid signature without calling per-event readiness', async () => {
		const readiness = vi.fn(async () => ({ ready: true }));
		const service = createStripeWebhookService({
			webhookSecret: 'whsec_invalid_ordering',
			verifier: {
				constructEvent() {
					throw new Error('invalid signature');
				}
			},
			checkReadiness: readiness,
			loadProcessingDependencies() {
				throw new Error('must not load');
			}
		});
		const response = await invoke(
			_createStripeWebhookPost(() => service),
			request('invalid')
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			code: 'STRIPE_WEBHOOK_SIGNATURE_INVALID'
		});
		expect(readiness).not.toHaveBeenCalled();
	});

	it('rejects a missing signature before reading the body or constructing the service', async () => {
		const webhook = request(null);
		const text = vi.spyOn(webhook, 'text');
		const route = fixture();

		const response = await invoke(route.handler, webhook);

		expect(response.status).toBe(400);
		expect(response.headers.get('content-type')).toBe('application/problem+json');
		await expect(response.json()).resolves.toEqual({
			type: 'about:blank',
			title: 'Invalid Stripe webhook',
			status: 400,
			code: 'STRIPE_WEBHOOK_SIGNATURE_MISSING'
		});
		expect(text).not.toHaveBeenCalled();
		expect(route.factories).toBe(0);
		expect(route.calls).toEqual([]);
	});

	it('reads text exactly once and passes the byte-for-byte decoded body without calling json', async () => {
		const webhook = request();
		const text = vi.spyOn(webhook, 'text');
		const json = vi.spyOn(webhook, 'json');
		const route = fixture();

		const response = await invoke(route.handler, webhook);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ received: true, duplicate: false });
		expect(text).toHaveBeenCalledTimes(1);
		expect(json).not.toHaveBeenCalled();
		expect(route.calls).toEqual([{ rawBody: RAW_BODY, signature: 't=123,v1=valid' }]);
	});

	it('stays active when storefront and checkout flags are disabled', async () => {
		const route = fixture();

		const response = await invoke(route.handler, request());

		expect(response.status).toBe(200);
		expect(route.calls).toHaveLength(1);
	});

	it.each([
		[new StripeWebhookError('STRIPE_WEBHOOK_SIGNATURE_INVALID', false), 400],
		[new StripeWebhookError('PAID_CHECKOUT_LINES_MISMATCH', false), 422],
		[new StripeWebhookError('STRIPE_PAID_CHECKOUT_RETRIEVAL_FAILED', true), 500]
	] as const)('maps %s to a stable redacted response', async (error, status) => {
		const route = fixture(async () => {
			throw error;
		});

		const response = await invoke(route.handler, request());

		expect(response.status).toBe(status);
		const body = await response.text();
		expect(body).toBe(
			JSON.stringify({
				type: 'about:blank',
				title: status === 400 ? 'Invalid Stripe webhook' : 'Stripe webhook processing failed',
				status,
				code: error.code
			})
		);
		expect(body).not.toContain('private@example.test');
	});

	it('redacts unexpected failures behind a retryable stable response', async () => {
		const route = fixture(async () => {
			throw new Error('database contained private@example.test at 123 Provider Street');
		});

		const response = await invoke(route.handler, request());
		const body = await response.text();

		expect(response.status).toBe(500);
		expect(body).toBe(
			JSON.stringify({
				type: 'about:blank',
				title: 'Stripe webhook processing failed',
				status: 500,
				code: 'STRIPE_WEBHOOK_INTERNAL_ERROR'
			})
		);
		expect(body).not.toContain('private@example.test');
		expect(body).not.toContain('Provider Street');
	});
});
