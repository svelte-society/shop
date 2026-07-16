<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { beginCheckout } from '$lib/client/checkout';
	import CartLineItem from '$lib/components/CartLineItem.svelte';
	import CartSummary from '$lib/components/CartSummary.svelte';
	import type { CartLine } from '$lib/domain/cart';
	import type { PublicCatalogProduct, PublicCatalogVariant } from '$lib/domain/catalog';
	import { cart } from '$lib/stores/cart.svelte';
	import type { PageProps } from './$types';

	type ResolvedLine = {
		line: CartLine;
		product: PublicCatalogProduct;
		variant: PublicCatalogVariant;
	};

	let { data }: PageProps = $props();
	let ready = $state(false);
	let checkoutPending = $state(false);
	let checkoutError = $state<string | null>(null);

	let catalogByPriceId = $derived.by(() => {
		const catalog = new SvelteMap<
			string,
			{ product: PublicCatalogProduct; variant: PublicCatalogVariant }
		>();

		for (const product of data.products) {
			for (const variant of product.variants) {
				catalog.set(variant.priceId, { product, variant });
			}
		}

		return catalog;
	});

	let resolvedLines = $derived.by((): ResolvedLine[] => {
		if (!ready) return [];

		return cart.lines.flatMap((line) => {
			const resolved = catalogByPriceId.get(line.priceId);
			return resolved ? [{ line, ...resolved }] : [];
		});
	});

	let hasUnavailableLines = $derived(
		ready && cart.lines.some((line) => !catalogByPriceId.has(line.priceId))
	);
	let subtotalCents = $derived(
		resolvedLines.reduce(
			(total, { line, variant }) => total + line.quantity * variant.referenceGrossCents,
			0
		)
	);

	async function startCheckout(): Promise<void> {
		if (!data.checkoutEnabled || checkoutPending) return;

		checkoutPending = true;
		checkoutError = null;
		try {
			await beginCheckout(cart.lines);
		} catch {
			checkoutError = 'Checkout is temporarily unavailable. Your cart is safe. Try again shortly.';
			checkoutPending = false;
		}
	}

	onMount(() => {
		ready = true;
	});
</script>

<svelte:head>
	<title>Your cart — Svelte Society Shop</title>
	<meta
		name="description"
		content="Review your Svelte Society merch, update quantities, and check the free-shipping threshold."
	/>
</svelte:head>

<main class="cart-page">
	{#if !ready}
		<section class="status-card" aria-busy="true">
			<p role="status">Loading your cart…</p>
		</section>
	{:else if cart.lines.length === 0}
		<section class="empty-state">
			<p class="eyebrow">Society Shop</p>
			<h1>Your cart is empty.</h1>
			<p>Pick something made for Svelte people.</p>
			<a class="primary-link" href={resolve('/#collection')}>Browse the collection</a>
		</section>
	{:else if data.catalogUnavailable || hasUnavailableLines}
		<section class="status-card" role="status">
			<p class="eyebrow">Your cart is preserved</p>
			<h1>Collection temporarily unavailable.</h1>
			<p>Your cart is safe. Try again shortly.</p>
		</section>
	{:else}
		<header class="page-heading">
			<p class="eyebrow">Society Shop</p>
			<h1>Your cart</h1>
			<p>{cart.totalUnits} {cart.totalUnits === 1 ? 'item' : 'items'} ready to review.</p>
		</header>

		<div class="cart-layout">
			<section aria-label="Cart items">
				<ul class="line-list">
					{#each resolvedLines as { line, product, variant } (line.priceId)}
						<li>
							<CartLineItem
								{product}
								{variant}
								quantity={line.quantity}
								maxQuantity={20 - cart.totalUnits + line.quantity}
								onQuantityChange={(quantity) => cart.setQuantity(line.priceId, quantity)}
								onRemove={() => cart.remove(line.priceId)}
							/>
						</li>
					{/each}
				</ul>
			</section>

			<CartSummary
				totalUnits={cart.totalUnits}
				{subtotalCents}
				checkoutEnabled={data.checkoutEnabled}
				{checkoutPending}
				{checkoutError}
				onCheckout={startCheckout}
			/>
		</div>
	{/if}
</main>

<style>
	.cart-page {
		width: min(72rem, calc(100% - 2rem));
		min-height: 70vh;
		margin-inline: auto;
		padding-block: clamp(3rem, 8vw, 6rem);
		color: var(--color-ink, oklch(24% 0.025 255));
	}

	.page-heading {
		max-width: 44rem;
		margin-bottom: clamp(1.5rem, 4vw, 3rem);
	}

	.eyebrow {
		margin: 0 0 0.5rem;
		color: var(--color-svelte-text, oklch(54% 0.22 34.2));
		font-size: 0.8rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	h1 {
		margin: 0;
		font-size: clamp(2.25rem, 7vw, 4.5rem);
		line-height: 0.98;
		letter-spacing: -0.045em;
	}

	.page-heading > p:last-child,
	.empty-state > p,
	.status-card > p {
		font-size: clamp(1rem, 2vw, 1.15rem);
		line-height: 1.6;
	}

	.cart-layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(18rem, 24rem);
		gap: clamp(2rem, 6vw, 5rem);
		align-items: start;
	}

	.line-list {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid oklch(87% 0.018 255);
	}

	.empty-state,
	.status-card {
		max-width: 42rem;
		padding: clamp(1.5rem, 5vw, 3rem);
		border: 1px solid oklch(88% 0.03 35);
		border-radius: 1rem;
		background: var(--color-svelte-50, oklch(97.02% 0.0151 37.88));
	}

	.primary-link {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		margin-top: 0.75rem;
		border-radius: 0.65rem;
		padding: 0.65rem 1rem;
		background: var(--color-svelte-900, oklch(65.43% 0.2341 34.2));
		color: var(--color-ink, oklch(24% 0.025 255));
		font-weight: 800;
		text-decoration: none;
	}

	@media (max-width: 52rem) {
		.cart-layout {
			grid-template-columns: 1fr;
		}
	}
</style>
