import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';

const MAGIC = Buffer.from('SSBK1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;
const BASE64_32_BYTE_KEY = /^[A-Za-z0-9+/]{43}=$/;

function decodeKey(value: string): Buffer {
	if (!backupEncryptionKeyIsValid(value)) throw new Error('BACKUP_ENCRYPTION_KEY_INVALID');
	const decoded = Buffer.from(value, 'base64');
	return decoded;
}

export function backupEncryptionKeyIsValid(value: string | undefined): value is string {
	if (typeof value !== 'string' || !BASE64_32_BYTE_KEY.test(value)) return false;
	const decoded = Buffer.from(value, 'base64');
	return decoded.length === 32 && decoded.toString('base64') === value;
}

export function encryptBackup(plaintext: Uint8Array, keyBase64: string): Uint8Array {
	const key = decodeKey(keyBase64);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBackup(object: Uint8Array, keyBase64: string): Uint8Array {
	const key = decodeKey(keyBase64);
	const bytes = Buffer.from(object);
	if (bytes.length < HEADER_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
		throw new Error('BACKUP_FORMAT_INVALID');
	}

	try {
		const ivStart = MAGIC.length;
		const tagStart = ivStart + IV_BYTES;
		const ciphertextStart = tagStart + TAG_BYTES;
		const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(ivStart, tagStart));
		decipher.setAuthTag(bytes.subarray(tagStart, ciphertextStart));
		return Buffer.concat([decipher.update(bytes.subarray(ciphertextStart)), decipher.final()]);
	} catch {
		throw new Error('BACKUP_DECRYPT_FAILED');
	}
}

export function backupChecksum(object: Uint8Array): string {
	return createHash('sha256').update(object).digest('hex');
}

export function verifyBackupChecksum(object: Uint8Array, expected: string): void {
	const normalized = expected.trim();
	const actual = backupChecksum(object);
	if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('BACKUP_CHECKSUM_MISMATCH');
	if (!timingSafeEqual(Buffer.from(actual, 'ascii'), Buffer.from(normalized, 'ascii'))) {
		throw new Error('BACKUP_CHECKSUM_MISMATCH');
	}
}
