import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase } from '$lib/server/db/connection.server';
import type { StripeWebhookService } from '$lib/server/stripe/webhook.server';
import { StripeWebhookError } from '$lib/server/stripe/webhook.server';
import { _createStripeWebhookPost, POST } from './+server';

const RAW_BODY = '{\n  "id": "evt_exact",\n  "customer_email": "private@example.test"\n}\n';

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
				code: 'STRIPE_WEBHOOK_PROCESSING_INIT_FAILED'
			});
			await expect(access(databasePath)).rejects.toThrow();
		} finally {
			closeDatabase();
			await rm(directory, { recursive: true, force: true });
		}
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
