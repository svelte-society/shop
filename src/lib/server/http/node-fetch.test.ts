import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFetch } from './node-fetch.server';

type TestServer = ReturnType<typeof createServer> | ReturnType<typeof createHttpsServer>;
const servers: TestServer[] = [];
const fixtures = resolve(import.meta.dirname, '../../../../tests/fixtures');
const certificate = readFileSync(resolve(fixtures, 'provider-cert.pem'));
const privateKey = readFileSync(resolve(fixtures, 'provider-key.pem'));

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				})
		)
	);
});

describe('nodeFetch', () => {
	it('returns HTTPS status, headers, and body through the explicit test CA', async () => {
		const server = createHttpsServer(
			{ key: privateKey, cert: certificate },
			(_request, response) => {
				response.writeHead(202, { 'content-type': 'application/json', 'x-provider': 'fixture' });
				response.end(JSON.stringify({ accepted: true }));
			}
		);
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_INVALID');

		const response = await nodeFetch(
			`https://127.0.0.1:${address.port}/send`,
			{},
			{ ca: certificate }
		);

		expect(response.status).toBe(202);
		expect(response.headers.get('x-provider')).toBe('fixture');
		await expect(response.json()).resolves.toEqual({ accepted: true });
	});

	it('destroys an in-flight provider socket when the caller aborts', async () => {
		let acceptRequest: (() => void) | undefined;
		let observeClose: (() => void) | undefined;
		const accepted = new Promise<void>((resolve) => {
			acceptRequest = resolve;
		});
		const closed = new Promise<void>((resolve) => {
			observeClose = resolve;
		});
		const server = createServer((request) => {
			acceptRequest?.();
			request.socket.once('close', () => observeClose?.());
			// Deliberately withhold response headers and body.
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_INVALID');
		const controller = new AbortController();

		const result = nodeFetch(`http://127.0.0.1:${address.port}`, {
			signal: controller.signal
		}).catch((error: unknown) => error);
		await accepted;
		controller.abort();

		await expect(result).resolves.toEqual(expect.objectContaining({ name: 'AbortError' }));
		await expect(closed).resolves.toBeUndefined();
	});

	it('rejects a response larger than the fixed production limit', async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/octet-stream' });
			response.end(Buffer.alloc(2 * 1024 * 1024 + 1));
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_INVALID');

		await expect(nodeFetch(`http://127.0.0.1:${address.port}`)).rejects.toThrow(
			'HTTP_RESPONSE_TOO_LARGE'
		);
	});

	it('rejects unsupported protocols and request body types before network I/O', async () => {
		await expect(nodeFetch('ftp://provider.example.test')).rejects.toThrow(
			'HTTP_PROTOCOL_UNSUPPORTED'
		);
		expect(() =>
			nodeFetch('https://provider.example.test', { body: new URLSearchParams({ secret: 'no' }) })
		).toThrow('HTTP_REQUEST_BODY_UNSUPPORTED');
	});
});
