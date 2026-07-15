import { parseCart, totalUnits as countUnits, type CartLine } from '$lib/domain/cart';

const CART_STORAGE_KEY = 'svelte-society-shop:cart:v1';
const CART_SCHEMA_VERSION = 1;

type CartStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type CartController = {
	readonly lines: CartLine[];
	readonly totalUnits: number;
	add(priceId: string, quantity?: number): void;
	setQuantity(priceId: string, quantity: number): void;
	remove(priceId: string): void;
	clear(): void;
};

function browserStorage(): CartStorage | undefined {
	if (typeof window === 'undefined') return undefined;

	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

function cloneLines(lines: CartLine[]): CartLine[] {
	return lines.map((line) => ({ ...line }));
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function removePersistedCart(storage: CartStorage | undefined): void {
	try {
		storage?.removeItem(CART_STORAGE_KEY);
	} catch {
		// Persistence is best-effort; the in-memory cart remains usable.
	}
}

function persistCart(storage: CartStorage | undefined, lines: CartLine[]): void {
	if (lines.length === 0) {
		removePersistedCart(storage);
		return;
	}

	try {
		storage?.setItem(
			CART_STORAGE_KEY,
			JSON.stringify({ version: CART_SCHEMA_VERSION, lines: cloneLines(lines) })
		);
	} catch {
		// Persistence is best-effort; the in-memory cart remains usable.
	}
}

function parsePersistedCart(value: string): CartLine[] {
	const input: unknown = JSON.parse(value);

	if (
		!isRecord(input) ||
		Object.keys(input).length !== 2 ||
		!Object.hasOwn(input, 'version') ||
		!Object.hasOwn(input, 'lines') ||
		input.version !== CART_SCHEMA_VERSION
	) {
		throw new Error('CART_STORAGE_INVALID');
	}

	return parseCart(input.lines);
}

function hydrateCart(storage: CartStorage | undefined): CartLine[] {
	if (!storage) return [];

	try {
		const persisted = storage.getItem(CART_STORAGE_KEY);
		if (persisted === null) return [];

		const lines = parsePersistedCart(persisted);
		persistCart(storage, lines);
		return lines;
	} catch {
		removePersistedCart(storage);
		return [];
	}
}

export function createCart(storage: CartStorage | undefined = browserStorage()): CartController {
	let lines = $state<CartLine[]>(hydrateCart(storage));

	function commit(nextLines: CartLine[]): void {
		lines = nextLines;
		persistCart(storage, lines);
	}

	return {
		get lines() {
			return cloneLines(lines);
		},
		get totalUnits() {
			return countUnits(lines);
		},
		add(priceId, quantity = 1) {
			commit(parseCart([...lines, { priceId, quantity }]));
		},
		setQuantity(priceId, quantity) {
			if (!lines.some((line) => line.priceId === priceId)) return;

			commit(
				parseCart(lines.map((line) => (line.priceId === priceId ? { ...line, quantity } : line)))
			);
		},
		remove(priceId) {
			if (!lines.some((line) => line.priceId === priceId)) return;
			commit(parseCart(lines.filter((line) => line.priceId !== priceId)));
		},
		clear() {
			commit([]);
		}
	};
}

let sharedCart: CartController | undefined;

function getSharedCart(): CartController {
	sharedCart ??= createCart();
	return sharedCart;
}

export const cart: CartController = {
	get lines() {
		return getSharedCart().lines;
	},
	get totalUnits() {
		return getSharedCart().totalUnits;
	},
	add(priceId, quantity) {
		getSharedCart().add(priceId, quantity);
	},
	setQuantity(priceId, quantity) {
		getSharedCart().setQuantity(priceId, quantity);
	},
	remove(priceId) {
		getSharedCart().remove(priceId);
	},
	clear() {
		getSharedCart().clear();
	}
};
