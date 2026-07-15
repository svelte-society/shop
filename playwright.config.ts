import { defineConfig, devices } from '@playwright/test';

const PUBLIC_TEST_ENV = [
	'NODE_ENV=test',
	'TEST_CATALOG_FIXTURE=true',
	'CHECKOUT_ENABLED=false',
	'PRODUCTION_ORIGIN=https://shop.sveltesociety.dev',
	'SUPPORT_EMAIL=merch@sveltesociety.dev'
].join(' ');

const PRIVATE_TEST_ENV = [
	'STRIPE_SECRET_KEY=sk_test_catalog_fixture',
	'STRIPE_PAID_SHIPPING_RATE_ID=shr_test_paid',
	'STRIPE_FREE_SHIPPING_RATE_ID=shr_test_free'
].join(' ');

function fixtureServer(
	port: number,
	storefrontEnabled: boolean,
	scenario: 'available' | 'unavailable' | 'guard-proof'
) {
	return {
		command: `${PUBLIC_TEST_ENV} ${PRIVATE_TEST_ENV} STOREFRONT_ENABLED=${storefrontEnabled} TEST_CATALOG_SCENARIO=${scenario} pnpm exec vite dev --host 127.0.0.1 --port ${port} --strictPort`,
		port,
		reuseExistingServer: false,
		timeout: 120_000
	};
}

export default defineConfig({
	testDir: 'tests/e2e',
	testMatch: '**/*.spec.ts',
	fullyParallel: true,
	forbidOnly: true,
	retries: 0,
	reporter: 'list',
	use: {
		baseURL: 'http://127.0.0.1:4173',
		trace: 'retain-on-failure'
	},
	webServer: [
		fixtureServer(4173, true, 'available'),
		fixtureServer(4174, true, 'unavailable'),
		fixtureServer(4175, false, 'guard-proof')
	],
	projects: [
		{
			name: 'chromium-320',
			use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 900 } }
		},
		{
			name: 'chromium-768',
			use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } }
		},
		{
			name: 'firefox-1024',
			use: { ...devices['Desktop Firefox'], viewport: { width: 1024, height: 900 } }
		},
		{
			name: 'webkit-1440',
			use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1000 } }
		}
	]
});
