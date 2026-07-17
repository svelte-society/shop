import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
	generateWithdrawalReference,
	normalizeWithdrawalInput,
	stableWithdrawalJson
} from './withdrawals';

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		fullName: 'Ada Lovelace',
		receiptEmail: 'Ada@Example.COM',
		enteredOrderReference: 'ORDER-123',
		scope: 'specific_items',
		items: [{ description: 'Svelte Society T-shirt', quantity: 2 }],
		...overrides
	};
}

describe('normalizeWithdrawalInput', () => {
	it('normalizes surrounding and repeated whitespace while preserving Unicode names', () => {
		expect(
			normalizeWithdrawalInput(
				validInput({
					fullName: '  Zoë   Ångström  ',
					enteredOrderReference: '  ORDER   123  ',
					items: [{ description: '  Society   hoodie  ', quantity: 1 }]
				})
			)
		).toEqual({
			fullName: 'Zoë Ångström',
			receiptEmail: 'Ada@example.com',
			enteredOrderReference: 'ORDER 123',
			scope: 'specific_items',
			items: [{ description: 'Society hoodie', quantity: 1 }]
		});
	});

	it('lowercases only the email domain and keeps the local part unchanged', () => {
		expect(
			normalizeWithdrawalInput(validInput({ receiptEmail: '  First.Last+Tag@EXAMPLE.COM  ' }))
				.receiptEmail
		).toBe('First.Last+Tag@example.com');
	});

	it('canonicalizes an entire-order notice to an empty item list', () => {
		expect(
			normalizeWithdrawalInput(
				validInput({
					scope: 'entire_order',
					items: [{ description: 'stale hidden row', quantity: 9 }]
				})
			)
		).toEqual({
			fullName: 'Ada Lovelace',
			receiptEmail: 'Ada@example.com',
			enteredOrderReference: 'ORDER-123',
			scope: 'entire_order',
			items: []
		});
	});

	it('accepts one through twenty specific-item rows', () => {
		for (const count of [1, 20]) {
			const items = Array.from({ length: count }, (_, index) => ({
				description: `Item ${index + 1}`,
				quantity: 99
			}));
			expect(normalizeWithdrawalInput(validInput({ items })).items).toEqual(items);
		}
	});

	it('accepts every exact text maximum measured as Unicode characters', () => {
		const fullName = 'Å'.repeat(200);
		const maximumDomain = `${'d'.repeat(63)}.${'e'.repeat(63)}.${'f'.repeat(63)}.${'g'.repeat(60)}.io`;
		const receiptEmail = `${'L'.repeat(64)}@${maximumDomain}`;
		const enteredOrderReference = 'R'.repeat(200);
		const description = '🧡'.repeat(300);
		const normalized = normalizeWithdrawalInput(
			validInput({
				fullName,
				receiptEmail,
				enteredOrderReference,
				items: [{ description, quantity: 99 }]
			})
		);

		expect(normalized.fullName).toBe(fullName);
		expect(normalized.receiptEmail).toBe(receiptEmail);
		expect(normalized.enteredOrderReference).toBe(enteredOrderReference);
		expect(normalized.items).toEqual([{ description, quantity: 99 }]);
	});

	it.each([
		['name too long', { fullName: 'A'.repeat(201) }, 'WITHDRAWAL_INPUT_INVALID'],
		[
			'email too long',
			{
				receiptEmail: `${'l'.repeat(65)}@${'d'.repeat(63)}.${'e'.repeat(63)}.${'f'.repeat(63)}.${'g'.repeat(60)}.io`
			},
			'WITHDRAWAL_INPUT_INVALID'
		],
		['reference too long', { enteredOrderReference: 'R'.repeat(201) }, 'WITHDRAWAL_INPUT_INVALID'],
		[
			'description too long',
			{ items: [{ description: 'D'.repeat(301), quantity: 1 }] },
			'WITHDRAWAL_ITEMS_INVALID'
		],
		['no selected rows', { items: [] }, 'WITHDRAWAL_ITEMS_INVALID'],
		[
			'too many selected rows',
			{
				items: Array.from({ length: 21 }, (_, index) => ({
					description: `Item ${index}`,
					quantity: 1
				}))
			},
			'WITHDRAWAL_ITEMS_INVALID'
		]
	])('rejects %s with a stable value-free error', (_label, overrides, code) => {
		let thrown: unknown;
		try {
			normalizeWithdrawalInput(validInput(overrides));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe(code);
		expect(Object.keys(thrown as object)).toEqual([]);
	});

	it.each([
		['name', { fullName: 'Ada\nLovelace' }, 'WITHDRAWAL_INPUT_INVALID'],
		['email', { receiptEmail: 'ada\u0000@example.com' }, 'WITHDRAWAL_INPUT_INVALID'],
		['order reference', { enteredOrderReference: 'ORDER\t123' }, 'WITHDRAWAL_INPUT_INVALID'],
		[
			'item description',
			{ items: [{ description: 'Society\rhoodie', quantity: 1 }] },
			'WITHDRAWAL_ITEMS_INVALID'
		]
	])('rejects control characters in the %s', (_label, overrides, code) => {
		expect(() => normalizeWithdrawalInput(validInput(overrides))).toThrowError(code);
	});

	it.each(['<strong>Hoodie</strong>', 'https://example.com/item', 'www.example.com/item'])(
		'rejects HTML or URL-like item descriptions: %s',
		(description) => {
			expect(() =>
				normalizeWithdrawalInput(validInput({ items: [{ description, quantity: 1 }] }))
			).toThrowError('WITHDRAWAL_ITEMS_INVALID');
		}
	);

	it.each([
		'plain-address',
		'@example.com',
		'ada@',
		'ada@@example.com',
		'ada lovelace@example.com',
		'.ada@example.com',
		'ada.@example.com',
		'ada@example',
		'ada@example..com'
	])('rejects a malformed email without exposing it: %s', (receiptEmail) => {
		expect(() => normalizeWithdrawalInput(validInput({ receiptEmail }))).toThrowError(
			'WITHDRAWAL_INPUT_INVALID'
		);
	});

	it.each([0, 100, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2'])(
		'rejects invalid item quantity %s',
		(quantity) => {
			expect(() =>
				normalizeWithdrawalInput(validInput({ items: [{ description: 'Hoodie', quantity }] }))
			).toThrowError('WITHDRAWAL_ITEMS_INVALID');
		}
	);

	it('returns and serializes properties in one canonical order', () => {
		const canonical = normalizeWithdrawalInput(
			validInput({
				items: [{ quantity: 2, description: 'Hoodie' }]
			})
		);

		expect(Object.keys(canonical)).toEqual([
			'fullName',
			'receiptEmail',
			'enteredOrderReference',
			'scope',
			'items'
		]);
		expect(Object.keys(canonical.items[0])).toEqual(['description', 'quantity']);
		expect(stableWithdrawalJson(canonical)).toBe(
			'{"fullName":"Ada Lovelace","receiptEmail":"Ada@example.com","enteredOrderReference":"ORDER-123","scope":"specific_items","items":[{"description":"Hoodie","quantity":2}]}'
		);
	});

	it('rejects malformed top-level input and scope with a stable value-free error', () => {
		for (const input of [null, [], 'notice', validInput({ scope: 'some_items' })]) {
			expect(() => normalizeWithdrawalInput(input)).toThrowError('WITHDRAWAL_INPUT_INVALID');
		}
	});
});

describe('generateWithdrawalReference', () => {
	it('encodes exactly sixteen random bytes as a WDR reference', () => {
		expect(generateWithdrawalReference(() => Buffer.alloc(16))).toBe('WDR-AAAAAAAAAAAAAAAAAAAAAA');
		expect(generateWithdrawalReference(() => Buffer.alloc(16, 0xff))).toBe(
			'WDR-_____________________w'
		);
	});

	it('uses fresh randomness and always emits the exact public format', () => {
		const references = new Set(Array.from({ length: 64 }, () => generateWithdrawalReference()));
		expect(references.size).toBe(64);
		for (const reference of references) {
			expect(reference).toMatch(/^WDR-[A-Za-z0-9_-]{22}$/u);
		}
	});

	it('rejects a random source that does not return exactly sixteen bytes', () => {
		expect(() => generateWithdrawalReference(() => Buffer.alloc(15))).toThrowError(
			'WITHDRAWAL_REFERENCE_INVALID'
		);
		expect(() =>
			generateWithdrawalReference((() => 'not-a-buffer') as unknown as (size: number) => Buffer)
		).toThrowError('WITHDRAWAL_REFERENCE_INVALID');
	});

	it('replaces a random-source exception with the stable reference error', () => {
		expect(() =>
			generateWithdrawalReference(() => {
				throw new Error('private random source detail');
			})
		).toThrowError(/^WITHDRAWAL_REFERENCE_INVALID$/u);
	});
});
