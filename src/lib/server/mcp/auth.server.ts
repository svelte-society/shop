import { createHash, timingSafeEqual } from 'node:crypto';

export function authorizeBearer(header: string | null, expectedSecret: string): boolean {
	const match = header?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
	if (!match || expectedSecret.length === 0) return false;

	const supplied = createHash('sha256').update(match[1]).digest();
	const expected = createHash('sha256').update(expectedSecret).digest();
	return timingSafeEqual(supplied, expected);
}
