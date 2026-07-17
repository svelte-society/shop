import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';

const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:crypto')>();
	return {
		...actual,
		timingSafeEqual(left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) {
			timingSafeEqualSpy(left, right);
			return actual.timingSafeEqual(left, right);
		}
	};
});

import type { WithdrawalPayloadV1 } from '$lib/domain/withdrawals';
import type { WithdrawalCaseRecord } from './repository.server';
import {
	createReceiptSession,
	renderWithdrawalReceiptText,
	verifyReceiptSession,
	WITHDRAWAL_RECEIPT_COOKIE,
	WITHDRAWAL_RECEIPT_MAX_AGE_SECONDS,
	type WithdrawalInspection,
	type WithdrawalSellerIdentity
} from './receipt.server';

const reference = 'WDR-AAAAAAAAAAAAAAAAAAAAAA';
const now = new Date('2026-07-17T08:30:00.000Z');
const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const seller: WithdrawalSellerIdentity = {
	legalName: 'Svelte School AB',
	registrationNumber: '559000-0000',
	addressLine1: 'Sveavägen 1',
	postalCode: '111 57',
	city: 'Stockholm',
	country: 'Sweden',
	email: 'merchant@example.com'
};

function inspection(payloadOverrides: Partial<WithdrawalPayloadV1> = {}): WithdrawalInspection {
	const record: WithdrawalCaseRecord = {
		id: 'case_123',
		reference,
		status: 'submitted',
		revision: 1,
		scope: 'specific_items',
		eligibility: 'pending',
		outcomeCode: null,
		createdAt: now,
		updatedAt: now,
		reconciledAt: null,
		closedAt: null,
		piiPurgeDueAt: null,
		purgedAt: null
	};
	return {
		...record,
		payload: {
			fullName: 'Zoë Ångström',
			receiptEmail: 'zoë@example.com',
			enteredOrderReference: 'ORDER-123',
			items: [
				{ description: 'Orange hoodie', quantity: 2 },
				{ description: 'Sticker pack', quantity: 1 }
			],
			reconciliation: null,
			...payloadOverrides
		}
	};
}

describe('renderWithdrawalReceiptText', () => {
	it('renders a deterministic UTF-8 receipt from the committed inspection and seller identity', () => {
		const receipt = renderWithdrawalReceiptText(inspection(), seller);

		expect(receipt).toBe(`Withdrawal notice received — ${reference}

Receipt timestamp (UTC): 2026-07-17T08:30:00.000Z
Withdrawal reference: ${reference}

Seller
Legal name: Svelte School AB
Registration number: 559000-0000
Postal address: Sveavägen 1, 111 57 Stockholm, Sweden
Merchant email: merchant@example.com

This receipt confirms submission only. It is not an approval and does not confirm or start a refund.

Submitted notice
Name: Zoë Ångström
Receipt email: zoë@example.com
Entered order reference: ORDER-123
Scope: Specific items
Items:
- 2 × Orange hoodie
- 1 × Sticker pack
`);
		expect(Buffer.from(receipt, 'utf8').toString('utf8')).toBe(receipt);
	});

	it('keeps HTML-looking committed values as literal text without adding return-address instructions', () => {
		const receipt = renderWithdrawalReceiptText(
			inspection({
				fullName: 'Ada <strong>Lovelace</strong>',
				enteredOrderReference: '<ORDER-123>',
				items: [{ description: '<script>alert(1)</script>', quantity: 1 }]
			}),
			seller
		);

		expect(receipt).toContain('Name: Ada <strong>Lovelace</strong>');
		expect(receipt).toContain('Entered order reference: <ORDER-123>');
		expect(receipt).toContain('- 1 × <script>alert(1)</script>');
		expect(receipt).not.toContain('&lt;');
		expect(receipt).not.toMatch(/(?:send|return|ship).{0,40}(?:postal )?address/iu);
	});

	it('renders the committed entire-order scope without inventing item rows', () => {
		const wholeOrder = inspection({ items: [] });
		wholeOrder.scope = 'entire_order';

		expect(renderWithdrawalReceiptText(wholeOrder, seller)).toContain(
			'Scope: Entire order\nItems: Entire order\n'
		);
	});
});

describe('withdrawal receipt sessions', () => {
	it('uses the fixed cookie name and fifteen-minute lifetime', () => {
		expect(WITHDRAWAL_RECEIPT_COOKIE).toBe('withdrawal_receipt_session');
		expect(WITHDRAWAL_RECEIPT_MAX_AGE_SECONDS).toBe(900);
	});

	it('creates a compact version-one token valid only for the signed reference and key', () => {
		const token = createReceiptSession(reference, now, key);

		expect(token).toMatch(/^v1\.1784277900\.[A-Za-z0-9_-]{43}$/u);
		expect(verifyReceiptSession(reference, token, now, key)).toBe(true);
		expect(verifyReceiptSession('WDR-BBBBBBBBBBBBBBBBBBBBBB', token, now, key)).toBe(false);
		expect(verifyReceiptSession(reference, token, now, Buffer.alloc(32, 7))).toBe(false);
	});

	it('rejects modified signatures and invalid token encodings', () => {
		const token = createReceiptSession(reference, now, key);
		const [version, expiry, signature] = token.split('.');
		const modified = `${version}.${expiry}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;

		expect(verifyReceiptSession(reference, modified, now, key)).toBe(false);
		for (const invalid of [
			'',
			`${token}.extra`,
			`v2.${expiry}.${signature}`,
			`v1.0${expiry}.${signature}`,
			`v1.not-a-time.${signature}`,
			`v1.${expiry}.***`,
			`v1.${expiry}.${signature.slice(1)}`
		]) {
			expect(verifyReceiptSession(reference, invalid, now, key), invalid).toBe(false);
		}
	});

	it('accepts the exact fifteen-minute boundary and rejects expired or overly future tokens', () => {
		const token = createReceiptSession(reference, now, key);
		const exactBoundary = new Date(now.getTime() + WITHDRAWAL_RECEIPT_MAX_AGE_SECONDS * 1_000);

		expect(verifyReceiptSession(reference, token, exactBoundary, key)).toBe(true);
		expect(
			verifyReceiptSession(reference, token, new Date(exactBoundary.getTime() + 1_000), key)
		).toBe(false);
		const issuedOneSecondLater = createReceiptSession(
			reference,
			new Date(now.getTime() + 1_000),
			key
		);
		expect(verifyReceiptSession(reference, issuedOneSecondLater, now, key)).toBe(false);
	});

	it('uses a constant-time byte comparison for every structurally valid signature', () => {
		const token = createReceiptSession(reference, now, key);
		const [version, expiry, signature] = token.split('.');
		const modified = `${version}.${expiry}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
		timingSafeEqualSpy.mockClear();

		expect(verifyReceiptSession(reference, token, now, key)).toBe(true);
		expect(verifyReceiptSession(reference, modified, now, key)).toBe(false);
		expect(verifyReceiptSession('WDR-BBBBBBBBBBBBBBBBBBBBBB', token, now, key)).toBe(false);
		expect(timingSafeEqualSpy).toHaveBeenCalledTimes(3);
		for (const [left, right] of timingSafeEqualSpy.mock.calls) {
			expect(left).toBeInstanceOf(Buffer);
			expect(right).toBeInstanceOf(Buffer);
			expect((left as Buffer).length).toBe(32);
			expect((right as Buffer).length).toBe(32);
		}
	});
});
