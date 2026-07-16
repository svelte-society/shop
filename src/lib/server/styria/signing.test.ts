import { describe, expect, it } from 'vitest';
import { signGet, signPost } from './signing';

describe('Styria request signing', () => {
	it('signs the exact UTF-8 POST body followed by the secret with lower-case SHA-1', () => {
		expect(signPost('{"hello":"värld"}', 'secret-value')).toBe(
			'0b05d949baef09b3975732b383c336a0e251ab03'
		);
	});

	it('signs the exact GET query without Signature followed by the secret', () => {
		const query =
			'AppId=APP-test&created_at_min=2026-07-17T00%3A00%3A00.000Z&format=json&limit=250&page=1';

		expect(signGet(query, 'secret-value')).toBe('69499b068b24f6091c6b9264f356cbaea77af456');
	});

	it('does not normalize or reserialize signed input', () => {
		expect(signPost('{"a":1,"b":2}', 'secret-value')).not.toBe(
			signPost('{ "a": 1, "b": 2 }', 'secret-value')
		);
		expect(signGet('AppId=APP-test&page=1', 'secret-value')).not.toBe(
			signGet('page=1&AppId=APP-test', 'secret-value')
		);
	});
});
