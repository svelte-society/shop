<script lang="ts">
	import type { PublicCatalogProduct } from '$lib/domain/catalog';
	import { formatEur } from '$lib/domain/money';
	import type { DisplayPrice, PricedPublicCatalogVariant } from '$lib/domain/pricing';

	type Props = {
		product: PublicCatalogProduct;
		variant: PricedPublicCatalogVariant;
		unitDisplayPrice: DisplayPrice;
		lineDisplayPrice: DisplayPrice;
		quantity: number;
		maxQuantity: number;
		onQuantityChange: (quantity: number) => void;
		onRemove: () => void;
	};

	let {
		product,
		variant,
		unitDisplayPrice,
		lineDisplayPrice,
		quantity,
		maxQuantity,
		onQuantityChange,
		onRemove
	}: Props = $props();

	function handleQuantityChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const nextQuantity = Number(input.value);

		if (!Number.isSafeInteger(nextQuantity) || nextQuantity < 1 || nextQuantity > maxQuantity) {
			input.value = String(quantity);
			return;
		}

		onQuantityChange(nextQuantity);
	}
</script>

<article class="cart-line">
	<div class="product-frame">
		<img src={product.images[0]} alt={product.name} />
	</div>

	<div class="line-details">
		<p class="category">{product.category === 'apparel' ? 'Apparel' : 'Accessory'}</p>
		<h2>{product.name}</h2>
		<p class="variant">{variant.label}</p>
		<p class="unit-price">{formatEur(unitDisplayPrice.grossCents)} each</p>

		<div class="line-actions">
			<label for={`quantity-${variant.priceId}`}>Quantity</label>
			<input
				id={`quantity-${variant.priceId}`}
				type="number"
				min="1"
				max={maxQuantity}
				value={quantity}
				inputmode="numeric"
				onchange={handleQuantityChange}
			/>
			<button
				type="button"
				onclick={onRemove}
				aria-label={`Remove ${product.name}, ${variant.label}`}
			>
				Remove
			</button>
		</div>
	</div>

	<p class="line-total" aria-label={`Line total ${formatEur(lineDisplayPrice.grossCents)}`}>
		{formatEur(lineDisplayPrice.grossCents)}
	</p>
</article>

<style>
	.cart-line {
		display: grid;
		grid-template-columns: minmax(5.5rem, 7.5rem) minmax(0, 1fr) auto;
		gap: clamp(1rem, 3vw, 1.5rem);
		align-items: start;
		padding-block: 1.5rem;
		border-bottom: 1px solid oklch(87% 0.018 255);
		color: var(--color-ink, oklch(24% 0.025 255));
	}

	.product-frame {
		aspect-ratio: 4 / 5;
		overflow: hidden;
		border: 1px solid oklch(88% 0.03 35);
		border-radius: 0.75rem;
		background: var(--color-svelte-50, oklch(97.02% 0.0151 37.88));
	}

	.product-frame img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.line-details {
		min-width: 0;
	}

	.category,
	.variant,
	.unit-price,
	.line-total {
		margin: 0;
	}

	.category {
		color: var(--color-svelte-text, oklch(54% 0.22 34.2));
		font-size: 0.75rem;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	h2 {
		margin: 0.25rem 0;
		font-size: clamp(1.05rem, 2vw, 1.3rem);
		line-height: 1.25;
	}

	.variant,
	.unit-price {
		color: oklch(44% 0.025 255);
	}

	.unit-price {
		margin-top: 0.25rem;
		font-size: 0.9rem;
	}

	.line-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.line-actions label {
		font-size: 0.875rem;
		font-weight: 700;
	}

	.line-actions input,
	.line-actions button {
		min-width: 2.75rem;
		min-height: 2.75rem;
		border-radius: 0.5rem;
		font: inherit;
	}

	.line-actions input {
		width: 4.25rem;
		border: 1px solid var(--color-control-border, oklch(51% 0.024 255));
		padding-inline: 0.65rem;
		background: white;
		color: inherit;
	}

	.line-actions button {
		border: 0;
		padding-inline: 0.75rem;
		background: transparent;
		color: oklch(45% 0.17 28);
		font-weight: 750;
		text-decoration: underline;
		text-underline-offset: 0.2em;
		cursor: pointer;
	}

	.line-total {
		font-weight: 800;
		white-space: nowrap;
	}

	@media (max-width: 34rem) {
		.cart-line {
			grid-template-columns: 5.5rem minmax(0, 1fr);
		}

		.line-total {
			grid-column: 2;
			grid-row: 1;
			justify-self: end;
			padding-left: 0.5rem;
		}

		.line-details {
			padding-top: 1.75rem;
		}
	}
</style>
