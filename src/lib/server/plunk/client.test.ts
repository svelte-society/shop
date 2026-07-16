import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlunkClient, PLUNK_DEFAULT_BASE_URL, PlunkError } from './client.server';

const sendInput = {
	to: 'ops@example.test',
	from: { name: 'Svelte Society Shop', email: 'merch@sveltesociety.dev' },
	replyTo: 'merch@sveltesociety.dev',
	subject: 'Svelte Society Shop: paid order awaiting review',
	html: '<p>Open Codex and use list_pending_orders.</p>'
};

function successfulResponse(deliveryId = 'email_delivery_123'): Response {
	return Response.json({
		success: true,
		data: {
			emails: [
				{
					contact: { id: 'cnt_123', email: sendInput.to },
					email: deliveryId
				}
			],
			timestamp: '2026-07-16T08:30:00.000Z'
		}
	});
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('createPlunkClient', () => {
	it('posts the exact Plunk send contract with Bearer auth and the verified sender', async () => {
		const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			requests.push({ input, init });
			return successfulResponse();
		};
		const client = createPlunkClient({ secretKey: 'sk_test_secret', fetch });

		await expect(client.send(sendInput)).resolves.toEqual({ deliveryId: 'email_delivery_123' });
		expect(requests).toHaveLength(1);
		expect(String(requests[0].input)).toBe(`${PLUNK_DEFAULT_BASE_URL}/v1/send`);
		expect(requests[0].init?.method).toBe('POST');
		expect(new Headers(requests[0].init?.headers).get('authorization')).toBe(
			'Bearer sk_test_secret'
		);
		expect(new Headers(requests[0].init?.headers).get('content-type')).toBe('application/json');
		expect(JSON.parse(String(requests[0].init?.body))).toEqual({
			to: sendInput.to,
			from: sendInput.from,
			reply: sendInput.replyTo,
			subject: sendInput.subject,
			body: sendInput.html
		});
		expect(requests[0].init?.signal).toBeInstanceOf(AbortSignal);
	});

	it('uses a configured base URL without duplicating trailing slashes', async () => {
		let requestedUrl = '';
		const fetch: typeof globalThis.fetch = async (input) => {
			requestedUrl = String(input);
			return successfulResponse();
		};
		const client = createPlunkClient({
			secretKey: 'sk_test_secret',
			baseUrl: 'https://plunk.internal.example/',
			fetch
		});

		await client.send(sendInput);

		expect(requestedUrl).toBe('https://plunk.internal.example/v1/send');
	});

	it.each([
		['non-JSON', new Response('not-json', { status: 200 })],
		['a false success envelope', Response.json({ success: false, error: { message: 'raw' } })],
		['a missing emails array', Response.json({ success: true, data: {} })],
		['an empty delivery ID', Response.json({ success: true, data: { emails: [{ email: '' }] } })],
		[
			'multiple deliveries for a single recipient',
			Response.json({
				success: true,
				data: { emails: [{ email: 'delivery_one' }, { email: 'delivery_two' }] }
			})
		]
	])('rejects %s as a malformed success response', async (_label, response) => {
		const fetch: typeof globalThis.fetch = async () => response;
		const client = createPlunkClient({ secretKey: 'sk_test_secret', fetch });

		await expect(client.send(sendInput)).rejects.toEqual(
			expect.objectContaining({
				name: 'PlunkError',
				code: 'PLUNK_RESPONSE_INVALID',
				message: 'PLUNK_RESPONSE_INVALID'
			})
		);
	});

	it.each([
		[429, 'PLUNK_RATE_LIMITED'],
		[500, 'PLUNK_UNAVAILABLE'],
		[503, 'PLUNK_UNAVAILABLE'],
		[400, 'PLUNK_REQUEST_REJECTED'],
		[401, 'PLUNK_REQUEST_REJECTED']
	])('maps HTTP %i to the stable %s code', async (status, code) => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response('{"error":"customer@example.test rejected sk_live_sensitive"}', {
				status,
				statusText: 'customer@example.test rejected sk_live_sensitive'
			});
		const client = createPlunkClient({ secretKey: 'sk_live_sensitive', fetch });

		await expect(client.send(sendInput)).rejects.toEqual(
			expect.objectContaining({ name: 'PlunkError', code, message: code })
		);
	});

	it('aborts a request at the configured timeout and returns only a stable code', async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | null = null;
		const fetch: typeof globalThis.fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				requestSignal = init?.signal as AbortSignal;
				requestSignal.addEventListener('abort', () => {
					reject(new Error('timeout included customer@example.test'));
				});
			});
		const client = createPlunkClient({
			secretKey: 'sk_test_secret',
			timeoutMs: 25,
			fetch
		});

		const delivery = client.send(sendInput);
		const rejection = expect(delivery).rejects.toEqual(
			expect.objectContaining({
				name: 'PlunkError',
				code: 'PLUNK_TIMEOUT',
				message: 'PLUNK_TIMEOUT'
			})
		);
		await vi.advanceTimersByTimeAsync(25);

		await rejection;
		expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
	});

	it('keeps the timeout active while the success response body is being read', async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | null = null;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			requestSignal = init?.signal as AbortSignal;
			return {
				ok: true,
				status: 200,
				json: () =>
					new Promise((_resolve, reject) => {
						requestSignal?.addEventListener('abort', () => {
							reject(new Error('response contained customer@example.test'));
						});
					})
			} as Response;
		};
		const client = createPlunkClient({
			secretKey: 'sk_test_secret',
			timeoutMs: 25,
			fetch
		});

		const delivery = client.send(sendInput);
		const rejection = expect(delivery).rejects.toEqual(
			expect.objectContaining({
				name: 'PlunkError',
				code: 'PLUNK_TIMEOUT',
				message: 'PLUNK_TIMEOUT'
			})
		);
		await vi.advanceTimersByTimeAsync(25);

		expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
		await rejection;
	});

	it('redacts network and response details and never logs request or response data', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const fetch: typeof globalThis.fetch = async () => {
			throw new Error(`recipient=${sendInput.to} secret=sk_live_sensitive body=${sendInput.html}`);
		};
		const client = createPlunkClient({ secretKey: 'sk_live_sensitive', fetch });

		const error = await client.send(sendInput).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(PlunkError);
		expect(error).toEqual(
			expect.objectContaining({
				code: 'PLUNK_UNAVAILABLE',
				message: 'PLUNK_UNAVAILABLE'
			})
		);
		expect(error).not.toHaveProperty('cause');
		expect(String(error)).not.toContain(sendInput.to);
		expect(String(error)).not.toContain('sk_live_sensitive');
		expect(String(error)).not.toContain(sendInput.html);
		expect(consoleError).not.toHaveBeenCalled();
		expect(consoleWarn).not.toHaveBeenCalled();
		expect(consoleLog).not.toHaveBeenCalled();
	});
});
