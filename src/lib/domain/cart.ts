import * as v from 'valibot';

export type CartLine = { priceId: string; quantity: number };
export type ShippingMode = 'paid' | 'free';

const MAX_DISTINCT_PRICES = 10;
const MAX_TOTAL_UNITS = 20;

const cartLineSchema = v.strictObject({
	priceId: v.pipe(v.string(), v.minLength(1)),
	quantity: v.pipe(v.number(), v.safeInteger(), v.minValue(1))
});

const cartSchema = v.array(cartLineSchema);

export function parseCart(input: unknown): CartLine[] {
	const result = v.safeParse(cartSchema, input);

	if (!result.success) {
		throw new Error('CART_INVALID');
	}

	const quantitiesByPrice = new Map<string, number>();

	for (const line of result.output) {
		quantitiesByPrice.set(line.priceId, (quantitiesByPrice.get(line.priceId) ?? 0) + line.quantity);
	}

	const lines = Array.from(quantitiesByPrice, ([priceId, quantity]) => ({ priceId, quantity }));

	if (lines.length > MAX_DISTINCT_PRICES) {
		throw new Error('CART_TOO_MANY_DISTINCT_PRICES');
	}

	if (totalUnits(lines) > MAX_TOTAL_UNITS) {
		throw new Error('CART_TOO_MANY_UNITS');
	}

	return lines;
}

export function totalUnits(lines: CartLine[]): number {
	return lines.reduce((total, line) => total + line.quantity, 0);
}

export function selectShippingMode(lines: CartLine[]): ShippingMode {
	return totalUnits(lines) >= 2 ? 'free' : 'paid';
}
