import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHARED_FIXTURE_ENV = {
	NODE_ENV: 'test',
	TEST_CATALOG_FIXTURE: 'true',
	CHECKOUT_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	STRIPE_SECRET_KEY: 'sk_test_catalog_fixture',
	STRIPE_WEBHOOK_SECRET: 'whsec_test_fixture',
	STRIPE_PAID_SHIPPING_RATE_ID: 'shr_test_paid',
	STRIPE_FREE_SHIPPING_RATE_ID: 'shr_test_free',
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

function fixtureServer(
	port: number,
	storefrontEnabled: boolean,
	scenario: 'available' | 'unavailable' | 'guard-proof',
	checkoutEnabled = false,
	stripeScenario?: 'verified'
) {
	return {
		command: 'node build-e2e',
		env: {
			...SHARED_FIXTURE_ENV,
			HOST: '127.0.0.1',
			PORT: String(port),
			ORIGIN: `http://127.0.0.1:${port}`,
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

function withdrawalServer() {
	return {
		command: 'node build-e2e',
		env: {
			NODE_ENV: 'development',
			HOST: '127.0.0.1',
			PORT: '4277',
			ORIGIN: 'http://127.0.0.1:4277',
			STOREFRONT_ENABLED: 'false',
			CHECKOUT_ENABLED: 'false',
			DATABASE_BOOTSTRAP: 'true',
			SCHEDULER_ENABLED: 'false',
			DATABASE_PATH: join(tmpdir(), `svelte-society-withdrawal-e2e-${process.pid}.sqlite`),
			PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
			SUPPORT_EMAIL: 'merch@sveltesociety.dev',
			PLUNK_SECRET_KEY: 'sk_test_withdrawal_e2e',
			PLUNK_FROM_NAME: 'Svelte Society Shop',
			PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
			PLUNK_BASE_URL: 'https://127.0.0.1:1',
			WITHDRAWAL_DATA_KEY: randomBytes(32).toString('base64'),
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
		},
		port: 4277,
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
	workers: 2,
	reporter: 'list',
	use: {
		baseURL: 'http://127.0.0.1:4273',
		trace: 'retain-on-failure'
	},
	webServer: [
		fixtureServer(4273, true, 'available'),
		fixtureServer(4274, true, 'unavailable'),
		fixtureServer(4275, false, 'guard-proof'),
		fixtureServer(4276, true, 'available', true, 'verified'),
		withdrawalServer()
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
