import { describe, expect, it, vi } from 'vitest';
import { isActionFailure } from '@sveltejs/kit';
import { _createWithdrawalPage, _issueOrReuseWithdrawalCsrf } from './+page.server';

class TestCookies {
	values = new Map<string, string>();
	sets: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
	get(name: string) {
		return this.values.get(name);
	}
	set(name: string, value: string, options: Record<string, unknown>) {
		this.values.set(name, value);
		this.sets.push({ name, value, options });
	}
}

const now = new Date('2026-07-17T12:00:00.000Z');
const result = {
	reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
	createdAt: now,
	scope: 'entire_order' as const,
	enteredOrderReference: 'ORDER-2042',
	deliveryState: 'delivered' as const
};

function form(overrides: Record<string, string | string[]> = {}) {
	const values: Record<string, string | string[]> = {
		fullName: 'Ada Lovelace',
		receiptEmail: 'ada@example.test',
		enteredOrderReference: 'ORDER-2042',
		scope: 'entire_order',
		itemDescription: ['Community Tee'],
		itemQuantity: ['1'],
		...overrides
	};
	const data = new FormData();
	for (const [name, value] of Object.entries(values)) {
		for (const entry of Array.isArray(value) ? value : [value]) data.append(name, entry);
	}
	return data;
}

function setup(
	options: {
		deliveryState?: 'delivered' | 'queued' | 'failed';
		submitError?: Error;
		production?: boolean;
	} = {}
) {
	const cookies = new TestCookies();
	const csrfToken = _issueOrReuseWithdrawalCsrf(cookies as never, false);
	const submit = options.submitError
		? vi.fn(async () => {
				throw options.submitError;
			})
		: vi.fn(async (input) => ({
				...result,
				scope: input.scope,
				deliveryState: options.deliveryState ?? 'delivered'
			}));
	const page = _createWithdrawalPage({
		production: options.production ?? true,
		environment: {
			PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
			HOST_ALLOWLIST: 'shop.sveltesociety.dev'
		},
		now: () => now,
		getRuntime: () => ({ submission: { submit }, dataKey: Buffer.alloc(32, 7) }) as never
	});
	return { cookies, csrfToken, submit, page };
}

function event(
	data: FormData,
	cookies: TestCookies,
	csrfToken: string | null,
	options: {
		host?: string;
		origin?: string;
		address?: string;
		contentLength?: string;
		eventProtocol?: 'http:' | 'https:';
	} = {}
) {
	if (csrfToken !== null) data.set('csrfToken', csrfToken);
	const host = options.host ?? 'shop.sveltesociety.dev';
	const headers = new Headers({ host, origin: options.origin ?? 'https://shop.sveltesociety.dev' });
	const request = new Request(`https://${host}/withdraw?/confirm`, {
		method: 'POST',
		headers,
		body: data
	});
	if (options.contentLength) request.headers.set('content-length', options.contentLength);
	return {
		request,
		cookies,
		url: new URL(`${options.eventProtocol ?? 'https:'}//${host}/withdraw?/confirm`),
		getClientAddress: () => options.address ?? '192.0.2.10'
	} as never;
}

describe('withdrawal page server', () => {
	it('loads one row and issues or reuses a 32-byte scoped CSRF cookie', async () => {
		const { page } = setup();
		const cookies = new TestCookies();
		const loaded = (await page.load({
			cookies,
			url: new URL('https://shop.sveltesociety.dev/withdraw')
		} as never)) as { itemRowCount: number; csrfToken: string };
		expect(loaded.itemRowCount).toBe(1);
		expect(loaded.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(cookies.sets[0]).toMatchObject({
			name: 'withdrawal_csrf',
			options: {
				httpOnly: true,
				sameSite: 'strict',
				secure: true,
				path: '/withdraw',
				maxAge: 1800
			}
		});
		const reused = _issueOrReuseWithdrawalCsrf(cookies as never, true);
		expect(reused).toBe(loaded.csrfToken);
		expect(cookies.sets).toHaveLength(1);
	});

	it.each([
		['missing', null],
		['mismatched', 'wrong-token']
	])('rejects a %s CSRF token without submission', async (_label, token) => {
		const { cookies, page, submit } = setup();
		const response = await page.actions.confirm(event(form(), cookies, token));
		expect(isActionFailure(response) && response.status).toBe(403);
		expect(submit).not.toHaveBeenCalled();
	});

	it.each([
		['wrong host', { host: 'attacker.example' }],
		['wrong origin', { origin: 'https://attacker.example' }]
	])('rejects %s before submission', async (_label, requestOptions) => {
		const { cookies, csrfToken, page, submit } = setup();
		const response = await page.actions.confirm(event(form(), cookies, csrfToken, requestOptions));
		expect(isActionFailure(response)).toBe(true);
		expect(submit).not.toHaveBeenCalled();
	});

	it('rejects declared bodies over 64 KiB and more than 20 item rows', async () => {
		const first = setup();
		const oversized = await first.page.actions.review(
			event(form(), first.cookies, first.csrfToken, { contentLength: '65537' })
		);
		expect(isActionFailure(oversized) && oversized.status).toBe(413);
		const second = setup();
		const rows = Array.from({ length: 21 }, (_, index) => `Item ${index}`);
		const tooMany = await second.page.actions.review(
			event(
				form({ scope: 'specific_items', itemDescription: rows, itemQuantity: rows.map(() => '1') }),
				second.cookies,
				second.csrfToken
			)
		);
		expect(isActionFailure(tooMany) && tooMany.status).toBe(400);
	});

	it('rejects oversized raw item arrays before scope branching and clamps failure row counts', async () => {
		const { cookies, csrfToken, page, submit } = setup();
		const rows = Array.from({ length: 21 }, (_, index) => `Item ${index}`);
		const quantities = rows.map(() => '1');
		const review = await page.actions.review(
			event(
				form({ scope: 'entire_order', itemDescription: rows, itemQuantity: quantities }),
				cookies,
				csrfToken
			)
		);
		expect(isActionFailure(review) && review.data).toMatchObject({
			errors: { items: expect.any(String) },
			itemRowCount: 20
		});
		const confirm = await page.actions.confirm(
			event(
				form({ scope: 'tampered', itemDescription: rows, itemQuantity: quantities }),
				cookies,
				csrfToken
			)
		);
		expect(isActionFailure(confirm) && confirm.data).toMatchObject({
			errors: { items: expect.any(String), scope: expect.any(String) },
			itemRowCount: 20
		});
		expect(submit).not.toHaveBeenCalled();
	});

	it.each([
		['mismatched cardinality', ['Tee', 'Cap'], ['1']],
		['oversized quantity array', ['Tee'], Array.from({ length: 21 }, () => '1')]
	])('rejects %s for a whole-order notice', async (_label, descriptions, quantities) => {
		const { cookies, csrfToken, page, submit } = setup();
		const response = await page.actions.review(
			event(
				form({
					scope: 'entire_order',
					itemDescription: descriptions,
					itemQuantity: quantities
				}),
				cookies,
				csrfToken
			)
		);
		if (!isActionFailure(response) || !response.data) throw new Error('EXPECTED_ACTION_FAILURE');
		const failureData = response.data as unknown as {
			errors: Record<string, string>;
			itemRowCount: number;
		};
		expect(failureData).toMatchObject({
			errors: { items: expect.any(String) }
		});
		expect(failureData.itemRowCount).toBeLessThanOrEqual(20);
		expect(submit).not.toHaveBeenCalled();
	});

	it('rejects an oversized add request without returning more than twenty rows', async () => {
		const { cookies, csrfToken, page, submit } = setup();
		const rows = Array.from({ length: 21 }, (_, index) => `Item ${index}`);
		const response = await page.actions.addItem(
			event(
				form({ scope: 'specific_items', itemDescription: rows, itemQuantity: rows.map(() => '1') }),
				cookies,
				csrfToken
			)
		);
		expect(isActionFailure(response) && response.data).toMatchObject({
			errors: { items: expect.any(String) },
			itemRowCount: 20
		});
		expect(submit).not.toHaveBeenCalled();
	});

	it('returns adjacent validation errors and no case from review or confirm', async () => {
		const { cookies, csrfToken, page, submit } = setup();
		for (const action of [page.actions.review, page.actions.confirm]) {
			const response = await action(
				event(form({ fullName: '', receiptEmail: 'secret-invalid' }), cookies, csrfToken)
			);
			expect(isActionFailure(response) && response.data).toMatchObject({
				errors: { fullName: expect.any(String), receiptEmail: expect.any(String) },
				fields: { fullName: '', receiptEmail: 'secret-invalid' }
			});
		}
		expect(submit).not.toHaveBeenCalled();
	});

	it('preserves values while adding and removing rows without persisting', async () => {
		const { cookies, csrfToken, page, submit } = setup();
		const added = await page.actions.addItem(
			event(
				form({
					scope: 'specific_items',
					itemDescription: ['Tee', 'Cap'],
					itemQuantity: ['2', '1']
				}),
				cookies,
				csrfToken
			)
		);
		expect(added).toMatchObject({
			itemRowCount: 3,
			fields: { itemDescriptions: ['Tee', 'Cap', ''], itemQuantities: ['2', '1', '1'] }
		});
		const removed = await page.actions.removeItem(
			event(
				form({
					scope: 'specific_items',
					itemDescription: ['Tee', 'Cap'],
					itemQuantity: ['2', '1'],
					removeIndex: '0'
				}),
				cookies,
				csrfToken
			)
		);
		expect(removed).toMatchObject({
			itemRowCount: 1,
			fields: { itemDescriptions: ['Cap'], itemQuantities: ['1'] }
		});
		expect(submit).not.toHaveBeenCalled();
	});

	it('returns a canonical non-persisted review model with every value', async () => {
		const { cookies, csrfToken, page, submit } = setup();
		const response = await page.actions.review(
			event(
				form({
					scope: 'specific_items',
					itemDescription: ['  Community Tee  '],
					itemQuantity: ['2']
				}),
				cookies,
				csrfToken
			)
		);
		expect(response).toMatchObject({
			review: {
				fullName: 'Ada Lovelace',
				receiptEmail: 'ada@example.test',
				enteredOrderReference: 'ORDER-2042',
				scope: 'specific_items',
				items: [{ description: 'Community Tee', quantity: 2 }]
			}
		});
		expect(submit).not.toHaveBeenCalled();
	});

	it.each(['delivered', 'queued', 'failed'] as const)(
		'commits a valid notice with %s delivery as success and sets a scoped receipt cookie',
		async (deliveryState) => {
			const { cookies, csrfToken, page, submit } = setup({ deliveryState });
			const response = await page.actions.confirm(event(form(), cookies, csrfToken));
			expect(response).toMatchObject({
				success: true,
				result: { deliveryState, reference: result.reference }
			});
			expect(submit).toHaveBeenCalledOnce();
			expect(cookies.sets.at(-1)).toMatchObject({
				name: 'withdrawal_receipt_session',
				options: {
					httpOnly: true,
					sameSite: 'strict',
					secure: true,
					path: `/withdraw/receipt/${result.reference}`,
					maxAge: 900
				}
			});
		}
	);

	it('keeps the receipt cookie Secure in production behind an HTTP-shaped internal URL', async () => {
		const { cookies, csrfToken, page } = setup({ production: true });
		const response = await page.actions.confirm(
			event(form(), cookies, csrfToken, { eventProtocol: 'http:' })
		);
		expect(response).toMatchObject({ success: true });
		expect(cookies.sets.at(-1)?.options.secure).toBe(true);
	});

	it('maps database or encryption failures to a generic 503 without reflecting submitted data', async () => {
		const { cookies, csrfToken, page } = setup({
			submitError: new Error('WITHDRAWAL_SUBMISSION_FAILED')
		});
		const response = await page.actions.confirm(
			event(form({ fullName: 'Sensitive Person' }), cookies, csrfToken)
		);
		expect(isActionFailure(response) && response.status).toBe(503);
		expect(JSON.stringify(response)).not.toContain('Sensitive Person');
	});

	it('limits only the sixth final confirmation per client in fifteen minutes', async () => {
		const { cookies, csrfToken, page, submit } = setup();
		for (let index = 0; index < 5; index += 1) {
			expect(await page.actions.confirm(event(form(), cookies, csrfToken))).toMatchObject({
				success: true
			});
		}
		const limited = await page.actions.confirm(event(form(), cookies, csrfToken));
		expect(isActionFailure(limited) && limited.status).toBe(429);
		expect(submit).toHaveBeenCalledTimes(5);
		const reviewed = await page.actions.review(event(form(), cookies, csrfToken));
		expect(reviewed).toHaveProperty('review');
	});
});
