import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createResendEmailGateway,
	RESEND_DEFAULT_BASE_URL,
	RESEND_DEFAULT_TIMEOUT_MS
} from './resend.server';
import { EmailGatewayError } from './gateway';

const sendInput = {
	to: 'ops@example.test',
	from: { name: 'Svelte Society Shop', email: 'merch@sveltesociety.dev' },
	replyTo: 'merch@sveltesociety.dev',
	subject: 'Svelte Society Shop: paid order awaiting review',
	html: '<p>Open Codex and use list_pending_orders.</p>',
	idempotencyKey: 'paid-order-alert:order_123'
};

function successfulResponse(deliveryId = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794'): Response {
	return Response.json({ id: deliveryId });
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('createResendEmailGateway', () => {
	it('posts the exact Resend send contract with Bearer auth and the durable idempotency key', async () => {
		const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			requests.push({ input, init });
			return successfulResponse();
		};
		const client = createResendEmailGateway({ apiKey: 're_test_secret', fetch });

		await expect(client.send(sendInput)).resolves.toEqual({
			deliveryId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794'
		});
		expect(requests).toHaveLength(1);
		expect(String(requests[0].input)).toBe(`${RESEND_DEFAULT_BASE_URL}/emails`);
		expect(requests[0].init?.method).toBe('POST');
		expect(new Headers(requests[0].init?.headers).get('authorization')).toBe(
			'Bearer re_test_secret'
		);
		expect(new Headers(requests[0].init?.headers).get('content-type')).toBe('application/json');
		expect(new Headers(requests[0].init?.headers).get('idempotency-key')).toBe(
			'sha256:4c259565d4d8a978813786ce5cb156325867529df51b956243a257064565e97c'
		);
		expect(new Headers(requests[0].init?.headers).get('user-agent')).toBe(
			'svelte-society-shop/0.0.1'
		);
		expect(JSON.parse(String(requests[0].init?.body))).toEqual({
			to: [sendInput.to],
			from: '"Svelte Society Shop" <merch@sveltesociety.dev>',
			reply_to: sendInput.replyTo,
			subject: sendInput.subject,
			html: sendInput.html
		});
		expect(requests[0].init?.signal).toBeInstanceOf(AbortSignal);
	});

	it('maps Unicode durable keys and exact payloads to bounded deterministic ASCII keys', async () => {
		const keys: Array<string | null> = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			keys.push(new Headers(init?.headers).get('idempotency-key'));
			return successfulResponse();
		};
		const client = createResendEmailGateway({ apiKey: 're_test_secret', fetch });
		const oversizedUnicodeKey = `shipping:order_123:spårning-🚚-${'x'.repeat(300)}`;

		await client.send({ ...sendInput, idempotencyKey: oversizedUnicodeKey });
		await client.send({ ...sendInput, idempotencyKey: oversizedUnicodeKey });
		await client.send({
			...sendInput,
			to: 'different-recipient@example.test',
			idempotencyKey: oversizedUnicodeKey
		});
		await client.send({
			...sendInput,
			html: '<p>A changed body must be a distinct provider request.</p>',
			idempotencyKey: oversizedUnicodeKey
		});

		expect(keys[0]).toBe(keys[1]);
		expect(keys[2]).not.toBe(keys[0]);
		expect(keys[3]).not.toBe(keys[0]);
		expect(new Set(keys).size).toBe(3);
		for (const key of keys) {
			expect(key).toMatch(/^sha256:[a-f0-9]{64}$/u);
			expect(key?.length).toBeLessThanOrEqual(256);
		}
	});

	it.each(['', ' idempotency-key', 'idempotency-key\n', 'x'.repeat(2_001)])(
		'rejects an invalid durable idempotency key before transport',
		async (idempotencyKey) => {
			const fetch = vi.fn<typeof globalThis.fetch>();
			const client = createResendEmailGateway({ apiKey: 're_test_secret', fetch });

			await expect(client.send({ ...sendInput, idempotencyKey })).rejects.toMatchObject({
				name: 'EmailGatewayError',
				code: 'EMAIL_REQUEST_REJECTED'
			});
			expect(fetch).not.toHaveBeenCalled();
		}
	);

	it('uses a configured base URL without duplicating trailing slashes', async () => {
		let requestedUrl = '';
		const fetch: typeof globalThis.fetch = async (input) => {
			requestedUrl = String(input);
			return successfulResponse();
		};
		const client = createResendEmailGateway({
			apiKey: 're_test_secret',
			baseUrl: 'https://resend.internal.example/',
			fetch
		});

		await client.send(sendInput);

		expect(requestedUrl).toBe('https://resend.internal.example/emails');
	});

	it.each([
		['HTTP', 'http://resend.internal.example'],
		['malformed', 'not a provider URL'],
		['credentialed', 'https://operator:secret-value@resend.internal.example'],
		['query-bearing', 'https://resend.internal.example?token=secret-value'],
		['fragment-bearing', 'https://resend.internal.example#secret-value']
	])('rejects an explicitly configured %s base URL before transport', (_label, baseUrl) => {
		const fetch = vi.fn<typeof globalThis.fetch>();

		expect(() => createResendEmailGateway({ apiKey: 're_test_secret', baseUrl, fetch })).toThrow(
			expect.objectContaining({
				name: 'EmailGatewayError',
				code: 'EMAIL_REQUEST_REJECTED',
				message: 'EMAIL_REQUEST_REJECTED'
			})
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		['non-JSON', new Response('not-json', { status: 200 })],
		['an array envelope', Response.json([{ id: 'delivery_123' }])],
		['a missing delivery ID', Response.json({})],
		['an empty delivery ID', Response.json({ id: '' })],
		['a non-string delivery ID', Response.json({ id: 123 })]
	])('rejects %s as a malformed success response', async (_label, response) => {
		const fetch: typeof globalThis.fetch = async () => response;
		const client = createResendEmailGateway({ apiKey: 're_test_secret', fetch });

		await expect(client.send(sendInput)).rejects.toEqual(
			expect.objectContaining({
				name: 'EmailGatewayError',
				code: 'EMAIL_RESPONSE_INVALID',
				message: 'EMAIL_RESPONSE_INVALID'
			})
		);
	});

	it.each([
		[429, 'EMAIL_RATE_LIMITED'],
		[500, 'EMAIL_UNAVAILABLE'],
		[503, 'EMAIL_UNAVAILABLE'],
		[400, 'EMAIL_REQUEST_REJECTED'],
		[401, 'EMAIL_CONFIGURATION_INVALID'],
		[403, 'EMAIL_CONFIGURATION_INVALID'],
		[404, 'EMAIL_CONFIGURATION_INVALID'],
		[405, 'EMAIL_CONFIGURATION_INVALID'],
		[451, 'EMAIL_CONFIGURATION_INVALID'],
		[422, 'EMAIL_REQUEST_REJECTED']
	])('maps HTTP %i to the stable %s code', async (status, code) => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response('{"message":"customer@example.test rejected re_live_sensitive"}', {
				status,
				statusText: 'customer@example.test rejected re_live_sensitive'
			});
		const client = createResendEmailGateway({ apiKey: 're_live_sensitive', fetch });

		await expect(client.send(sendInput)).rejects.toEqual(
			expect.objectContaining({ name: 'EmailGatewayError', code, message: code })
		);
	});

	it.each([
		['concurrent_idempotent_requests', 'EMAIL_RATE_LIMITED'],
		['resource_locked', 'EMAIL_RATE_LIMITED'],
		['invalid_idempotent_request', 'EMAIL_REQUEST_REJECTED'],
		['unknown_conflict', 'EMAIL_RESPONSE_INVALID']
	])('maps Resend 409 %s to the stable %s code', async (name, code) => {
		const fetch: typeof globalThis.fetch = async () =>
			Response.json({ name, message: 'private provider detail' }, { status: 409 });
		const client = createResendEmailGateway({ apiKey: 're_test_secret', fetch });

		await expect(client.send(sendInput)).rejects.toEqual(
			expect.objectContaining({ name: 'EmailGatewayError', code, message: code })
		);
	});

	it('treats a malformed 409 response as retryable invalid provider data', async () => {
		const fetch: typeof globalThis.fetch = async () => new Response('not-json', { status: 409 });
		const client = createResendEmailGateway({ apiKey: 're_test_secret', fetch });

		await expect(client.send(sendInput)).rejects.toMatchObject({
			name: 'EmailGatewayError',
			code: 'EMAIL_RESPONSE_INVALID'
		});
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
		const client = createResendEmailGateway({
			apiKey: 're_test_secret',
			timeoutMs: 25,
			fetch
		});

		const delivery = client.send(sendInput);
		const rejection = expect(delivery).rejects.toEqual(
			expect.objectContaining({
				name: 'EmailGatewayError',
				code: 'EMAIL_TIMEOUT',
				message: 'EMAIL_TIMEOUT'
			})
		);
		await vi.advanceTimersByTimeAsync(25);

		await rejection;
		expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
	});

	it('forwards a caller abort into an active provider request', async () => {
		let requestSignal: AbortSignal | null = null;
		const fetch: typeof globalThis.fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				requestSignal = init?.signal as AbortSignal;
				requestSignal.addEventListener('abort', () => reject(new Error('caller aborted')));
			});
		const client = createResendEmailGateway({ apiKey: 're_test_secret', fetch });
		const caller = new AbortController();

		const result = client.send(sendInput, caller.signal).catch((error: unknown) => error);
		caller.abort();

		await expect(result).resolves.toEqual(
			expect.objectContaining({ code: 'EMAIL_UNAVAILABLE', message: 'EMAIL_UNAVAILABLE' })
		);
		expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
	});

	it('enforces the exact ten-second default used by the scheduler drain bound', async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | null = null;
		const fetch: typeof globalThis.fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				requestSignal = init?.signal as AbortSignal;
				requestSignal.addEventListener('abort', () => reject(new Error('timed out')));
			});
		const client = createResendEmailGateway({ apiKey: 're_test_secret', fetch });

		const delivery = client.send(sendInput);
		const result = delivery.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(RESEND_DEFAULT_TIMEOUT_MS - 1);
		expect((requestSignal as AbortSignal | null)?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toEqual(
			expect.objectContaining({ code: 'EMAIL_TIMEOUT', message: 'EMAIL_TIMEOUT' })
		);
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
		const client = createResendEmailGateway({
			apiKey: 're_test_secret',
			timeoutMs: 25,
			fetch
		});

		const delivery = client.send(sendInput);
		const rejection = expect(delivery).rejects.toEqual(
			expect.objectContaining({
				name: 'EmailGatewayError',
				code: 'EMAIL_TIMEOUT',
				message: 'EMAIL_TIMEOUT'
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
			throw new Error(`recipient=${sendInput.to} secret=re_live_sensitive body=${sendInput.html}`);
		};
		const client = createResendEmailGateway({ apiKey: 're_live_sensitive', fetch });

		const error = await client.send(sendInput).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(EmailGatewayError);
		expect(error).toEqual(
			expect.objectContaining({
				code: 'EMAIL_UNAVAILABLE',
				message: 'EMAIL_UNAVAILABLE'
			})
		);
		expect(error).not.toHaveProperty('cause');
		expect(String(error)).not.toContain(sendInput.to);
		expect(String(error)).not.toContain('re_live_sensitive');
		expect(String(error)).not.toContain(sendInput.html);
		expect(consoleError).not.toHaveBeenCalled();
		expect(consoleWarn).not.toHaveBeenCalled();
		expect(consoleLog).not.toHaveBeenCalled();
	});
});
