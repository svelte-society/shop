<script lang="ts">
	import {
		pricingDisclosure,
		type PricingDestination,
		type PricedPublicCatalogProduct
	} from '$lib/domain/pricing';
	import { formatEur } from '$lib/domain/money';
	import { cart, type CartController } from '$lib/stores/cart.svelte';
	import VariantPicker from './VariantPicker.svelte';

	type Props = {
		product: PricedPublicCatalogProduct;
		destination: PricingDestination;
		cartController?: CartController;
	};

	let { product, destination, cartController = cart }: Props = $props();
	let selectedPriceId = $state<string | null>(null);
	let validationMessage = $state('');
	let cartMessage = $state('');
	let productIdentity = $derived(
		JSON.stringify([product.slug, product.category, product.variants.map((variant) => variant.priceId)])
	);
	let activeProductIdentity = $state('');
	let selectedVariant = $derived(
		product.variants.find((variant) => variant.priceId === selectedPriceId) ?? product.variants[0]
	);
	let pickerVariants = $derived(
		product.variants.map(({ displayPrice: _displayPrice, ...variant }) => variant)
	);

	$effect.pre(() => {
		const identity = productIdentity;
		if (identity === activeProductIdentity) return;

		activeProductIdentity = identity;
		selectedPriceId = null;
		validationMessage = '';
		cartMessage = '';
	});

	function handleSelection(priceId: string): void {
		selectedPriceId = priceId;
		validationMessage = '';
		cartMessage = '';
	}

	function addToCart(): void {
		if (!selectedPriceId) {
			validationMessage = `Choose ${product.category === 'apparel' ? 'a size' : 'an option'} before adding to cart.`;
			cartMessage = '';
			return;
		}

		const variant = product.variants.find((candidate) => candidate.priceId === selectedPriceId);
		if (!variant) return;

		try {
			cartController.add(variant.priceId);
		} catch (error) {
			cartMessage = '';

			if (error instanceof Error && error.message === 'CART_TOO_MANY_UNITS') {
				validationMessage = 'Your cart holds up to 20 items. Remove one before adding another.';
				return;
			}

			if (error instanceof Error && error.message === 'CART_TOO_MANY_DISTINCT_PRICES') {
				validationMessage = 'Your cart has 10 different options. Remove one before adding another.';
				return;
			}

			throw error;
		}

		validationMessage = '';
		cartMessage = `${product.name}, ${variant.label} added to cart.`;
	}
</script>

<div class="purchase-panel">
	<div class="price-block">
		<p class="price">{formatEur(selectedVariant.displayPrice.grossCents)}</p>
		<p>{pricingDisclosure(destination)}</p>
	</div>

	{#key productIdentity}
		<VariantPicker
			category={product.category}
			variants={pickerVariants}
			onSelectionChange={handleSelection}
		/>
	{/key}

	{#if product.sizeGuideUrl}
		<a class="size-guide" href={product.sizeGuideUrl} rel="external">Size guide</a>
	{/if}

	<div class="action-region">
		<p class="threshold">Free shipping when you pick two.</p>
		<button type="button" onclick={addToCart}>Add to cart</button>
		{#if validationMessage}
			<p class="validation" role="alert">{validationMessage}</p>
		{/if}
		<p class="cart-status" role="status" aria-label="Cart status" aria-live="polite">
			{cartMessage}
		</p>
	</div>
</div>

<style>
	.purchase-panel {
		display: grid;
		gap: 1.25rem;
	}

	.price-block p {
		margin: 0;
	}

	.price-block .price {
		font-size: clamp(1.65rem, 4vw, 2.15rem);
		font-weight: 800;
		letter-spacing: -0.035em;
	}

	.price-block p:last-child {
		margin-top: 0.2rem;
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}

	.size-guide {
		width: fit-content;
		font-weight: 750;
		text-underline-offset: 0.25rem;
	}

	.action-region {
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
	}

	.threshold {
		margin: 0 0 0.75rem;
		font-size: 0.92rem;
		font-weight: 750;
	}

	button {
		width: 100%;
		min-height: 2.75rem;
		border: 0;
		border-radius: 0.65rem;
		padding: 0.75rem 1rem;
		background: var(--color-svelte-900);
		color: var(--color-ink);
		font: inherit;
		font-weight: 800;
		cursor: pointer;
		transition:
			transform 140ms ease,
			background 140ms ease;
	}

	button:hover {
		transform: translateY(-1px);
		background: var(--color-svelte-500);
	}

	.validation,
	.cart-status {
		min-height: 1.4rem;
		margin: 0.5rem 0 0;
		font-size: 0.875rem;
	}

	.validation {
		color: oklch(42% 0.17 28);
		font-weight: 750;
	}

	.cart-status {
		color: oklch(37% 0.105 145);
		font-weight: 750;
	}

	@media (max-width: 48rem) {
		.action-region {
			position: sticky;
			bottom: 0;
			z-index: 8;
			margin-inline: -1rem;
			padding: 0.75rem 1rem max(0.75rem, env(safe-area-inset-bottom));
			border-top: 1px solid var(--color-border);
			background: color-mix(in oklch, var(--color-paper) 96%, transparent);
			box-shadow: 0 -0.4rem 1.4rem color-mix(in oklch, var(--color-ink) 10%, transparent);
			backdrop-filter: blur(0.75rem);
		}

		.threshold {
			display: none;
		}
	}
</style>
