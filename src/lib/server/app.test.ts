import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkRuntimeReadiness } from '$lib/server/health/readiness.server';
import { createApplicationLifecycle, type WithdrawalRuntime } from './app.server';

const migrationsDirectory = resolve('migrations');
const dataKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64');
const withdrawalEnvironment = {
	DATABASE_PATH: ':memory:',
	DATABASE_BOOTSTRAP: 'false',
	SCHEDULER_ENABLED: 'false',
	STOREFRONT_ENABLED: 'false',
	CHECKOUT_ENABLED: 'false',
	MCP_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://merch.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	PLUNK_SECRET_KEY: 'sk_test_withdrawal_runtime',
	PLUNK_FROM_NAME: 'Svelte Society Shop',
	PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
	WITHDRAWAL_DATA_KEY: dataKey,
	SELLER_LEGAL_NAME: 'Svelte Society Merch AB',
	SELLER_REGISTRATION_NUMBER: '559999-0000',
	SELLER_VAT_NUMBER: 'SE559999000001',
	SELLER_ADDRESS_LINE1: 'Registered Street 1',
	SELLER_POSTAL_CODE: '111 11',
	SELLER_CITY: 'Stockholm',
	SELLER_COUNTRY: 'Sweden',
	SELLER_EMAIL: 'merch@sveltesociety.dev',
	DELIVERY_ESTIMATE_EU: '3–7 business days',
	DELIVERY_ESTIMATE_US: '5–10 business days',
	POLICY_EFFECTIVE_DATE: '2026-07-17'
};

describe('application withdrawal runtime', () => {
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
		expect(runtime?.withdrawal.dataKey.equals(Buffer.from(dataKey, 'base64'))).toBe(true);
		expect(runtime?.environment.STRIPE_SECRET_KEY).toBeUndefined();
		expect(runtime?.environment.STYRIA_SECRET_KEY).toBeUndefined();

		const readiness = await checkRuntimeReadiness(runtime!, { ignoreSchedulerLatch: true });
		expect(JSON.stringify(readiness)).not.toContain(dataKey);
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
			runBackupOnce: vi.fn(async () => undefined)
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
		expect(scheduler.start).toHaveBeenCalledOnce();
		await application.stop();
		expect(scheduler.stop).toHaveBeenCalledOnce();
	});
});
