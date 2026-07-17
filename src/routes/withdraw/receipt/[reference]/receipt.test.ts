import { describe, expect, it, vi } from 'vitest';
import { createReceiptSession } from '$lib/server/withdrawals/receipt.server';
import { _createWithdrawalReceiptEndpoint } from './+server';

const reference = 'WDR-AAAAAAAAAAAAAAAAAAAAAA';
const otherReference = 'WDR-BBBBBBBBBBBBBBBBBBBBBB';
const now = new Date('2026-07-17T12:00:00.000Z');
const key = Buffer.alloc(32, 9);
const inspection = {
	id: '00000000-0000-4000-8000-000000000001',
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
	purgedAt: null,
	payload: {
		fullName: 'Åda Lovelace',
		receiptEmail: 'ada@example.test',
		enteredOrderReference: 'ORDER-2042',
		items: [{ description: 'Community Tee', quantity: 2 }],
		reconciliation: null
	}
} as const;
const seller = {
	legalName: 'Svelte Society Merch AB',
	registrationNumber: '559999-0000',
	addressLine1: 'Street 1',
	postalCode: '111 11',
	city: 'Stockholm',
	country: 'Sweden',
	email: 'merch@sveltesociety.dev'
};

function cookies(token?: string) {
	return { get: vi.fn(() => token) };
}
function event(token: string | undefined, requestedReference = reference) {
	return {
		params: { reference: requestedReference },
		cookies: cookies(token),
		url: new URL(`https://shop.sveltesociety.dev/withdraw/receipt/${requestedReference}`)
	};
}
function endpoint(inspectActive = vi.fn(() => inspection)) {
	return _createWithdrawalReceiptEndpoint({
		now: () => now,
		getRuntime: () => ({ dataKey: key, reader: { inspectActive }, seller }) as never
	});
}

describe('withdrawal receipt download', () => {
	it.each([
		['missing cookie', undefined, reference],
		['public reference alone', '', reference],
		['wrong-reference token', createReceiptSession(otherReference, now, key), reference],
		[
			'expired token',
			createReceiptSession(reference, new Date(now.getTime() - 901_000), key),
			reference
		]
	])('returns the same 404 for %s', async (_label, token, requestedReference) => {
		const response = await endpoint()(event(token, requestedReference) as never);
		expect({ status: response.status, body: await response.text() }).toEqual({
			status: 404,
			body: 'Receipt unavailable.'
		});
	});

	it('downloads a UTF-8 text attachment with only the WDR reference in its safe filename and URL', async () => {
		const response = await endpoint()(event(createReceiptSession(reference, now, key)) as never);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(response.headers.get('content-disposition')).toBe(
			`attachment; filename="${reference}-withdrawal-receipt.txt"`
		);
		expect(await response.text()).toContain('Åda Lovelace');
		expect(event(undefined).url.search).toBe('');
	});

	it('uses the centralized reader and returns the same 404 for a purged or missing case', async () => {
		const inspectActive = vi.fn(() => {
			throw new Error('WITHDRAWAL_CASE_NOT_FOUND');
		});
		const response = await endpoint(inspectActive)(
			event(createReceiptSession(reference, now, key)) as never
		);
		expect(inspectActive).toHaveBeenCalledWith(reference, now);
		expect({ status: response.status, body: await response.text() }).toEqual({
			status: 404,
			body: 'Receipt unavailable.'
		});
	});

	it('keeps tampered ciphertext a constant unavailable response through the reader without mutation', async () => {
		const inspectActive = vi.fn(() => {
			throw new Error('WITHDRAWAL_DECRYPT_FAILED');
		});
		const response = await endpoint(inspectActive)(
			event(createReceiptSession(reference, now, key)) as never
		);
		expect({ status: response.status, body: await response.text() }).toEqual({
			status: 503,
			body: 'Receipt unavailable.'
		});
		expect(inspectActive).toHaveBeenCalledOnce();
	});
});
