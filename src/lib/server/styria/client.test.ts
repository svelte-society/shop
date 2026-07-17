import { afterEach, describe, expect, it, vi } from 'vitest';
import { styriaOrderFixture, styriaPayloadFixture } from '../../../../tests/fixtures/styria';
import {
	createStyriaClient,
	STYRIA_DEFAULT_BASE_URL,
	STYRIA_DEFAULT_TIMEOUT_MS,
	StyriaError
} from './client.server';
import { signGet, signPost } from './signing';

const credentials = { appId: 'APP-test-id', secretKey: 'test-signing-secret' };

function successJson(value: unknown): Response {
	return Response.json(value);
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('Styria list/search adapter', () => {
	it('normalizes an HTTPS path-prefix base URL without duplicating slashes', async () => {
		let requestedUrl = '';
		const fetch: typeof globalThis.fetch = async (input) => {
			requestedUrl = String(input);
			return successJson([]);
		};
		const client = createStyriaClient({
			...credentials,
			baseUrl: 'https://styria.internal.example/provider/',
			fetch
		});

		await client.searchByExternalId('cs_test_target', new Date('2026-07-16T08:00:00.000Z'));

		expect(new URL(requestedUrl).pathname).toBe('/provider/api/orders.php');
	});

	it.each([
		['HTTP', 'http://styria.internal.example'],
		['malformed', 'not a provider URL'],
		['credentialed', 'https://operator:secret-value@styria.internal.example'],
		['query-bearing', 'https://styria.internal.example?token=secret-value'],
		['fragment-bearing', 'https://styria.internal.example#secret-value']
	])('rejects an explicitly configured %s base URL before transport', (_label, baseUrl) => {
		const fetch = vi.fn<typeof globalThis.fetch>();

		expect(() => createStyriaClient({ ...credentials, baseUrl, fetch })).toThrow(
			expect.objectContaining({
				name: 'StyriaError',
				code: 'STYRIA_REQUEST_REJECTED',
				message: 'STYRIA_REQUEST_REJECTED'
			})
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('pages at 250 and filters exact external_id locally across every result page', async () => {
		const targetExternalId = 'cs_test_target';
		const firstPage = Array.from({ length: 250 }, (_, index) =>
			styriaOrderFixture({
				id: String(index + 1),
				external_id:
					index === 0
						? null
						: index === 249
							? `${targetExternalId}_not_exact`
							: `cs_test_other_${index}`
			})
		);
		const exactMatch = styriaOrderFixture({ id: '251', external_id: targetExternalId });
		const requests: URL[] = [];
		const fetch: typeof globalThis.fetch = async (input) => {
			const url = new URL(String(input));
			requests.push(url);
			return successJson(url.searchParams.get('page') === '1' ? firstPage : [exactMatch]);
		};
		const client = createStyriaClient({ ...credentials, fetch });
		const createdAfter = new Date('2026-07-16T08:00:00.000Z');

		await expect(client.searchByExternalId(targetExternalId, createdAfter)).resolves.toEqual([
			exactMatch
		]);
		expect(requests).toHaveLength(2);
		for (const [index, url] of requests.entries()) {
			expect(url.origin + url.pathname).toBe(`${STYRIA_DEFAULT_BASE_URL}/api/orders.php`);
			expect(url.searchParams.get('limit')).toBe('250');
			expect(url.searchParams.get('page')).toBe(String(index + 1));
			expect(url.searchParams.get('created_at_min')).toBe(createdAfter.toISOString());
			expect(url.searchParams.get('format')).toBe('json');
			expect(url.searchParams.has('external_id')).toBe(false);
		}
	});

	it('uses deterministic encoded query ordering and signs exactly that query without Signature', async () => {
		let requestedUrl: URL | null = null;
		const fetch: typeof globalThis.fetch = async (input) => {
			requestedUrl = new URL(String(input));
			return successJson([]);
		};
		const client = createStyriaClient({ ...credentials, fetch });

		await client.searchByExternalId('cs_test_target', new Date('2026-07-16T08:00:00.000Z'));

		const unsignedQuery =
			'AppId=APP-test-id&created_at_min=2026-07-16T08%3A00%3A00.000Z&format=json&limit=250&page=1';
		expect((requestedUrl as URL | null)?.search).toBe(
			`?${unsignedQuery}&Signature=${signGet(unsignedQuery, credentials.secretKey)}`
		);
	});
});

describe('Styria detail/create adapter', () => {
	it('gets one validated order with deterministic AppId and Signature parameters', async () => {
		const expected = styriaOrderFixture({ id: '2048' });
		let requestedUrl: URL | null = null;
		let requestInit: RequestInit | undefined;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			requestedUrl = new URL(String(input));
			requestInit = init;
			return successJson(expected);
		};
		const client = createStyriaClient({ ...credentials, fetch });

		await expect(client.get('2048')).resolves.toEqual(expected);
		const unsignedQuery = 'AppId=APP-test-id&format=json&id=2048';
		expect((requestedUrl as URL | null)?.pathname).toBe('/api/order.php');
		expect((requestedUrl as URL | null)?.search).toBe(
			`?${unsignedQuery}&Signature=${signGet(unsignedQuery, credentials.secretKey)}`
		);
		expect(requestInit?.method).toBe('GET');
	});

	it('signs and sends the exact serialized POST body without canonicalizing it', async () => {
		const payload = styriaPayloadFixture();
		const expected = styriaOrderFixture();
		let requestedUrl: URL | null = null;
		let requestInit: RequestInit | undefined;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			requestedUrl = new URL(String(input));
			requestInit = init;
			return successJson(expected);
		};
		const client = createStyriaClient({ ...credentials, fetch });
		const exactBody = JSON.stringify(payload);

		await expect(client.create(payload)).resolves.toEqual(expected);
		expect((requestedUrl as URL | null)?.pathname).toBe('/api/orders.php');
		expect((requestedUrl as URL | null)?.search).toBe(
			`?AppId=APP-test-id&Signature=${signPost(exactBody, credentials.secretKey)}`
		);
		expect(requestInit?.method).toBe('POST');
		expect(new Headers(requestInit?.headers).get('content-type')).toBe('application/json');
		expect(requestInit?.body).toBe(exactBody);
	});

	it('normalizes documented string scalars while validating a provider response', async () => {
		const fetch: typeof globalThis.fetch = async () =>
			successJson({
				...styriaOrderFixture(),
				id: 1042,
				deleted: 'false',
				items: [
					{
						...styriaOrderFixture().items[0],
						quantity: '2',
						retailPrice: '27.99'
					}
				]
			});
		const client = createStyriaClient({ ...credentials, fetch });

		await expect(client.get('1042')).resolves.toEqual(styriaOrderFixture());
	});
});

describe('Styria client failures', () => {
	it.each([
		['non-JSON success', new Response('not-json', { status: 200 })],
		['malformed detail', successJson({ id: '1042', external_id: 'cs_test_target' })],
		['malformed list item', successJson([styriaOrderFixture(), { status: 'received' }])]
	])('rejects a %s with one stable response code', async (_label, response) => {
		const fetch: typeof globalThis.fetch = async () => response;
		const client = createStyriaClient({ ...credentials, fetch });

		const operation =
			_label === 'malformed list item'
				? client.searchByExternalId('cs_test_target', new Date('2026-07-16T08:00:00.000Z'))
				: client.get('1042');
		await expect(operation).rejects.toEqual(
			expect.objectContaining({
				name: 'StyriaError',
				code: 'STYRIA_RESPONSE_INVALID',
				message: 'STYRIA_RESPONSE_INVALID'
			})
		);
	});

	it.each([
		[400, 'STYRIA_REQUEST_REJECTED'],
		[401, 'STYRIA_REQUEST_REJECTED'],
		[429, 'STYRIA_RATE_LIMITED'],
		[500, 'STYRIA_UNAVAILABLE'],
		[503, 'STYRIA_UNAVAILABLE']
	])('maps HTTP %i to stable code %s without exposing the provider body', async (status, code) => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response('customer@example.test / raw provider failure / signing secret', { status });
		const client = createStyriaClient({ ...credentials, fetch });

		await expect(client.get('1042')).rejects.toEqual(
			expect.objectContaining({ name: 'StyriaError', code, message: code })
		);
	});

	it('uses the exact ten-second default timeout and returns only a stable timeout code', async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | null = null;
		const fetch: typeof globalThis.fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				requestSignal = init?.signal as AbortSignal;
				requestSignal.addEventListener('abort', () => reject(new Error('provider body with PII')));
			});
		const client = createStyriaClient({ ...credentials, fetch });

		const result = client.get('1042').catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(STYRIA_DEFAULT_TIMEOUT_MS - 1);
		expect((requestSignal as AbortSignal | null)?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toEqual(
			expect.objectContaining({ code: 'STYRIA_TIMEOUT', message: 'STYRIA_TIMEOUT' })
		);
		expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
	});

	it('forwards a caller abort into an active provider request', async () => {
		let requestSignal: AbortSignal | null = null;
		const fetch: typeof globalThis.fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				requestSignal = init?.signal as AbortSignal;
				requestSignal.addEventListener('abort', () => reject(new Error('caller aborted')));
			});
		const client = createStyriaClient({ ...credentials, fetch });
		const caller = new AbortController();

		const result = client.get('1042', caller.signal).catch((error: unknown) => error);
		caller.abort();

		await expect(result).resolves.toEqual(
			expect.objectContaining({ code: 'STYRIA_UNAVAILABLE', message: 'STYRIA_UNAVAILABLE' })
		);
		expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
	});

	it('keeps the timeout active while reading a success response body', async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | null = null;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			requestSignal = init?.signal as AbortSignal;
			return {
				ok: true,
				status: 200,
				json: () =>
					new Promise((_resolve, reject) => {
						requestSignal?.addEventListener('abort', () => reject(new Error('raw PII')));
					})
			} as Response;
		};
		const client = createStyriaClient({ ...credentials, timeoutMs: 25, fetch });

		const result = client.get('1042').catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(25);

		await expect(result).resolves.toEqual(
			expect.objectContaining({ code: 'STYRIA_TIMEOUT', message: 'STYRIA_TIMEOUT' })
		);
		expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
	});

	it('never logs request PII, signing material, or provider bodies', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const payload = styriaPayloadFixture();
		const fetch: typeof globalThis.fetch = async () => {
			throw new Error(
				`recipient=${payload.shipping_address.firstName} secret=${credentials.secretKey} raw-body`
			);
		};
		const client = createStyriaClient({ ...credentials, fetch });

		const error = await client.create(payload).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(StyriaError);
		expect(error).toEqual(
			expect.objectContaining({ code: 'STYRIA_UNAVAILABLE', message: 'STYRIA_UNAVAILABLE' })
		);
		expect(error).not.toHaveProperty('cause');
		expect(String(error)).not.toContain(payload.shipping_address.firstName);
		expect(String(error)).not.toContain(credentials.secretKey);
		expect(consoleError).not.toHaveBeenCalled();
		expect(consoleWarn).not.toHaveBeenCalled();
		expect(consoleLog).not.toHaveBeenCalled();
	});
});
