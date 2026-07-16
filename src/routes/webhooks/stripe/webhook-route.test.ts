import { describe, expect, it, vi } from 'vitest';
import type { StripeWebhookService } from '$lib/server/stripe/webhook.server';
import { StripeWebhookError } from '$lib/server/stripe/webhook.server';
import { _createStripeWebhookPost, POST } from './+server';

const RAW_BODY = '{\n  "id": "evt_exact",\n  "customer_email": "private@example.test"\n}\n';

function request(signature: string | null = 't=123,v1=valid'): Request {
	const headers = new Headers({ 'content-type': 'application/json' });
	if (signature !== null) headers.set('stripe-signature', signature);
	return new Request('https://shop.sveltesociety.dev/webhooks/stripe', {
		method: 'POST',
		headers,
		body: RAW_BODY
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
