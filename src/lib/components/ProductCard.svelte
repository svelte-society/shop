<script lang="ts">
	import { resolve } from '$app/paths';
	import { track } from '$lib/analytics/events';
	import type { PublicCatalogProduct } from '$lib/domain/catalog';
	import { formatEur } from '$lib/domain/money';

	type Props = { product: PublicCatalogProduct };

	let { product }: Props = $props();
	let imageReady = $state(false);
	let lowestPrice = $derived(
		Math.min(...product.variants.map((variant) => variant.unitAmountCents))
	);
</script>

<article class="product-card">
	<a
		href={resolve('/products/[slug]', { slug: product.slug })}
		onclick={() => track('product_viewed')}
	>
		<div class="product-frame" aria-busy={!imageReady}>
			<img
				src={product.images[0]}
				alt={product.name}
				loading="lazy"
				onload={() => (imageReady = true)}
				onerror={() => (imageReady = true)}
			/>
			{#if !imageReady}<span class="image-loading">Loading product image…</span>{/if}
		</div>

		<div class="card-copy">
			<div>
				<p class="category">{product.category === 'apparel' ? 'Apparel' : 'Accessory'}</p>
				<h4>{product.name}</h4>
			</div>
			<p class="price">{product.variants.length > 1 ? 'From ' : ''}{formatEur(lowestPrice)}</p>
		</div>
	</a>
</article>

<style>
	.product-card {
		min-width: 0;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border);
	}

	a {
		display: block;
		border-radius: 0.8rem;
		text-decoration: none;
	}

	.product-frame {
		position: relative;
		aspect-ratio: 4 / 5;
		overflow: hidden;
		border: 1px solid color-mix(in oklch, var(--color-svelte-300) 38%, var(--color-border));
		border-radius: 0.8rem;
		background:
			linear-gradient(
				145deg,
				transparent 65%,
				color-mix(in oklch, var(--color-svelte-100) 72%, transparent)
			),
			var(--color-svelte-50);
	}

	img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		transition:
			transform 180ms ease,
			opacity 160ms ease;
	}

	.product-frame[aria-busy='true'] img {
		opacity: 0;
	}

	.image-loading {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: var(--color-text-muted);
		font-size: 0.8rem;
		font-weight: 700;
	}

	.card-copy {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.95rem 0.2rem 0.25rem;
	}

	.category,
	h4,
	.price {
		margin: 0;
	}

	.category {
		color: var(--color-svelte-text);
		font-size: 0.7rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	h4 {
		margin-top: 0.2rem;
		font-size: clamp(1rem, 2vw, 1.2rem);
		line-height: 1.25;
	}

	.price {
		padding-top: 1.15rem;
		font-size: 0.9rem;
		font-weight: 800;
		white-space: nowrap;
	}

	a:hover img {
		transform: scale(1.018);
	}
</style>
