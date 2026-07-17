import { Buffer } from 'node:buffer';
import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	normalizeWithdrawalInput,
	stableWithdrawalJson,
	type WithdrawalPayloadV1
} from '$lib/domain/withdrawals';
import {
	decryptWithdrawalPayload,
	encryptWithdrawalPayload,
	parseWithdrawalDataKey,
	withdrawalDedupeFingerprint,
	type EncryptedWithdrawalPayload
} from './crypto.server';

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));

function payload(): WithdrawalPayloadV1 {
	return {
		fullName: 'Zoë Ångström',
		receiptEmail: 'Zoë@example.com',
		enteredOrderReference: 'ORDER-123',
		items: [{ description: 'Svelte Society hoodie', quantity: 2 }],
		reconciliation: null
	};
}

function flipFirstByte(value: Buffer): Buffer {
	const changed = Buffer.from(value);
	changed[0] ^= 0xff;
	return changed;
}

describe('parseWithdrawalDataKey', () => {
	it('decodes exactly one canonical base64 representation of 32 bytes', () => {
		const encoded = key.toString('base64');
		expect(encoded).toHaveLength(44);
		expect(parseWithdrawalDataKey(encoded)).toEqual(key);
	});

	it.each([
		undefined,
		'',
		Buffer.alloc(31).toString('base64'),
		Buffer.alloc(33).toString('base64'),
		key.toString('base64url'),
		`${key.toString('base64')}\n`,
		'!'.repeat(44)
	])('rejects a missing, malformed, non-canonical, or wrong-length key', (encoded) => {
		let thrown: unknown;
		try {
			parseWithdrawalDataKey(encoded);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe('WITHDRAWAL_KEY_INVALID');
		expect(Object.keys(thrown as object)).toEqual([]);
	});
});

describe('withdrawal payload encryption', () => {
	it('round-trips a version-one payload with a unique 12-byte nonce and 16-byte tag', () => {
		const encrypted = Array.from({ length: 32 }, () =>
			encryptWithdrawalPayload(payload(), 'case_123', key)
		);
		expect(new Set(encrypted.map(({ nonce }) => nonce.toString('hex'))).size).toBe(32);
		for (const record of encrypted) {
			expect(record).toEqual({
				schemaVersion: 1,
				keyVersion: 1,
				ciphertext: expect.any(Buffer),
				nonce: expect.any(Buffer),
				tag: expect.any(Buffer)
			});
			expect(record.nonce).toHaveLength(12);
			expect(record.tag).toHaveLength(16);
			expect(decryptWithdrawalPayload(record, 'case_123', key)).toEqual(payload());
		}
	});

	it('binds authentication to the case ID, schema version, and key version', () => {
		const encrypted = encryptWithdrawalPayload(payload(), 'case_123', key);
		expect(() => decryptWithdrawalPayload(encrypted, 'case_124', key)).toThrowError(
			'WITHDRAWAL_DECRYPT_FAILED'
		);
		expect(() =>
			decryptWithdrawalPayload(
				{ ...encrypted, schemaVersion: 2 } as unknown as EncryptedWithdrawalPayload,
				'case_123',
				key
			)
		).toThrowError('WITHDRAWAL_DECRYPT_FAILED');
		expect(() =>
			decryptWithdrawalPayload(
				{ ...encrypted, keyVersion: 2 } as unknown as EncryptedWithdrawalPayload,
				'case_123',
				key
			)
		).toThrowError('WITHDRAWAL_DECRYPT_FAILED');
	});

	it.each(['ciphertext', 'nonce', 'tag'] as const)('rejects a tampered %s', (field) => {
		const encrypted = encryptWithdrawalPayload(payload(), 'case_123', key);
		const tampered = { ...encrypted, [field]: flipFirstByte(encrypted[field]) };
		expect(() => decryptWithdrawalPayload(tampered, 'case_123', key)).toThrowError(
			'WITHDRAWAL_DECRYPT_FAILED'
		);
	});

	it('returns constant-shape errors without submitted values', () => {
		const privateValue = 'private-customer@example.com';
		const privatePayload = { ...payload(), receiptEmail: privateValue };
		for (const operation of [
			() => encryptWithdrawalPayload(privatePayload, '', key),
			() =>
				decryptWithdrawalPayload(
					{
						schemaVersion: 1,
						keyVersion: 1,
						ciphertext: Buffer.from(privateValue),
						nonce: Buffer.alloc(12),
						tag: Buffer.alloc(16)
					},
					'case_123',
					key
				)
		]) {
			let thrown: unknown;
			try {
				operation();
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect(['WITHDRAWAL_ENCRYPT_FAILED', 'WITHDRAWAL_DECRYPT_FAILED']).toContain(
				(thrown as Error).message
			);
			expect((thrown as Error).message).not.toContain(privateValue);
			expect(Object.keys(thrown as object)).toEqual([]);
		}
	});
});

describe('withdrawalDedupeFingerprint', () => {
	it('is a deterministic 64-character lowercase-hex HMAC of stable canonical JSON', () => {
		const canonical = normalizeWithdrawalInput({
			fullName: 'Ada Lovelace',
			receiptEmail: 'Ada@Example.COM',
			enteredOrderReference: 'ORDER-123',
			scope: 'entire_order',
			items: []
		});
		const derived = Buffer.from(
			hkdfSync('sha256', key, Buffer.alloc(0), 'svelte-society-withdrawal-dedupe-v1', 32)
		);
		const expected = createHmac('sha256', derived)
			.update(stableWithdrawalJson(canonical), 'utf8')
			.digest('hex');

		expect(withdrawalDedupeFingerprint(canonical, key)).toBe(expected);
		expect(withdrawalDedupeFingerprint(canonical, key)).toMatch(/^[0-9a-f]{64}$/u);
	});

	it('uses the dedicated dedupe HKDF context rather than another workflow context', () => {
		const canonical = normalizeWithdrawalInput({
			fullName: 'Ada Lovelace',
			receiptEmail: 'ada@example.com',
			enteredOrderReference: 'ORDER-123',
			scope: 'entire_order',
			items: []
		});
		const receiptKey = Buffer.from(
			hkdfSync('sha256', key, Buffer.alloc(0), 'svelte-society-withdrawal-receipt-v1', 32)
		);
		const receiptContextFingerprint = createHmac('sha256', receiptKey)
			.update(stableWithdrawalJson(canonical), 'utf8')
			.digest('hex');

		expect(withdrawalDedupeFingerprint(canonical, key)).not.toBe(receiptContextFingerprint);
	});
});
