export type RateLimitPolicy = Readonly<{ limit: number; windowMs: number }>;

export const rateLimitPolicies = Object.freeze({
	checkout: Object.freeze({ limit: 10, windowMs: 60_000 }),
	webhook: Object.freeze({ limit: 120, windowMs: 60_000 }),
	mcp: Object.freeze({ limit: 60, windowMs: 60_000 }),
	invalidMcpAuth: Object.freeze({ limit: 10, windowMs: 15 * 60_000 })
});

type Bucket = { count: number; expiresAt: number };

export type FixedWindowRateLimiter = {
	take(key: string, policy: RateLimitPolicy, now?: number): boolean;
	size(): number;
};

function validPolicy(policy: RateLimitPolicy): boolean {
	return (
		Number.isSafeInteger(policy.limit) &&
		policy.limit > 0 &&
		Number.isSafeInteger(policy.windowMs) &&
		policy.windowMs > 0
	);
}

export function createFixedWindowRateLimiter(): FixedWindowRateLimiter {
	const buckets = new Map<string, Bucket>();

	return {
		take(key, policy, now = Date.now()) {
			if (key.length === 0 || !validPolicy(policy) || !Number.isFinite(now) || now < 0)
				return false;

			for (const [bucketKey, bucket] of buckets) {
				if (bucket.expiresAt <= now) buckets.delete(bucketKey);
			}

			const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
			const bucketKey = `${policy.limit}:${policy.windowMs}:${key}`;
			const current = buckets.get(bucketKey);
			if (!current || current.expiresAt <= now) {
				buckets.set(bucketKey, { count: 1, expiresAt: windowStart + policy.windowMs });
				return true;
			}
			if (current.count >= policy.limit) return false;
			current.count += 1;
			return true;
		},
		size() {
			return buckets.size;
		}
	};
}

const processLimiter = createFixedWindowRateLimiter();

export function takeRateLimit(key: string, policy: RateLimitPolicy, now?: number): boolean {
	return processLimiter.take(key, policy, now);
}
