import { describe, expect, it } from 'vitest';
import { createFixedWindowRateLimiter, rateLimitPolicies } from './rate-limit.server';

describe('fixed-window rate limiter', () => {
	it('allows only the configured number of requests in a window', () => {
		const limiter = createFixedWindowRateLimiter();
		const policy = { limit: 2, windowMs: 1_000 };

		expect(limiter.take('checkout:192.0.2.1', policy, 100)).toBe(true);
		expect(limiter.take('checkout:192.0.2.1', policy, 200)).toBe(true);
		expect(limiter.take('checkout:192.0.2.1', policy, 999)).toBe(false);
		expect(limiter.take('checkout:192.0.2.2', policy, 999)).toBe(true);
		expect(limiter.take('checkout:192.0.2.1', policy, 1_000)).toBe(true);
	});

	it('prunes expired buckets while taking later requests', () => {
		const limiter = createFixedWindowRateLimiter();
		const policy = { limit: 1, windowMs: 1_000 };

		expect(limiter.take('old-a', policy, 0)).toBe(true);
		expect(limiter.take('old-b', policy, 10)).toBe(true);
		expect(limiter.size()).toBe(2);
		expect(limiter.take('current', policy, 1_000)).toBe(true);
		expect(limiter.size()).toBe(1);
	});

	it('fails closed at the injected hard bucket cap and admits after efficient expiry', () => {
		const limiter = createFixedWindowRateLimiter({ maxBuckets: 2 });
		const policy = { limit: 1, windowMs: 1_000 };

		expect(limiter.take('first', policy, 0)).toBe(true);
		expect(limiter.take('second', policy, 10)).toBe(true);
		expect(limiter.take('third', policy, 20)).toBe(false);
		expect(limiter.size()).toBe(2);
		expect(limiter.take('third', policy, 1_000)).toBe(true);
		expect(limiter.size()).toBe(1);
	});

	it('keeps storage bounded across many distinct keys and window resets', () => {
		const limiter = createFixedWindowRateLimiter({ maxBuckets: 4 });
		const policy = { limit: 2, windowMs: 10 };

		for (let index = 0; index < 1_000; index += 1) {
			limiter.take(`key-${index}`, policy, index);
			expect(limiter.size()).toBeLessThanOrEqual(4);
		}
		for (let window = 0; window < 1_000; window += 1) {
			expect(limiter.take('reused', policy, 10_000 + window * 10)).toBe(true);
			expect(limiter.size()).toBeLessThanOrEqual(4);
		}
	});

	it('rejects invalid hard-cap configuration', () => {
		expect(() => createFixedWindowRateLimiter({ maxBuckets: 0 })).toThrow(
			'RATE_LIMIT_MAX_BUCKETS_INVALID'
		);
		expect(() => createFixedWindowRateLimiter({ maxBuckets: 1.5 })).toThrow(
			'RATE_LIMIT_MAX_BUCKETS_INVALID'
		);
	});

	it('fails closed for invalid keys, policies, and clocks', () => {
		const limiter = createFixedWindowRateLimiter();

		expect(limiter.take('', { limit: 1, windowMs: 1_000 }, 0)).toBe(false);
		expect(limiter.take('key', { limit: 0, windowMs: 1_000 }, 0)).toBe(false);
		expect(limiter.take('key', { limit: 1, windowMs: Number.NaN }, 0)).toBe(false);
		expect(limiter.take('key', { limit: 1, windowMs: 1_000 }, Number.NaN)).toBe(false);
	});

	it('defines the approved one-replica policies exactly', () => {
		expect(rateLimitPolicies).toEqual({
			checkout: { limit: 10, windowMs: 60_000 },
			webhook: { limit: 120, windowMs: 60_000 },
			mcp: { limit: 60, windowMs: 60_000 },
			invalidMcpAuth: { limit: 10, windowMs: 15 * 60_000 }
		});
	});
});
