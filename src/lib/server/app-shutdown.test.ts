import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
	createApplicationLifecycle,
	registerApplicationShutdown,
	type ApplicationLifecycle
} from './app.server';

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
			runStyriaSyncOnce: vi.fn(async () => undefined)
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
			environment: { DATABASE_PATH: '/data/shop.sqlite', SCHEDULER_ENABLED: 'true' },
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
});
