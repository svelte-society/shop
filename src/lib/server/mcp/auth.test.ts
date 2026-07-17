import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeBearer } from './auth.server';

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
