import { describe, expect, it, vi } from 'vitest';
import type { ReadinessResult } from '$lib/server/health/readiness.server';
import { GET as live } from './live/+server';
import { _createReadinessGet } from './ready/+server';

const healthy: ReadinessResult = {
	ready: true,
	checks: {
		configuration: 'ok',
		database: 'ok',
		migrations: 'ok',
		volume: 'ok',
		disk: 'ok'
	}
};

describe('health routes', () => {
	it('returns static process liveness without consulting readiness', async () => {
		const response = await live({} as Parameters<typeof live>[0]);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		await expect(response.json()).resolves.toEqual({ status: 'live' });
	});

	it('returns only healthy local check names with 200', async () => {
		const check = vi.fn(async () => healthy);
		const handler = _createReadinessGet(check);
		const response = await handler({} as Parameters<typeof handler>[0]);

		expect(check).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ status: 'ready', checks: healthy.checks });
	});

	it('returns only failed local check names with 503', async () => {
		const unhealthy: ReadinessResult = {
			ready: false,
			checks: { ...healthy.checks, database: 'failed', disk: 'low' }
		};
		const handler = _createReadinessGet(async () => unhealthy);
		const response = await handler({} as Parameters<typeof handler>[0]);
		const text = await response.text();

		expect(response.status).toBe(503);
		expect(JSON.parse(text)).toEqual({ status: 'not_ready', checks: unhealthy.checks });
		expect(text).not.toContain('sqlite');
		expect(text).not.toContain('error');
	});

	it('fails closed with sanitized checks when the readiness check throws', async () => {
		const handler = _createReadinessGet(async () => {
			throw new Error('private path and secret');
		});
		const response = await handler({} as Parameters<typeof handler>[0]);
		const text = await response.text();

		expect(response.status).toBe(503);
		expect(JSON.parse(text)).toEqual({
			status: 'not_ready',
			checks: {
				configuration: 'failed',
				database: 'failed',
				migrations: 'failed',
				volume: 'failed',
				disk: 'failed'
			}
		});
		expect(text).not.toContain('private path');
		expect(text).not.toContain('secret');
	});
});
