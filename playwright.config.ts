import { defineConfig, devices } from '@playwright/test';

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

function fixtureServer(
	port: number,
	storefrontEnabled: boolean,
	scenario: 'available' | 'unavailable' | 'guard-proof',
	checkoutEnabled = false,
	stripeScenario?: 'verified'
) {
	return {
		command: `pnpm exec vite dev --host 127.0.0.1 --port ${port} --strictPort`,
		env: {
			...SHARED_FIXTURE_ENV,
			STOREFRONT_ENABLED: storefrontEnabled ? 'true' : 'false',
			CHECKOUT_ENABLED: checkoutEnabled ? 'true' : 'false',
			TEST_CATALOG_SCENARIO: scenario,
			...(stripeScenario ? { TEST_STRIPE_SCENARIO: stripeScenario } : {})
		},
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
		baseURL: 'http://127.0.0.1:4273',
		trace: 'retain-on-failure'
	},
	webServer: [
		fixtureServer(4273, true, 'available'),
		fixtureServer(4274, true, 'unavailable'),
		fixtureServer(4275, false, 'guard-proof'),
		fixtureServer(4276, true, 'available', true, 'verified')
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
