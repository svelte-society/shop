import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: ChildProcess;
let baseUrl: URL;
let serverOutput = '';

async function availablePort(): Promise<number> {
	const probe = createServer();

	await new Promise<void>((resolveListen, reject) => {
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', resolveListen);
	});

	const address = probe.address();
	if (address === null || typeof address === 'string') throw new Error('TEST_PORT_UNAVAILABLE');

	await new Promise<void>((resolveClose, reject) => {
		probe.close((error) => (error ? reject(error) : resolveClose()));
	});

	return address.port;
}

function disabledStorefrontEnvironment(): NodeJS.ProcessEnv {
	const testEnv: NodeJS.ProcessEnv = {
		...process.env,
		NODE_ENV: 'test',
		STOREFRONT_ENABLED: 'false',
		CHECKOUT_ENABLED: 'false',
		PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
		SUPPORT_EMAIL: 'merch@sveltesociety.dev'
	};

	delete testEnv.STRIPE_SECRET_KEY;
	delete testEnv.STRIPE_PAID_SHIPPING_RATE_ID;
	delete testEnv.STRIPE_FREE_SHIPPING_RATE_ID;

	return testEnv;
}

async function waitForServer(url: URL): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (server.exitCode !== null) {
			throw new Error(`TEST_SERVER_EXITED\n${serverOutput}`);
		}

		try {
			await fetch(url);
			return;
		} catch {
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
	}

	throw new Error(`TEST_SERVER_TIMEOUT\n${serverOutput}`);
}

beforeAll(async () => {
	const port = await availablePort();
	baseUrl = new URL(`http://127.0.0.1:${port}`);
	server = spawn(
		process.execPath,
		[
			resolve(process.cwd(), 'node_modules/vite/bin/vite.js'),
			'dev',
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
			'--strictPort'
		],
		{
			cwd: process.cwd(),
			env: disabledStorefrontEnvironment(),
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);

	server.stdout?.on('data', (chunk: Buffer) => {
		serverOutput += chunk.toString();
	});
	server.stderr?.on('data', (chunk: Buffer) => {
		serverOutput += chunk.toString();
	});

	await waitForServer(baseUrl);
}, 15_000);

afterAll(async () => {
	if (server.exitCode === null) {
		server.kill('SIGTERM');
		await new Promise<void>((resolveExit) => server.once('exit', () => resolveExit()));
	}
});

describe('disabled storefront request gate', () => {
	it('redirects cart before private Stripe configuration and renders OpeningSoon at root', async () => {
		const cartResponse = await fetch(new URL('/cart', baseUrl), { redirect: 'manual' });

		expect([303, 307]).toContain(cartResponse.status);
		expect(cartResponse.headers.get('location')).toBe('/');

		const rootResponse = await fetch(new URL('/', baseUrl));
		const rootHtml = await rootResponse.text();

		expect(rootResponse.status).toBe(200);
		expect(rootHtml).toContain('The collection is getting ready.');
	});

	it.each(['/privacy', '/health/live'])(
		'leaves non-commerce request %s unaffected',
		async (path) => {
			const response = await fetch(new URL(path, baseUrl), { redirect: 'manual' });

			expect(response.status).toBe(404);
			expect(response.headers.get('location')).toBeNull();
		}
	);
});
