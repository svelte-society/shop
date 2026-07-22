<script lang="ts">
	import type { PublicCatalogProduct } from '$lib/domain/catalog';
	import {
		pricePublicProduct,
		type PricingDestination
	} from '$lib/domain/pricing';
	import ProductCard from './ProductCard.svelte';

	type Props = { products: PublicCatalogProduct[]; destination: PricingDestination };

	let { products, destination }: Props = $props();
	let pricedProducts = $derived(products.map((product) => pricePublicProduct(product, destination)));
	let apparel = $derived(pricedProducts.filter((product) => product.category === 'apparel'));
	let accessories = $derived(pricedProducts.filter((product) => product.category === 'accessory'));
	let mixedCollection = $derived(apparel.length > 0 && accessories.length > 0);
</script>

{#if pricedProducts.length === 0}
	<div class="empty-collection" role="status">
		<p class="empty-title">The collection is being arranged.</p>
		<p>Check back shortly.</p>
	</div>
{:else if mixedCollection}
	<div class="catalog-groups">
		<section aria-labelledby="apparel-heading">
			<h3 id="apparel-heading">Apparel</h3>
			<div class="product-grid">
				{#each apparel as product (product.slug)}<ProductCard {product} />{/each}
			</div>
		</section>

		<section aria-labelledby="accessories-heading">
			<h3 id="accessories-heading">Accessories</h3>
			<div class="product-grid">
				{#each accessories as product (product.slug)}<ProductCard {product} />{/each}
			</div>
		</section>
	</div>
{:else}
	<div class="product-grid">
		{#each pricedProducts as product (product.slug)}<ProductCard {product} />{/each}
	</div>
{/if}

<style>
	.catalog-groups {
		display: grid;
		gap: clamp(3rem, 8vw, 6rem);
	}

	h3 {
		margin: 0 0 1.1rem;
		font-size: clamp(1.35rem, 3vw, 1.9rem);
		letter-spacing: -0.025em;
	}

	.product-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: clamp(1.25rem, 3vw, 2.25rem);
	}

	.empty-collection {
		max-width: 38rem;
		padding: clamp(1.5rem, 5vw, 2.5rem);
		border: 1px solid color-mix(in oklch, var(--color-svelte-300) 44%, var(--color-border));
		border-radius: 0.9rem;
		background: var(--color-svelte-50);
	}

	.empty-collection p {
		margin: 0;
	}

	.empty-collection .empty-title {
		margin-bottom: 0.35rem;
		font-size: 1.2rem;
		font-weight: 800;
	}

	@media (max-width: 50rem) {
		.product-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 34rem) {
		.product-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
