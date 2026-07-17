export type RateLimitPolicy = Readonly<{ limit: number; windowMs: number }>;

export const rateLimitPolicies = Object.freeze({
	checkout: Object.freeze({ limit: 10, windowMs: 60_000 }),
	webhook: Object.freeze({ limit: 120, windowMs: 60_000 }),
	mcp: Object.freeze({ limit: 60, windowMs: 60_000 }),
	invalidMcpAuth: Object.freeze({ limit: 10, windowMs: 15 * 60_000 })
});

type Bucket = { count: number; expiresAt: number };
type Expiry = { bucketKey: string; expiresAt: number };

export const RATE_LIMIT_MAX_BUCKETS = 4_096;

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

function swap(heap: Expiry[], left: number, right: number): void {
	[heap[left], heap[right]] = [heap[right], heap[left]];
}

function pushExpiry(heap: Expiry[], expiry: Expiry): void {
	heap.push(expiry);
	let index = heap.length - 1;
	while (index > 0) {
		const parent = Math.floor((index - 1) / 2);
		if (heap[parent].expiresAt <= heap[index].expiresAt) break;
		swap(heap, parent, index);
		index = parent;
	}
}

function popExpiry(heap: Expiry[]): Expiry | undefined {
	const root = heap[0];
	const last = heap.pop();
	if (heap.length === 0 || last === undefined) return root;
	heap[0] = last;
	let index = 0;
	while (true) {
		const left = index * 2 + 1;
		const right = left + 1;
		let smallest = index;
		if (left < heap.length && heap[left].expiresAt < heap[smallest].expiresAt) smallest = left;
		if (right < heap.length && heap[right].expiresAt < heap[smallest].expiresAt) smallest = right;
		if (smallest === index) break;
		swap(heap, index, smallest);
		index = smallest;
	}
	return root;
}

export function createFixedWindowRateLimiter(
	options: { maxBuckets?: number } = {}
): FixedWindowRateLimiter {
	const maxBuckets = options.maxBuckets ?? RATE_LIMIT_MAX_BUCKETS;
	if (!Number.isSafeInteger(maxBuckets) || maxBuckets <= 0) {
		throw new Error('RATE_LIMIT_MAX_BUCKETS_INVALID');
	}
	const buckets = new Map<string, Bucket>();
	const expiries: Expiry[] = [];

	function prune(now: number): void {
		while (expiries[0]?.expiresAt <= now) {
			const expiry = popExpiry(expiries);
			if (expiry === undefined) return;
			const bucket = buckets.get(expiry.bucketKey);
			if (bucket?.expiresAt === expiry.expiresAt) buckets.delete(expiry.bucketKey);
		}
	}

	return {
		take(key, policy, now = Date.now()) {
			if (key.length === 0 || !validPolicy(policy) || !Number.isFinite(now) || now < 0)
				return false;

			prune(now);

			const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
			const bucketKey = `${policy.limit}:${policy.windowMs}:${key}`;
			const current = buckets.get(bucketKey);
			if (!current || current.expiresAt <= now) {
				if (buckets.size >= maxBuckets) return false;
				const expiresAt = windowStart + policy.windowMs;
				buckets.set(bucketKey, { count: 1, expiresAt });
				pushExpiry(expiries, { bucketKey, expiresAt });
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
