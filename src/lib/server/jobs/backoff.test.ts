import { describe, expect, it } from 'vitest';
import { nextOutboxAttempt } from './backoff';

describe('nextOutboxAttempt', () => {
	it.each([
		[0, '2026-07-16T08:31:00.000Z'],
		[1, '2026-07-16T08:32:00.000Z'],
		[2, '2026-07-16T08:34:00.000Z'],
		[3, '2026-07-16T08:38:00.000Z'],
		[4, '2026-07-16T08:46:00.000Z'],
		[5, '2026-07-16T09:00:00.000Z'],
		[6, '2026-07-16T09:30:00.000Z'],
		[20, '2026-07-16T09:30:00.000Z']
	])('schedules attempt %i at %s', (attempt, expected) => {
		const now = new Date('2026-07-16T08:30:00.000Z');

		expect(nextOutboxAttempt(now, attempt)).toEqual(new Date(expected));
		expect(now).toEqual(new Date('2026-07-16T08:30:00.000Z'));
	});
});
