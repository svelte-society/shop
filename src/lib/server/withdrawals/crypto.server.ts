import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import {
	stableWithdrawalJson,
	type CanonicalWithdrawalInput,
	type WithdrawalItem,
	type WithdrawalPayloadV1
} from '$lib/domain/withdrawals';

export type EncryptedWithdrawalPayload = {
	schemaVersion: 1;
	keyVersion: 1;
	ciphertext: Buffer;
	nonce: Buffer;
	tag: Buffer;
};

const CANONICAL_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const CASE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;
const DEDUPE_CONTEXT = 'svelte-society-withdrawal-dedupe-v1';

function fail(
	code: 'WITHDRAWAL_KEY_INVALID' | 'WITHDRAWAL_ENCRYPT_FAILED' | 'WITHDRAWAL_DECRYPT_FAILED'
): never {
	throw new Error(code);
}

function validKey(key: unknown): key is Buffer {
	return Buffer.isBuffer(key) && key.length === 32;
}

function validCaseId(caseId: unknown): caseId is string {
	return typeof caseId === 'string' && CASE_ID_PATTERN.test(caseId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isItem(value: unknown): value is WithdrawalItem {
	return (
		isRecord(value) &&
		typeof value.description === 'string' &&
		Number.isInteger(value.quantity) &&
		(value.quantity as number) >= 1 &&
		(value.quantity as number) <= 99
	);
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function isPayload(value: unknown): value is WithdrawalPayloadV1 {
	if (
		!isRecord(value) ||
		typeof value.fullName !== 'string' ||
		typeof value.receiptEmail !== 'string' ||
		typeof value.enteredOrderReference !== 'string' ||
		!Array.isArray(value.items) ||
		!value.items.every(isItem)
	) {
		return false;
	}
	if (value.reconciliation === null) return true;
	if (!isRecord(value.reconciliation)) return false;
	return (
		typeof value.reconciliation.internalOrderReference === 'string' &&
		typeof value.reconciliation.countryCode === 'string' &&
		isNullableString(value.reconciliation.customerInstructions) &&
		(value.reconciliation.returnOutcome === null ||
			value.reconciliation.returnOutcome === 'parcel_received' ||
			value.reconciliation.returnOutcome === 'return_waived' ||
			value.reconciliation.returnOutcome === 'return_not_received') &&
		isNullableString(value.reconciliation.parcelReference)
	);
}

function canonicalPayload(input: WithdrawalPayloadV1): WithdrawalPayloadV1 {
	return {
		fullName: input.fullName,
		receiptEmail: input.receiptEmail,
		enteredOrderReference: input.enteredOrderReference,
		items: input.items.map(({ description, quantity }) => ({ description, quantity })),
		reconciliation:
			input.reconciliation === null
				? null
				: {
						internalOrderReference: input.reconciliation.internalOrderReference,
						countryCode: input.reconciliation.countryCode,
						customerInstructions: input.reconciliation.customerInstructions,
						returnOutcome: input.reconciliation.returnOutcome,
						parcelReference: input.reconciliation.parcelReference
					}
	};
}

function additionalData(caseId: string): Buffer {
	return Buffer.from(`withdrawal-case:1:${caseId}`, 'utf8');
}

export function parseWithdrawalDataKey(value: string | undefined): Buffer {
	if (typeof value !== 'string' || !CANONICAL_KEY_PATTERN.test(value)) {
		fail('WITHDRAWAL_KEY_INVALID');
	}
	const key = Buffer.from(value, 'base64');
	if (!validKey(key) || key.toString('base64') !== value) fail('WITHDRAWAL_KEY_INVALID');
	return key;
}

export function encryptWithdrawalPayload(
	input: WithdrawalPayloadV1,
	caseId: string,
	key: Buffer
): EncryptedWithdrawalPayload {
	try {
		if (!validKey(key) || !validCaseId(caseId) || !isPayload(input)) {
			fail('WITHDRAWAL_ENCRYPT_FAILED');
		}
		const nonce = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
		cipher.setAAD(additionalData(caseId));
		const plaintext = Buffer.from(JSON.stringify(canonicalPayload(input)), 'utf8');
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return {
			schemaVersion: 1,
			keyVersion: 1,
			ciphertext,
			nonce,
			tag: cipher.getAuthTag()
		};
	} catch {
		fail('WITHDRAWAL_ENCRYPT_FAILED');
	}
}

export function decryptWithdrawalPayload(
	input: EncryptedWithdrawalPayload,
	caseId: string,
	key: Buffer
): WithdrawalPayloadV1 {
	try {
		if (
			!validKey(key) ||
			!validCaseId(caseId) ||
			!input ||
			input.schemaVersion !== 1 ||
			input.keyVersion !== 1 ||
			!Buffer.isBuffer(input.ciphertext) ||
			input.ciphertext.length === 0 ||
			!Buffer.isBuffer(input.nonce) ||
			input.nonce.length !== 12 ||
			!Buffer.isBuffer(input.tag) ||
			input.tag.length !== 16
		) {
			fail('WITHDRAWAL_DECRYPT_FAILED');
		}
		const decipher = createDecipheriv('aes-256-gcm', key, input.nonce, { authTagLength: 16 });
		decipher.setAAD(additionalData(caseId));
		decipher.setAuthTag(input.tag);
		const plaintext = Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
		const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
		if (!isPayload(parsed)) fail('WITHDRAWAL_DECRYPT_FAILED');
		return canonicalPayload(parsed);
	} catch {
		fail('WITHDRAWAL_DECRYPT_FAILED');
	}
}

export function withdrawalDedupeFingerprint(input: CanonicalWithdrawalInput, key: Buffer): string {
	if (!validKey(key)) fail('WITHDRAWAL_KEY_INVALID');
	const hmacKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), DEDUPE_CONTEXT, 32));
	return createHmac('sha256', hmacKey).update(stableWithdrawalJson(input), 'utf8').digest('hex');
}
