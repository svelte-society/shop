import { describe, expect, it } from 'vitest';
import { beginCheckout, CheckoutClientError } from './checkout';

const lines = [{ priceId: 'price_tee_m', quantity: 2 }];

describe('beginCheckout', () => {
	it('posts only cart Price IDs and quantities, then assigns the validated HTTPS redirect', async () => {
		const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const redirects: string[] = [];
		const originalLines = structuredClone(lines);

		await beginCheckout(lines, {
			async fetcher(input, init) {
				requests.push({ input, init });
				return new Response(
					JSON.stringify({ redirectUrl: 'https://checkout.stripe.com/c/pay/cs_test_client' }),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			},
			assign: (url) => redirects.push(url)
		});

		expect(requests).toEqual([
			{
				input: '/checkout',
				init: {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(lines)
				}
			}
		]);
		expect(redirects).toEqual(['https://checkout.stripe.com/c/pay/cs_test_client']);
		expect(lines).toEqual(originalLines);
	});

	it.each([
		['provider failure', new Response('sk_test_secret', { status: 503 })],
		['invalid success JSON', new Response('{', { status: 200 })],
		['missing redirect', new Response(JSON.stringify({ ok: true }), { status: 200 })],
		[
			'unsafe redirect',
			new Response(JSON.stringify({ redirectUrl: 'javascript:alert(1)' }), { status: 200 })
		]
	])('returns one stable client error for %s without navigating', async (_label, response) => {
		const redirects: string[] = [];

		const promise = beginCheckout(lines, {
			fetcher: async () => response,
			assign: (url) => redirects.push(url)
		});

		await expect(promise).rejects.toEqual(new CheckoutClientError());
		expect(redirects).toEqual([]);
	});
});
