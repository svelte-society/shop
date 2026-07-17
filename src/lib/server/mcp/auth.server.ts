import { createHash, timingSafeEqual } from 'node:crypto';

const FAILURE_WINDOW_MS = 60 * 60_000;
const REPEATED_FAILURE_THRESHOLD = 6;

export interface McpAuthFailureMonitor {
	record(now: Date): void;
}

export function createMcpAuthFailureMonitor(options: {
	onRepeatedFailure: (now: Date) => void;
}): McpAuthFailureMonitor {
	let failures: number[] = [];
	let latest = Number.NEGATIVE_INFINITY;
	let alertedHour: string | null = null;

	return {
		record(now: Date): void {
			if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
				throw new Error('MCP_AUTH_FAILURE_TIME_INVALID');
			}
			const timestamp = now.getTime();
			if (timestamp < latest) {
				failures = [];
				alertedHour = null;
			}
			latest = timestamp;
			failures = failures.filter((failure) => failure >= timestamp - FAILURE_WINDOW_MS);
			failures.push(timestamp);
			if (failures.length > REPEATED_FAILURE_THRESHOLD) {
				failures = failures.slice(-REPEATED_FAILURE_THRESHOLD);
			}
			const hour = now.toISOString().slice(0, 13);
			if (failures.length < REPEATED_FAILURE_THRESHOLD || alertedHour === hour) return;
			alertedHour = hour;
			try {
				options.onRepeatedFailure(new Date(timestamp));
			} catch {
				// Authentication remains fail-closed if operational alert persistence is unavailable.
			}
		}
	};
}

export function authorizeBearer(header: string | null, expectedSecret: string): boolean {
	const match = header?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
	if (!match || expectedSecret.length === 0) return false;

	const supplied = createHash('sha256').update(match[1]).digest();
	const expected = createHash('sha256').update(expectedSecret).digest();
	return timingSafeEqual(supplied, expected);
}
