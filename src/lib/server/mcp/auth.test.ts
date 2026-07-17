import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeBearer, createMcpAuthFailureMonitor } from './auth.server';

const EXPECTED_TOKEN = 'expected.secret_123-~';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('authorizeBearer', () => {
	it.each([
		['missing header', null],
		['wrong scheme', `Basic ${EXPECTED_TOKEN}`],
		['empty token', 'Bearer '],
		['lowercase scheme', `bearer ${EXPECTED_TOKEN}`],
		['leading whitespace', ` Bearer ${EXPECTED_TOKEN}`],
		['two separating spaces', `Bearer  ${EXPECTED_TOKEN}`],
		['tab separator', `Bearer\t${EXPECTED_TOKEN}`],
		['trailing whitespace', `Bearer ${EXPECTED_TOKEN} `],
		['whitespace inside token', 'Bearer expected secret'],
		['disallowed token character', 'Bearer expected/secret']
	])('rejects %s', (_label, header) => {
		expect(authorizeBearer(header, EXPECTED_TOKEN)).toBe(false);
	});

	it.each([
		['short wrong token', 'wrong'],
		['same-length wrong token', 'expected.secret_123-x'],
		['long wrong token', 'expected.secret_123-~extra']
	])('rejects a %s', (_label, supplied) => {
		expect(authorizeBearer(`Bearer ${supplied}`, EXPECTED_TOKEN)).toBe(false);
	});

	it('accepts the exact token', () => {
		expect(authorizeBearer(`Bearer ${EXPECTED_TOKEN}`, EXPECTED_TOKEN)).toBe(true);
	});

	it('fails closed when the server secret is absent', () => {
		expect(authorizeBearer('Bearer any-token', '')).toBe(false);
	});

	it('does not expose supplied or expected tokens in results or console output', () => {
		const supplied = 'supplied.private-token';
		const expected = 'expected.private-token';
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const result = authorizeBearer(`Bearer ${supplied}`, expected);
		const observable = JSON.stringify({
			result,
			output: [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
		});

		expect(result).toBe(false);
		expect(observable).not.toContain(supplied);
		expect(observable).not.toContain(expected);
		expect(log).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});
});

describe('MCP authentication failure monitoring', () => {
	it('alerts only after six non-sensitive failures in a bounded rolling hour', () => {
		const onRepeatedFailure = vi.fn();
		const monitor = createMcpAuthFailureMonitor({ onRepeatedFailure });

		for (let index = 0; index < 5; index += 1) {
			monitor.record(new Date(`2026-07-17T08:0${index}:00.000Z`));
		}
		expect(onRepeatedFailure).not.toHaveBeenCalled();
		monitor.record(new Date('2026-07-17T08:05:00.000Z'));
		expect(onRepeatedFailure).toHaveBeenCalledOnce();
		expect(onRepeatedFailure).toHaveBeenCalledWith(new Date('2026-07-17T08:05:00.000Z'));

		monitor.record(new Date('2026-07-17T08:06:00.000Z'));
		expect(onRepeatedFailure).toHaveBeenCalledOnce();
	});

	it('clears recovered failures and permits a new alert in a later UTC hour', () => {
		const onRepeatedFailure = vi.fn();
		const monitor = createMcpAuthFailureMonitor({ onRepeatedFailure });
		for (let index = 0; index < 6; index += 1) {
			monitor.record(new Date(`2026-07-17T08:0${index}:00.000Z`));
		}
		monitor.record(new Date('2026-07-17T10:00:00.000Z'));
		expect(onRepeatedFailure).toHaveBeenCalledTimes(1);
		for (let index = 1; index < 6; index += 1) {
			monitor.record(new Date(`2026-07-17T10:0${index}:00.000Z`));
		}
		expect(onRepeatedFailure).toHaveBeenCalledTimes(2);
	});

	it('accepts only time and never retains request, token, address, agent, or tool data', () => {
		const onRepeatedFailure = vi.fn();
		const monitor = createMcpAuthFailureMonitor({ onRepeatedFailure });
		expect(Object.keys(monitor)).toEqual(['record']);
		expect(() => monitor.record(new Date(Number.NaN))).toThrowError(
			'MCP_AUTH_FAILURE_TIME_INVALID'
		);
		expect(JSON.stringify(monitor)).not.toContain('Authorization');
	});
});
