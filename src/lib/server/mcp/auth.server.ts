import { createHash, timingSafeEqual } from 'node:crypto';

const FAILURE_WINDOW_MS = 60 * 60_000;
const REPEATED_FAILURE_THRESHOLD = 6;

export interface McpAuthFailureMonitor {
	record(now: Date): Promise<void>;
	reset(): void;
}

export function createMcpAuthFailureMonitor(options: {
	onRepeatedFailure: (now: Date) => void | Promise<void>;
}): McpAuthFailureMonitor {
	let failures: number[] = [];
	let latest = Number.NEGATIVE_INFINITY;
	let alertedHour: string | null = null;
	let pendingHour: string | null = null;
	let pendingAlert: Promise<void> | null = null;

	return {
		async record(now: Date): Promise<void> {
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
			if (pendingHour === hour && pendingAlert) {
				try {
					await pendingAlert;
				} catch {
					// The request that created the operation owns retry-state cleanup.
				}
				return;
			}
			const operation = Promise.resolve().then(() =>
				options.onRepeatedFailure(new Date(timestamp))
			);
			pendingHour = hour;
			pendingAlert = operation;
			try {
				await operation;
				alertedHour = hour;
			} catch {
				// Authentication remains fail-closed if operational alert persistence is unavailable.
			} finally {
				if (pendingAlert === operation) {
					pendingHour = null;
					pendingAlert = null;
				}
			}
		},
		reset(): void {
			failures = [];
			latest = Number.NEGATIVE_INFINITY;
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
