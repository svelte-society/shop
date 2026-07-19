import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
	createApplicationLifecycle,
	registerApplicationShutdown,
	type ApplicationLifecycle
} from './app.server';

const withdrawalEnvironment = {
	PRODUCTION_ORIGIN: 'https://merch.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	PLUNK_SECRET_KEY: 'sk_test_shutdown',
	PLUNK_FROM_NAME: 'Svelte Society Shop',
	PLUNK_FROM_EMAIL: 'merch@sveltesociety.dev',
	WITHDRAWAL_DATA_KEY: Buffer.alloc(32, 11).toString('base64'),
	SELLER_LEGAL_NAME: 'Svelte Society Merch AB',
	SELLER_REGISTRATION_NUMBER: '559999-0000',
	SELLER_VAT_NUMBER: 'SE559999000001',
	SELLER_ADDRESS_LINE1: 'Registered Street 1',
	SELLER_POSTAL_CODE: '111 11',
	SELLER_CITY: 'Stockholm',
	SELLER_COUNTRY: 'Sweden',
	SELLER_EMAIL: 'merch@sveltesociety.dev',
	DELIVERY_ESTIMATE_EU: '3–7 business days',
	DELIVERY_ESTIMATE_ASIA: '7–15 business days',
	STYRIA_SUPPORTED_COUNTRIES: 'SE,JP,TW',
	POLICY_EFFECTIVE_DATE: '2026-07-17'
};

function lifecycle(stop: () => Promise<void>): ApplicationLifecycle {
	return {
		start: vi.fn(async () => null),
		current: vi.fn(() => null),
		stop: vi.fn(stop)
	};
}

describe('application shutdown', () => {
	it('registers one SvelteKit shutdown listener and updates its lifecycle across reloads', async () => {
		const processTarget = new EventEmitter();
		const first = lifecycle(async () => undefined);
		const latest = lifecycle(async () => undefined);

		registerApplicationShutdown(first, processTarget);
		registerApplicationShutdown(first, processTarget);
		registerApplicationShutdown(latest, processTarget);

		expect(processTarget.listenerCount('sveltekit:shutdown')).toBe(1);
		const listener = processTarget.rawListeners('sveltekit:shutdown')[0];
		expect(listener).toBeTypeOf('function');
		await listener?.('SIGTERM');

		expect(first.stop).not.toHaveBeenCalled();
		expect(latest.stop).toHaveBeenCalledOnce();
	});

	it('awaits the scheduler before closing SQLite and reporting completion', async () => {
		const sequence: string[] = [];
		let releaseScheduler: (() => void) | undefined;
		const schedulerStopped = new Promise<void>((resolve) => {
			releaseScheduler = resolve;
		});
		const scheduler = {
			start: vi.fn(),
			stop: vi.fn(async () => {
				sequence.push('scheduler-stop-started');
				await schedulerStopped;
				sequence.push('scheduler-stopped');
			}),
			runOutboxOnce: vi.fn(async () => undefined),
			runStyriaSyncOnce: vi.fn(async () => undefined),
			runBackupOnce: vi.fn(async () => undefined)
		};
		const application = createApplicationLifecycle({
			migrationsDirectory: 'migrations',
			openDatabase: vi.fn(() => ({ open: true }) as never),
			migrate: vi.fn(),
			closeDatabase: vi.fn(() => sequence.push('database-closed')),
			checkReadiness: vi.fn(async () => ({ ready: true })),
			createScheduler: vi.fn(() => scheduler),
			reportShutdown: vi.fn((event) => sequence.push(event))
		});
		await application.start({
			environment: {
				...withdrawalEnvironment,
				DATABASE_PATH: '/data/shop.sqlite',
				SCHEDULER_ENABLED: 'true'
			},
			building: false,
			test: false
		});

		const stopping = application.stop();
		await Promise.resolve();
		expect(sequence).toEqual(['scheduler-stop-started']);

		releaseScheduler?.();
		await stopping;
		expect(sequence).toEqual([
			'scheduler-stop-started',
			'scheduler-stopped',
			'scheduler_stopped',
			'database-closed',
			'database_closed'
		]);
	});

	it('keeps SQLite open when scheduler settlement cannot be proven', async () => {
		const closeDatabase = vi.fn();
		const scheduler = {
			start: vi.fn(),
			stop: vi.fn(async () => {
				throw new Error('scheduler settlement failed');
			}),
			runOutboxOnce: vi.fn(async () => undefined),
			runStyriaSyncOnce: vi.fn(async () => undefined),
			runBackupOnce: vi.fn(async () => undefined)
		};
		const application = createApplicationLifecycle({
			migrationsDirectory: 'migrations',
			openDatabase: vi.fn(() => ({ open: true }) as never),
			migrate: vi.fn(),
			closeDatabase,
			checkReadiness: vi.fn(async () => ({ ready: true })),
			createScheduler: vi.fn(() => scheduler)
		});
		await application.start({
			environment: {
				...withdrawalEnvironment,
				DATABASE_PATH: '/data/shop.sqlite',
				SCHEDULER_ENABLED: 'true'
			},
			building: false,
			test: false
		});

		await expect(application.stop()).rejects.toThrow('scheduler settlement failed');
		expect(closeDatabase).not.toHaveBeenCalled();
		expect(application.current()).not.toBeNull();
	});
});
