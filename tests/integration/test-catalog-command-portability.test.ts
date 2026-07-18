import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import playwrightConfig from '../../playwright.config';

const INLINE_ENV_ASSIGNMENT = /(?:^|\s)[A-Z][A-Z0-9_]*=[^\s]+/;
const SHARED_FIXTURE_ENV = {
	NODE_ENV: 'test',
	TEST_CATALOG_FIXTURE: 'true',
	CHECKOUT_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	STRIPE_SECRET_KEY: 'sk_test_catalog_fixture',
	STRIPE_WEBHOOK_SECRET: 'whsec_test_fixture',
	STRIPE_PAID_SHIPPING_RATE_ID: 'shr_test_paid',
	STRIPE_FREE_SHIPPING_RATE_ID: 'shr_test_free'
} as const;
const POLICY_FIXTURE_ENV = {
	SELLER_LEGAL_NAME: 'Svelte School AB',
	SELLER_REGISTRATION_NUMBER: 'reviewed-registration',
	SELLER_VAT_NUMBER: 'reviewed-vat-number',
	SELLER_ADDRESS_LINE1: 'Reviewed street 1',
	SELLER_POSTAL_CODE: '123 45',
	SELLER_CITY: 'Reviewed city',
	SELLER_COUNTRY: 'Sweden',
	SELLER_EMAIL: 'merchant@example.com',
	DELIVERY_ESTIMATE_EU: 'Reviewed EU estimate',
	DELIVERY_ESTIMATE_US: 'Reviewed US estimate',
	POLICY_EFFECTIVE_DATE: '2026-07-17'
} as const;

async function importLauncher() {
	return import('../../scripts/dev-test-catalog.mjs');
}

describe('test catalog command portability', () => {
	it('keeps the package preview command platform-neutral', async () => {
		const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
			scripts: Record<string, string>;
		};
		const command = packageJson.scripts['dev:test-catalog'];

		expect(command).toBe('node scripts/dev-test-catalog.mjs');
		expect(command).not.toMatch(INLINE_ENV_ASSIGNMENT);
	});

	it('builds one fixture artifact before the Playwright servers start', async () => {
		const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
			scripts: Record<string, string>;
		};
		const gitignore = await readFile('.gitignore', 'utf8');
		const dockerignore = await readFile('.dockerignore', 'utf8');
		const readme = await readFile('README.md', 'utf8');

		expect(packageJson.scripts['build:test-e2e']).toBe('node scripts/build-test-e2e.mjs');
		expect(packageJson.scripts['test:e2e']).toBe('pnpm run build:test-e2e && playwright test');
		expect(playwrightConfig.workers).toBe(2);
		expect(gitignore).toContain('/build-e2e\n');
		expect(dockerignore).toContain('build-e2e\n');
		expect(readme).toContain('pnpm test:e2e');
		expect(readme).not.toContain('pnpm playwright test');
	});

	it('passes fixture variables through webServer.env for every scenario', () => {
		const configuredServers = playwrightConfig.webServer;
		const webServers = Array.isArray(configuredServers) ? configuredServers : [configuredServers];
		const scenarios = [
			{ port: 4273, storefront: 'true', checkout: 'false', scenario: 'available' },
			{ port: 4274, storefront: 'true', checkout: 'false', scenario: 'unavailable' },
			{ port: 4275, storefront: 'false', checkout: 'false', scenario: 'guard-proof' },
			{
				port: 4276,
				storefront: 'true',
				checkout: 'true',
				scenario: 'available',
				stripeScenario: 'verified'
			}
		] as const;

		expect(webServers).toHaveLength(5);
		for (const [index, server] of webServers.slice(0, scenarios.length).entries()) {
			const expected = scenarios[index];
			expect(server?.command).toBe('node build-e2e');
			expect(server?.command).not.toMatch(INLINE_ENV_ASSIGNMENT);
			expect(server?.env).toEqual({
				...SHARED_FIXTURE_ENV,
				...POLICY_FIXTURE_ENV,
				HOST: '127.0.0.1',
				PORT: String(expected.port),
				ORIGIN: `http://127.0.0.1:${expected.port}`,
				CHECKOUT_ENABLED: expected.checkout,
				STOREFRONT_ENABLED: expected.storefront,
				TEST_CATALOG_SCENARIO: expected.scenario,
				...('stripeScenario' in expected ? { TEST_STRIPE_SCENARIO: expected.stripeScenario } : {})
			});
		}
		const withdrawalServer = webServers[4];
		expect(withdrawalServer?.command).toBe('node build-e2e');
		expect(withdrawalServer?.command).not.toMatch(INLINE_ENV_ASSIGNMENT);
		expect(withdrawalServer?.env).toEqual({
			NODE_ENV: 'development',
			HOST: '127.0.0.1',
			PORT: '4277',
			ORIGIN: 'http://127.0.0.1:4277',
			STOREFRONT_ENABLED: 'false',
			CHECKOUT_ENABLED: 'false',
			DATABASE_BOOTSTRAP: 'true',
			SCHEDULER_ENABLED: 'false',
			DATABASE_PATH: expect.stringMatching(/svelte-society-withdrawal-e2e-\d+\.sqlite$/u),
			PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
			SUPPORT_EMAIL: 'merch@sveltesociety.dev',
			PLUNK_SECRET_KEY: 'sk_test_withdrawal_e2e',
			PLUNK_FROM_NAME: 'Svelte Society Shop',
			PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
			PLUNK_BASE_URL: 'https://127.0.0.1:1',
			WITHDRAWAL_DATA_KEY: expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/u),
			...POLICY_FIXTURE_ENV
		});
	});

	it('applies the guarded fixture environment before building the shared artifact', async () => {
		const { buildTestE2e } = await import('../../scripts/build-test-e2e.mjs');
		const environment: Record<string, string | undefined> = { EXISTING_VALUE: 'preserved' };
		const build = vi.fn(async () => undefined);

		await buildTestE2e({
			environment,
			loadVite: async () => ({ build })
		});

		expect(environment).toEqual({
			EXISTING_VALUE: 'preserved',
			NODE_ENV: 'test',
			TEST_CATALOG_FIXTURE: 'true',
			TEST_E2E_BUILD_OUT: 'build-e2e'
		});
		expect(build).toHaveBeenCalledOnce();
	});

	it('applies the guarded fixture environment before starting Vite on the strict preview port', async () => {
		const { startTestCatalogPreview } = await importLauncher();
		const environment: Record<string, string | undefined> = { EXISTING_VALUE: 'preserved' };
		const listen = vi.fn(async () => undefined);
		const close = vi.fn(async () => undefined);
		const server = { listen, close };
		const createServer = vi.fn(async () => server);
		const output = { log: vi.fn() };

		const startedServer = await startTestCatalogPreview({
			environment,
			loadVite: async () => ({ createServer }),
			output
		});

		expect(environment).toEqual({
			EXISTING_VALUE: 'preserved',
			...SHARED_FIXTURE_ENV,
			STOREFRONT_ENABLED: 'true',
			TEST_CATALOG_SCENARIO: 'available'
		});
		expect(createServer).toHaveBeenCalledWith({
			server: { host: '127.0.0.1', port: 4173, strictPort: true }
		});
		expect(listen).toHaveBeenCalledOnce();
		expect(output.log).toHaveBeenCalledWith('Test catalog preview: http://127.0.0.1:4173/');
		expect(startedServer).toBe(server);
	});

	it('awaits server cleanup and surfaces the failure when the strict port cannot be opened', async () => {
		const { startTestCatalogPreview } = await importLauncher();
		const listenFailure = new Error('STRICT_PORT_UNAVAILABLE');
		const listen = vi.fn(async () => Promise.reject(listenFailure));
		let releaseClose!: () => void;
		const closeBarrier = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const close = vi.fn(async () => closeBarrier);
		const createServer = vi.fn(async () => ({ listen, close }));
		const output = { log: vi.fn() };
		let startupSettled = false;

		const startup = startTestCatalogPreview({
			environment: {},
			loadVite: async () => ({ createServer }),
			output
		})
			.then(
				(value) => ({ status: 'fulfilled' as const, value }),
				(reason: unknown) => ({ status: 'rejected' as const, reason })
			)
			.finally(() => {
				startupSettled = true;
			});

		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
		expect(startupSettled).toBe(false);
		expect(listen.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
		releaseClose();

		expect(await startup).toEqual({ status: 'rejected', reason: listenFailure });
		expect(output.log).not.toHaveBeenCalled();
	});
});
