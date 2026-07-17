import { beforeEach, describe, expect, it, vi } from 'vitest';

const track = vi.hoisted(() => vi.fn());

vi.mock('$lib/analytics/events', () => ({ track }));

import { createCart } from './cart.svelte';

const CART_STORAGE_KEY = 'svelte-society-shop:cart:v1';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
	readonly #values = new Map<string, string>();

	constructor(initial: Record<string, string> = {}) {
		for (const [key, value] of Object.entries(initial)) this.#values.set(key, value);
	}

	getItem(key: string): string | null {
		return this.#values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.#values.set(key, value);
	}

	removeItem(key: string): void {
		this.#values.delete(key);
	}
}

class ReadFaultStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
	readonly #values = new Map<string, string>();

	constructor(initial: Record<string, string>) {
		for (const [key, value] of Object.entries(initial)) this.#values.set(key, value);
	}

	getItem(): string | null {
		throw new Error('STORAGE_READ_FAILED');
	}

	setItem(key: string, value: string): void {
		this.#values.set(key, value);
	}

	removeItem(key: string): void {
		this.#values.delete(key);
	}

	peek(key: string): string | null {
		return this.#values.get(key) ?? null;
	}
}

describe('createCart', () => {
	beforeEach(() => {
		track.mockReset();
	});

	it('hydrates schema version 1 and normalizes duplicate Price IDs', () => {
		const storage = new MemoryStorage({
			[CART_STORAGE_KEY]: JSON.stringify({
				version: 1,
				lines: [
					{ priceId: 'price_tee_m', quantity: 1 },
					{ priceId: 'price_hat', quantity: 1 },
					{ priceId: 'price_tee_m', quantity: 2 }
				]
			})
		});

		const cart = createCart(storage);

		expect(cart.lines).toEqual([
			{ priceId: 'price_tee_m', quantity: 3 },
			{ priceId: 'price_hat', quantity: 1 }
		]);
		expect(cart.totalUnits).toBe(4);
		expect(JSON.parse(storage.getItem(CART_STORAGE_KEY) ?? '')).toEqual({
			version: 1,
			lines: [
				{ priceId: 'price_tee_m', quantity: 3 },
				{ priceId: 'price_hat', quantity: 1 }
			]
		});
	});

	it.each([
		['malformed JSON', '{'],
		['an unsupported version', JSON.stringify({ version: 2, lines: [] })],
		[
			'invalid cart lines',
			JSON.stringify({ version: 1, lines: [{ priceId: 'price_tee_m', quantity: 21 }] })
		]
	])('recovers from %s by clearing persisted data', (_label, persisted) => {
		const storage = new MemoryStorage({ [CART_STORAGE_KEY]: persisted });

		const cart = createCart(storage);

		expect(cart.lines).toEqual([]);
		expect(cart.totalUnits).toBe(0);
		expect(storage.getItem(CART_STORAGE_KEY)).toBeNull();
	});

	it('preserves persisted data when storage cannot be read', () => {
		const persisted = JSON.stringify({
			version: 1,
			lines: [{ priceId: 'price_tee_m', quantity: 2 }]
		});
		const storage = new ReadFaultStorage({ [CART_STORAGE_KEY]: persisted });

		const cart = createCart(storage);

		expect(cart.lines).toEqual([]);
		expect(cart.totalUnits).toBe(0);
		expect(storage.peek(CART_STORAGE_KEY)).toBe(persisted);
	});

	it('merges repeated additions and persists only versioned cart lines', () => {
		const storage = new MemoryStorage();
		const cart = createCart(storage);

		cart.add('price_tee_m');
		cart.add('price_tee_m', 2);

		expect(cart.lines).toEqual([{ priceId: 'price_tee_m', quantity: 3 }]);
		expect(JSON.parse(storage.getItem(CART_STORAGE_KEY) ?? '')).toEqual({
			version: 1,
			lines: [{ priceId: 'price_tee_m', quantity: 3 }]
		});
		expect(track.mock.calls).toEqual([['added_to_cart'], ['added_to_cart']]);
	});

	it('does not report a failed addition', () => {
		const cart = createCart(new MemoryStorage());
		cart.add('price_tee_m', 20);
		track.mockReset();

		expect(() => cart.add('price_hat')).toThrowError('CART_TOO_MANY_UNITS');
		expect(track).not.toHaveBeenCalled();
	});

	it('changes quantities and removes lines', () => {
		const storage = new MemoryStorage();
		const cart = createCart(storage);
		cart.add('price_tee_m');
		cart.add('price_hat', 2);

		cart.setQuantity('price_tee_m', 4);
		cart.remove('price_hat');

		expect(cart.lines).toEqual([{ priceId: 'price_tee_m', quantity: 4 }]);
		expect(cart.totalUnits).toBe(4);
		expect(JSON.parse(storage.getItem(CART_STORAGE_KEY) ?? '')).toEqual({
			version: 1,
			lines: [{ priceId: 'price_tee_m', quantity: 4 }]
		});
	});

	it('removes persisted data when the cart becomes empty', () => {
		const storage = new MemoryStorage();
		const cart = createCart(storage);
		cart.add('price_tee_m');

		cart.clear();

		expect(cart.lines).toEqual([]);
		expect(storage.getItem(CART_STORAGE_KEY)).toBeNull();
	});

	it('enforces the 20-unit limit without changing current or persisted state', () => {
		const storage = new MemoryStorage();
		const cart = createCart(storage);
		cart.add('price_tee_m', 20);

		expect(() => cart.add('price_hat')).toThrowError('CART_TOO_MANY_UNITS');
		expect(() => cart.setQuantity('price_tee_m', 21)).toThrowError('CART_TOO_MANY_UNITS');
		expect(cart.lines).toEqual([{ priceId: 'price_tee_m', quantity: 20 }]);
		expect(JSON.parse(storage.getItem(CART_STORAGE_KEY) ?? '')).toEqual({
			version: 1,
			lines: [{ priceId: 'price_tee_m', quantity: 20 }]
		});
	});

	it('enforces the 10-distinct-Price limit after merging', () => {
		const cart = createCart(new MemoryStorage());

		for (let index = 0; index < 10; index += 1) cart.add(`price_${index}`);

		expect(() => cart.add('price_10')).toThrowError('CART_TOO_MANY_DISTINCT_PRICES');
		expect(cart.lines).toHaveLength(10);
	});

	it('does not use browser storage when created during SSR', () => {
		const cart = createCart();

		cart.add('price_tee_m');

		expect(cart.lines).toEqual([{ priceId: 'price_tee_m', quantity: 1 }]);
	});

	it('does not access browser globals during module import', async () => {
		vi.resetModules();
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
		Object.defineProperty(globalThis, 'window', {
			configurable: true,
			get() {
				throw new Error('WINDOW_ACCESSED_DURING_IMPORT');
			}
		});

		try {
			await expect(import('./cart.svelte')).resolves.toHaveProperty('createCart');
		} finally {
			if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
			else Reflect.deleteProperty(globalThis, 'window');
		}
	});
});
