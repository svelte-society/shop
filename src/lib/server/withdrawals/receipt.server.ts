import { Buffer } from 'node:buffer';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { WithdrawalPayloadV1 } from '$lib/domain/withdrawals';
import type { WithdrawalSellerIdentity } from '$lib/config/private.server';
import type { WithdrawalCaseRecord } from './repository.server';

export type { WithdrawalSellerIdentity } from '$lib/config/private.server';

export type WithdrawalInspection = WithdrawalCaseRecord & {
	payload: WithdrawalPayloadV1;
};

export const WITHDRAWAL_RECEIPT_COOKIE = 'withdrawal_receipt_session';
export const WITHDRAWAL_RECEIPT_MAX_AGE_SECONDS = 900;
const RECEIPT_KEY_CONTEXT = 'svelte-society-withdrawal-receipt-v1';
const REFERENCE_PATTERN = /^WDR-[A-Za-z0-9_-]{22}$/u;
const TOKEN_PATTERN = /^v1\.(0|[1-9]\d{0,10})\.([A-Za-z0-9_-]{43})$/u;

function receiptKey(key: Buffer): Buffer {
	return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), RECEIPT_KEY_CONTEXT, 32));
}

function validKey(key: unknown): key is Buffer {
	return Buffer.isBuffer(key) && key.length === 32;
}

function validDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function validReference(value: unknown): value is string {
	return typeof value === 'string' && REFERENCE_PATTERN.test(value);
}

function sessionMac(reference: string, expiry: string, key: Buffer): Buffer {
	return createHmac('sha256', receiptKey(key)).update(`${reference}\n${expiry}`, 'utf8').digest();
}

export function renderWithdrawalReceiptText(
	inspection: WithdrawalInspection,
	seller: WithdrawalSellerIdentity
): string {
	const scope = inspection.scope === 'entire_order' ? 'Entire order' : 'Specific items';
	const items =
		inspection.scope === 'entire_order'
			? 'Items: Entire order'
			: [
					'Items:',
					...inspection.payload.items.map((item) => `- ${item.quantity} × ${item.description}`)
				].join('\n');
	return `Withdrawal notice received — ${inspection.reference}

Receipt timestamp (UTC): ${inspection.createdAt.toISOString()}
Withdrawal reference: ${inspection.reference}

Seller
Legal name: ${seller.legalName}
Registration number: ${seller.registrationNumber}
Postal address: ${seller.addressLine1}, ${seller.postalCode} ${seller.city}, ${seller.country}
Merchant email: ${seller.email}

This receipt confirms submission only. It is not an approval and does not confirm or start a refund.

Submitted notice
Name: ${inspection.payload.fullName}
Receipt email: ${inspection.payload.receiptEmail}
Entered order reference: ${inspection.payload.enteredOrderReference}
Scope: ${scope}
${items}
`;
}

export function createReceiptSession(reference: string, now: Date, key: Buffer): string {
	if (!validReference(reference) || !validDate(now) || !validKey(key)) {
		throw new Error('WITHDRAWAL_RECEIPT_SESSION_INVALID');
	}
	const expiry = String(Math.floor(now.getTime() / 1_000) + WITHDRAWAL_RECEIPT_MAX_AGE_SECONDS);
	return `v1.${expiry}.${sessionMac(reference, expiry, key).toString('base64url')}`;
}

export function verifyReceiptSession(
	reference: string,
	token: string,
	now: Date,
	key: Buffer
): boolean {
	if (
		!validReference(reference) ||
		typeof token !== 'string' ||
		!validDate(now) ||
		!validKey(key)
	) {
		return false;
	}
	const match = TOKEN_PATTERN.exec(token);
	if (!match) return false;
	const expiry = Number(match[1]);
	const nowSeconds = Math.floor(now.getTime() / 1_000);
	if (
		!Number.isSafeInteger(expiry) ||
		expiry < nowSeconds ||
		expiry > nowSeconds + WITHDRAWAL_RECEIPT_MAX_AGE_SECONDS
	) {
		return false;
	}
	const supplied = Buffer.from(match[2], 'base64url');
	if (supplied.length !== 32 || supplied.toString('base64url') !== match[2]) return false;
	const expected = sessionMac(reference, match[1], key);
	return timingSafeEqual(supplied, expected);
}
