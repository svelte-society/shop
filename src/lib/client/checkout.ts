import type { CartLine } from '$lib/domain/cart';

type CheckoutClientOptions = {
	fetcher?: typeof fetch;
	assign?: (url: string) => void;
};

const STRIPE_CHECKOUT_HOSTNAME = 'checkout.stripe.com';

export class CheckoutClientError extends Error {
	constructor() {
		super('CHECKOUT_UNAVAILABLE');
		this.name = 'CheckoutClientError';
	}
}

function checkoutUrl(input: unknown): string {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new CheckoutClientError();
	}

	const redirectUrl = (input as Record<string, unknown>).redirectUrl;
	if (typeof redirectUrl !== 'string' || redirectUrl.trim() !== redirectUrl) {
		throw new CheckoutClientError();
	}

	try {
		const url = new URL(redirectUrl);
		if (
			url.protocol !== 'https:' ||
			url.hostname !== STRIPE_CHECKOUT_HOSTNAME ||
			url.username !== '' ||
			url.password !== ''
		) {
			throw new CheckoutClientError();
		}
	} catch (error) {
		if (error instanceof CheckoutClientError) throw error;
		throw new CheckoutClientError();
	}

	return redirectUrl;
}

export async function beginCheckout(
	lines: readonly CartLine[],
	options: CheckoutClientOptions = {}
): Promise<void> {
	const fetcher = options.fetcher ?? globalThis.fetch;
	const assign = options.assign ?? ((url: string) => window.location.assign(url));
	let response: Response;

	try {
		response = await fetcher('/checkout', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(lines)
		});
	} catch {
		throw new CheckoutClientError();
	}

	if (!response.ok) throw new CheckoutClientError();

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new CheckoutClientError();
	}

	assign(checkoutUrl(body));
}
