import '../../app.css';
import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PublicCatalogProduct } from '$lib/domain/catalog';
import { createCart } from '$lib/stores/cart.svelte';
import ProductCard from './ProductCard.svelte';
import ProductPurchase from './ProductPurchase.svelte';
import VariantPicker from './VariantPicker.svelte';

const product: PublicCatalogProduct = {
	slug: 'society-mug',
	name: 'Society Mug',
	description: 'A mug for Svelte desks.',
	images: ['https://cdn.example.com/society-mug.jpg'],
	sortOrder: 10,
	category: 'accessory',
	materials: 'Ceramic',
	care: 'Dishwasher safe',
	fit: null,
	sizeGuideUrl: null,
	variants: [
		{
			priceId: 'price_mug',
			label: 'One size',
			sortOrder: 10,
			currency: 'eur',
			unitAmountCents: 1_600,
			referenceGrossCents: 2_000
		}
	]
};

const isolatedStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
	getItem: () => null,
	setItem: () => undefined,
	removeItem: () => undefined
};

function rgb(color: string): [number, number, number] {
	const canvas = document.createElement('canvas');
	canvas.width = 1;
	canvas.height = 1;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) throw new Error('TEST_CANVAS_UNAVAILABLE');
	context.fillStyle = '#000';
	context.fillStyle = color;
	context.fillRect(0, 0, 1, 1);
	const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
	return [red, green, blue];
}

function luminance([red, green, blue]: [number, number, number]): number {
	const linear = [red, green, blue].map((channel) => {
		const value = channel / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground: string, background: string): number {
	const foregroundLuminance = luminance(rgb(foreground));
	const backgroundLuminance = luminance(rgb(background));
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
}

describe('storefront contrast semantics', () => {
	it('keeps action text and small orange labels at 4.5:1 or better', () => {
		render(ProductPurchase, { product, cartController: createCart(isolatedStorage) });
		render(ProductCard, { product });

		const buttonStyle = getComputedStyle(
			page.getByRole('button', { name: 'Add to cart' }).element()
		);
		const categoryStyle = getComputedStyle(page.getByText('Accessory', { exact: true }).element());
		const rootStyle = getComputedStyle(document.documentElement);
		const paper = rootStyle.getPropertyValue('--color-paper').trim();

		expect(contrast(buttonStyle.color, buttonStyle.backgroundColor)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(categoryStyle.color, paper)).toBeGreaterThanOrEqual(4.5);
	});

	it('defines a dual focus treatment with a 3:1 edge on paper and orange', () => {
		const rootStyle = getComputedStyle(document.documentElement);
		const focus = rootStyle.getPropertyValue('--color-focus').trim();
		const paper = rootStyle.getPropertyValue('--color-paper').trim();
		const ink = rootStyle.getPropertyValue('--color-ink').trim();
		const orange = rootStyle.getPropertyValue('--color-svelte-900').trim();
		const focusRing = rootStyle.getPropertyValue('--focus-ring').trim();

		expect(focus).not.toBe('');
		expect(contrast(focus, paper)).toBeGreaterThanOrEqual(3);
		expect(contrast(focus, orange)).toBeGreaterThanOrEqual(3);
		expect(contrast(paper, ink)).toBeGreaterThanOrEqual(3);
		expect(focusRing.split(',')).toHaveLength(2);
		expect(focusRing).toContain('3px');
		expect(focusRing).toContain('6px');
	});

	it('keeps unselected variant boundaries at 3:1 against white and paper', () => {
		render(VariantPicker, {
			category: 'apparel',
			variants: product.variants,
			onSelectionChange: () => undefined
		});

		const rootStyle = getComputedStyle(document.documentElement);
		const controlBorder = rootStyle.getPropertyValue('--color-control-border').trim();
		const white = rootStyle.getPropertyValue('--color-white').trim();
		const paper = rootStyle.getPropertyValue('--color-paper').trim();
		const optionStyle = getComputedStyle(page.getByText('One size', { exact: true }).element());

		expect(contrast(optionStyle.borderTopColor, white)).toBeGreaterThanOrEqual(3);
		expect(contrast(optionStyle.borderTopColor, paper)).toBeGreaterThanOrEqual(3);
		expect(controlBorder).not.toBe('');
		expect(rgb(optionStyle.borderTopColor)).toEqual(rgb(controlBorder));
	});
});
