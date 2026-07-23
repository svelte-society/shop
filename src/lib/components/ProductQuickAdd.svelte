<script lang="ts">
	import { tick } from 'svelte';
	import type { PricedPublicCatalogProduct } from '$lib/domain/pricing';
	import { cart, type CartController } from '$lib/stores/cart.svelte';

	type Props = {
		product: PricedPublicCatalogProduct;
		cartController?: CartController;
	};

	let { product, cartController = cart }: Props = $props();
	let expanded = $state(false);
	let message = $state('');
	let errorMessage = $state('');
	let trigger = $state<HTMLButtonElement | null>(null);
	let chooser = $state<HTMLDivElement | null>(null);
	let chooserId = $derived(`quick-add-${product.slug}`);

	async function openChoices(): Promise<void> {
		message = '';
		errorMessage = '';
		if (product.variants.length === 1) {
			addVariant(product.variants[0]);
			return;
		}

		expanded = true;
		await tick();
		chooser?.querySelector<HTMLButtonElement>('[data-variant]')?.focus();
	}

	function closeChoices(): void {
		expanded = false;
		errorMessage = '';
		void tick().then(() => trigger?.focus());
	}

	function handleChooserKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;

		event.preventDefault();
		event.stopPropagation();
		closeChoices();
	}

	function addVariant(variant: PricedPublicCatalogProduct['variants'][number]): void {
		try {
			cartController.add(variant.priceId);
		} catch (error) {
			message = '';

			if (error instanceof Error && error.message === 'CART_TOO_MANY_UNITS') {
				errorMessage = 'Your cart holds up to 20 items. Remove one before adding another.';
				return;
			}

			if (error instanceof Error && error.message === 'CART_TOO_MANY_DISTINCT_PRICES') {
				errorMessage = 'Your cart has 10 different options. Remove one before adding another.';
				return;
			}

			throw error;
		}

		expanded = false;
		errorMessage = '';
		message = `${product.name}, ${variant.label} added to cart.`;
	}
</script>

<div class="quick-add">
	<button
		bind:this={trigger}
		class="add-button"
		type="button"
		aria-expanded={product.variants.length > 1 ? expanded : undefined}
		aria-controls={product.variants.length > 1 ? chooserId : undefined}
		onclick={openChoices}>Add to cart</button
	>

	{#if expanded}
		<div
			bind:this={chooser}
			id={chooserId}
			class="chooser"
			role="group"
			aria-label={`Choose a size for ${product.name}`}
		>
			<div class="chooser-heading">
				<span>Choose a size</span>
				<button
					class="close-button"
					type="button"
					aria-label="Close size choices"
					onclick={closeChoices}
					onkeydown={handleChooserKeydown}
					>×</button
				>
			</div>
			<div class="variant-options">
				{#each product.variants as variant (variant.priceId)}
					<button
						type="button"
						data-variant
						onclick={() => addVariant(variant)}
						onkeydown={handleChooserKeydown}
					>
						{variant.label}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	{#if errorMessage}<p class="validation" role="alert">{errorMessage}</p>{/if}
	<p class="cart-status" role="status" aria-label="Cart status" aria-live="polite">{message}</p>
</div>

<style>
	.quick-add {
		position: absolute;
		z-index: 2;
		inset: auto 0.75rem 0.75rem;
		display: grid;
		gap: 0.45rem;
	}

	button {
		min-height: 2.75rem;
		border: 0;
		font: inherit;
		font-weight: 800;
		cursor: pointer;
	}

	.add-button {
		border-radius: 0.65rem;
		padding: 0.7rem 1rem;
		background: color-mix(in oklch, var(--color-ink) 94%, transparent);
		color: var(--color-white);
		box-shadow: 0 0.3rem 1rem color-mix(in oklch, var(--color-ink) 18%, transparent);
		backdrop-filter: blur(0.5rem);
		transition:
			transform 140ms ease,
			background 140ms ease;
	}

	.add-button:hover {
		transform: translateY(-1px);
		background: var(--color-svelte-900);
		color: var(--color-ink);
	}

	.chooser {
		position: absolute;
		inset: auto 0 0;
		display: grid;
		gap: 0.65rem;
		width: 100%;
		border-radius: 0.7rem;
		padding: 0.7rem;
		background: var(--color-ink);
		color: var(--color-white);
		box-shadow: 0 0.45rem 1.3rem color-mix(in oklch, var(--color-ink) 28%, transparent);
	}

	.chooser-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		font-size: 0.82rem;
	}

	.close-button {
		min-width: 2.75rem;
		border-radius: 999px;
		padding: 0;
		background: color-mix(in oklch, var(--color-white) 12%, transparent);
		color: var(--color-white);
		font-size: 1.35rem;
		line-height: 1;
	}

	.variant-options {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(2.75rem, 1fr));
		gap: 0.45rem;
	}

	.variant-options button {
		border-radius: 0.5rem;
		padding: 0.5rem;
		background: var(--color-white);
		color: var(--color-ink);
	}

	.variant-options button:hover,
	.close-button:hover {
		background: var(--color-svelte-900);
		color: var(--color-ink);
	}

	.validation,
	.cart-status {
		margin: 0;
		border-radius: 0.45rem;
		padding: 0.45rem 0.55rem;
		background: color-mix(in oklch, var(--color-white) 94%, transparent);
		font-size: 0.76rem;
		font-weight: 800;
		line-height: 1.35;
	}

	.validation {
		color: oklch(42% 0.17 28);
	}

	.cart-status {
		color: oklch(35% 0.105 145);
	}

	.cart-status:empty {
		padding: 0;
		background: transparent;
	}
</style>
