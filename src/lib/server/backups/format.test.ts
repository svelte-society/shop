import { createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { backupChecksum, decryptBackup, encryptBackup, verifyBackupChecksum } from './format';

const key = randomBytes(32).toString('base64');

describe('SSBK1 encrypted backup format', () => {
	it('writes five magic bytes, a 12-byte IV, a 16-byte tag, then ciphertext', () => {
		const plaintext = Buffer.from('sqlite snapshot bytes');
		const encrypted = Buffer.from(encryptBackup(plaintext, key));

		expect(encrypted.subarray(0, 5).toString('ascii')).toBe('SSBK1');
		expect(encrypted).toHaveLength(5 + 12 + 16 + plaintext.length);

		const decodedKey = Buffer.from(key, 'base64');
		const decipher = createDecipheriv('aes-256-gcm', decodedKey, encrypted.subarray(5, 17));
		decipher.setAuthTag(encrypted.subarray(17, 33));
		const independentlyDecrypted = Buffer.concat([
			decipher.update(encrypted.subarray(33)),
			decipher.final()
		]);
		expect(independentlyDecrypted).toEqual(plaintext);
	});

	it('round-trips database bytes with a fresh random IV', () => {
		const plaintext = randomBytes(8_192);
		const first = encryptBackup(plaintext, key);
		const second = encryptBackup(plaintext, key);

		expect(Buffer.from(decryptBackup(first, key))).toEqual(plaintext);
		expect(Buffer.from(first)).not.toEqual(Buffer.from(second));
	});

	it('does not expose a plaintext database marker in the encrypted object', () => {
		const marker = Buffer.from('private-order-marker-private-order-marker');
		const plaintext = Buffer.concat([Buffer.from('SQLite format 3\0'), marker, randomBytes(4_096)]);

		const encrypted = Buffer.from(encryptBackup(plaintext, key));

		expect(encrypted.indexOf(marker)).toBe(-1);
		expect(encrypted.indexOf(Buffer.from('SQLite format 3\0'))).toBe(-1);
	});

	it('rejects a different 32-byte key without exposing crypto details', () => {
		const encrypted = encryptBackup(Buffer.from('database'), key);

		expect(() => decryptBackup(encrypted, randomBytes(32).toString('base64'))).toThrowError(
			/^BACKUP_DECRYPT_FAILED$/
		);
	});

	it.each([
		['IV', 5],
		['authentication tag', 17],
		['ciphertext', 33]
	])('rejects a modified %s', (_part, offset) => {
		const encrypted = Buffer.from(encryptBackup(Buffer.from('database bytes'), key));
		encrypted[offset] ^= 0xff;

		expect(() => decryptBackup(encrypted, key)).toThrowError(/^BACKUP_DECRYPT_FAILED$/);
	});

	it.each([randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), 'not-base64'])(
		'rejects an encryption key that does not decode to exactly 32 bytes',
		(invalidKey) => {
			expect(() => encryptBackup(Buffer.from('database'), invalidKey)).toThrowError(
				/^BACKUP_ENCRYPTION_KEY_INVALID$/
			);
		}
	);

	it('rejects invalid magic before attempting decryption', () => {
		const encrypted = Buffer.from(encryptBackup(Buffer.from('database'), key));
		encrypted[0] = 'X'.charCodeAt(0);

		expect(() => decryptBackup(encrypted, key)).toThrowError(/^BACKUP_FORMAT_INVALID$/);
	});

	it('rejects a truncated object before attempting decryption', () => {
		expect(() => decryptBackup(Buffer.from('SSBK1'), key)).toThrowError(/^BACKUP_FORMAT_INVALID$/);
	});

	it('calculates lower-case SHA-256 and rejects a checksum mismatch', () => {
		const encrypted = encryptBackup(Buffer.from('database'), key);
		const checksum = backupChecksum(encrypted);

		expect(checksum).toMatch(/^[a-f0-9]{64}$/);
		expect(() => verifyBackupChecksum(encrypted, `${checksum}\n`)).not.toThrow();
		expect(() => verifyBackupChecksum(encrypted, '0'.repeat(64))).toThrowError(
			/^BACKUP_CHECKSUM_MISMATCH$/
		);
	});
});
