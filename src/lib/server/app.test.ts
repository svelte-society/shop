import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkRuntimeReadiness } from '$lib/server/health/readiness.server';
import { SHOP_CONFIG } from '$lib/config/shop';
import {
	parseApplicationDeploymentConfig,
	requireSchedulerDeploymentConfig
} from '$lib/config/deployment.server';
import { RESEND_DEFAULT_BASE_URL, RESEND_DEFAULT_TIMEOUT_MS } from './email/resend.server';
import { STYRIA_DEFAULT_BASE_URL, STYRIA_DEFAULT_TIMEOUT_MS } from './styria/client.server';
import { createApplicationLifecycle, type WithdrawalRuntime } from './app.server';

const migrationsDirectory = resolve('migrations');
const dataKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64');
const withdrawalEnvironment = {
	DATABASE_PATH: ':memory:',
	DATABASE_BOOTSTRAP: 'false',
	SCHEDULER_ENABLED: 'false',
	STYRIA_AUTO_SUBMIT_ENABLED: 'false',
	STOREFRONT_ENABLED: 'false',
	CHECKOUT_ENABLED: 'false',
	MCP_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://merch.sveltesociety.dev',
	RESEND_API_KEY: 're_test_withdrawal_runtime',
	WITHDRAWAL_DATA_KEY: dataKey
};

describe('application withdrawal runtime', () => {
	it('uses source-owned shop identity and provider defaults', () => {
		const configuration = parseApplicationDeploymentConfig({
			...withdrawalEnvironment,
			DATABASE_PATH: ':memory:',
			SCHEDULER_ENABLED: 'true',
			STRIPE_SECRET_KEY: 'sk_test_defaults',
			STYRIA_APP_ID: 'default-app',
			STYRIA_SECRET_KEY: 'default-secret',
			SUPPORT_EMAIL: 'legacy-support@example.test',
			ADMIN_EMAIL: 'legacy-admin@example.test',
			EMAIL_FROM_NAME: 'Legacy sender',
			EMAIL_FROM_ADDRESS: 'legacy-sender@example.test',
			STYRIA_BRAND_NAME: 'Legacy brand'
		});
		const scheduler = requireSchedulerDeploymentConfig(configuration);

		expect(configuration.email).toMatchObject({
			provider: {
				baseUrl: RESEND_DEFAULT_BASE_URL,
				timeoutMs: RESEND_DEFAULT_TIMEOUT_MS
			},
			from: {
				name: SHOP_CONFIG.email.fromName,
				email: SHOP_CONFIG.email.fromAddress
			},
			adminEmail: SHOP_CONFIG.contact.adminEmail
		});
		expect(configuration.withdrawal.supportEmail).toBe(SHOP_CONFIG.contact.supportEmail);
		expect(scheduler.styria).toMatchObject({
			baseUrl: STYRIA_DEFAULT_BASE_URL,
			timeoutMs: STYRIA_DEFAULT_TIMEOUT_MS,
			brandName: SHOP_CONFIG.styria.brandName
		});
	});

	it('rejects automatic Styria submission when the scheduler is disabled', async () => {
		const application = createApplicationLifecycle({ migrationsDirectory });

		await expect(
			application.start({
				environment: {
					...withdrawalEnvironment,
					STYRIA_AUTO_SUBMIT_ENABLED: 'true'
				},
				building: false,
				test: false
			})
		).rejects.toThrowError('APPLICATION_CONFIG_INVALID');
		expect(application.current()).toBeNull();
	});

	it('constructs one withdrawal runtime with commerce and scheduler disabled and no Stripe or Styria', async () => {
		const application = createApplicationLifecycle({ migrationsDirectory });
		const options = {
			environment: withdrawalEnvironment,
			building: false,
			test: false
		};

		const firstStart = application.start(options);
		const secondStart = application.start(options);
		const runtime = await firstStart;

		expect(secondStart).toBe(firstStart);
		expect(runtime).toBe(application.current());
		expect(runtime?.scheduler).toBeNull();
		expect(runtime?.withdrawal.repository).toBeDefined();
		expect(runtime?.withdrawal.worker).toBeDefined();
		expect(runtime?.withdrawal.submission).toBeDefined();
		expect(runtime?.withdrawal.reader).toBeDefined();
		expect(runtime?.withdrawal.retention).toBeDefined();
		expect(runtime?.withdrawal.seller).toEqual({
			legalName: SHOP_CONFIG.sellerPolicy.legalName,
			registrationNumber: SHOP_CONFIG.sellerPolicy.registrationNumber,
			addressLine1: SHOP_CONFIG.sellerPolicy.addressLine1,
			postalCode: SHOP_CONFIG.sellerPolicy.postalCode,
			city: SHOP_CONFIG.sellerPolicy.city,
			country: SHOP_CONFIG.sellerPolicy.country,
			email: SHOP_CONFIG.contact.sellerEmail
		});
		expect(runtime?.withdrawal.dataKey.equals(Buffer.from(dataKey, 'base64'))).toBe(true);
		expect(runtime?.configuration).toEqual({
			features: {
				storefrontEnabled: false,
				checkoutEnabled: false,
				mcpEnabled: false,
				schedulerEnabled: false,
				automaticStyriaSubmissionEnabled: false
			},
			databaseBootstrap: false,
			productionReady: false
		});
		expect(JSON.stringify(runtime?.configuration)).not.toContain(dataKey);

		const readiness = await checkRuntimeReadiness(runtime!, { ignoreSchedulerLatch: true });
		expect(JSON.stringify(readiness)).not.toContain(dataKey);
		expect(JSON.stringify(readiness)).not.toContain(SHOP_CONFIG.sellerPolicy.addressLine1);
		await application.stop();
		expect(runtime?.database.open).toBe(false);
	});

	it('passes the same withdrawal worker and repository to a configured scheduler', async () => {
		let receivedWithdrawal: WithdrawalRuntime | undefined;
		const scheduler = {
			start: vi.fn(),
			stop: vi.fn(async () => undefined),
			runOutboxOnce: vi.fn(async () => undefined),
			runStyriaSyncOnce: vi.fn(async () => undefined),
			runBackupOnce: vi.fn(async () => undefined),
			runWithdrawalRetentionOnce: vi.fn(async () => undefined)
		};
		const createScheduler = vi.fn((_database, _environment, withdrawal) => {
			receivedWithdrawal = withdrawal;
			return scheduler;
		});
		const application = createApplicationLifecycle({
			migrationsDirectory,
			createScheduler,
			checkReadiness: async () => ({ ready: true })
		});

		const runtime = await application.start({
			environment: { ...withdrawalEnvironment, SCHEDULER_ENABLED: 'true' },
			building: false,
			test: false
		});

		expect(createScheduler).toHaveBeenCalledOnce();
		expect(receivedWithdrawal).toBe(runtime?.withdrawal);
		expect(receivedWithdrawal?.worker).toBe(runtime?.withdrawal.worker);
		expect(receivedWithdrawal?.repository).toBe(runtime?.withdrawal.repository);
		expect(receivedWithdrawal?.retention).toBe(runtime?.withdrawal.retention);
		expect(scheduler.start).toHaveBeenCalledOnce();
		await application.stop();
		expect(scheduler.stop).toHaveBeenCalledOnce();
	});
});
