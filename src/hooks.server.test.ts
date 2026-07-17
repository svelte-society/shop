import { describe, expect, it, vi } from 'vitest';
import type { ApplicationLifecycle } from '$lib/server/app.server';
import { createApplicationHandle } from './hooks.server';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe('server application hook', () => {
	it('serves static liveness without starting the database lifecycle', async () => {
		const application: ApplicationLifecycle = {
			current: () => null,
			start: vi.fn(),
			stop: vi.fn(async () => undefined)
		};
		const handle = createApplicationHandle(application, {
			environment: {},
			building: false,
			test: false
		});
		const resolve = vi.fn(async () => new Response('live'));

		const response = await handle({
			event: { url: new URL('https://shop.sveltesociety.dev/health/live') },
			resolve
		} as unknown as Parameters<typeof handle>[0]);

		expect(response).toBeInstanceOf(Response);
		expect(resolve).toHaveBeenCalledOnce();
		expect(application.start).not.toHaveBeenCalled();
	});

	it('starts the application once before resolving repeated requests', async () => {
		const order: string[] = [];
		const ready = deferred<null>();
		const application: ApplicationLifecycle = {
			current: () => null,
			start: vi.fn(() => {
				order.push('application-start');
				return ready.promise;
			}),
			stop: vi.fn(async () => undefined)
		};
		const handle = createApplicationHandle(application, {
			environment: {},
			building: false,
			test: true
		});
		const resolve = vi.fn(async () => {
			order.push('resolve');
			return new Response('ok');
		});
		const input = { event: {}, resolve } as unknown as Parameters<typeof handle>[0];

		const firstRequest = handle(input);
		await Promise.resolve();
		expect(resolve).not.toHaveBeenCalled();
		ready.resolve(null);
		await expect(firstRequest).resolves.toBeInstanceOf(Response);
		await expect(handle(input)).resolves.toBeInstanceOf(Response);

		expect(application.start).toHaveBeenCalledOnce();
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(order).toEqual(['application-start', 'resolve', 'resolve']);
	});

	it('keeps local-independent routes available when startup readiness fails and retries later', async () => {
		const application: ApplicationLifecycle = {
			current: () => null,
			start: vi
				.fn<ApplicationLifecycle['start']>()
				.mockRejectedValueOnce(new Error('STARTUP_NOT_READY'))
				.mockResolvedValue(null),
			stop: vi.fn(async () => undefined)
		};
		const handle = createApplicationHandle(application, {
			environment: {},
			building: false,
			test: false
		});
		const resolve = vi.fn(async () => new Response('ok'));
		const input = { event: {}, resolve } as unknown as Parameters<typeof handle>[0];

		await expect(handle(input)).resolves.toBeInstanceOf(Response);
		expect(resolve).toHaveBeenCalledOnce();
		await expect(handle(input)).resolves.toBeInstanceOf(Response);

		expect(application.start).toHaveBeenCalledTimes(2);
		expect(resolve).toHaveBeenCalledTimes(2);
	});
});
