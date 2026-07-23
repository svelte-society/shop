<script lang="ts">
	import { resolve } from '$app/paths';
	import CatalogUnavailable from '$lib/components/CatalogUnavailable.svelte';
	import ProductGrid from '$lib/components/ProductGrid.svelte';
	import { displayPriceForDestination } from '$lib/domain/pricing';
	import { formatEur } from '$lib/domain/money';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let projectedShipping = $derived(
		data.paidShippingNetCents === null
			? null
			: displayPriceForDestination(data.paidShippingNetCents, data.pricingDestination)
	);
</script>

<svelte:head>
	<title>Svelte Society Shop — Official Community Merch</title>
	<meta
		name="description"
		content="Official Svelte Society apparel and accessories for Svelte developers. Shipping across the EU except Slovenia and to selected destinations in Asia. Free shipping on orders of two or more items."
	/>
</svelte:head>

<main>
	<section class="hero" aria-labelledby="hero-title">
		<div class="hero-copy">
			<p class="eyebrow">Society Shop</p>
			<h1 id="hero-title">Made for people who make with Svelte.</h1>
			<p>Official Svelte Society merch for meetups, desks, and wherever the community gathers.</p>
			<a class="primary-link" href={resolve('/#collection')}>Shop the collection</a>
		</div>

		<div class="shipping-signature" aria-label="Two or more items ship free">
			<strong>2</strong>
			<span>items<br />ship free</span>
		</div>
	</section>

	<section id="collection" class="collection" aria-labelledby="collection-title">
		<header class="section-heading">
			<div>
				<p class="eyebrow">The collection</p>
				<h2 id="collection-title">Svelte, out in the world.</h2>
			</div>
			<p>Apparel and accessories made to move from your desk to the next meetup.</p>
		</header>

		{#if data.catalogUnavailable}
			<CatalogUnavailable />
		{:else}
			{#if data.stale}
				<p class="stale-note" role="status">Showing the most recent available collection.</p>
			{/if}
			<ProductGrid products={data.products} destination={data.pricingDestination} />
		{/if}
	</section>

	<section class="commerce" aria-labelledby="commerce-title">
		<header>
			<p class="eyebrow">Good to know</p>
			<h2 id="commerce-title">Simple from shelf to doorstep.</h2>
		</header>
		<div class="commerce-grid">
			<article>
				<h3>Shipping</h3>
				{#if projectedShipping}
					<p>
						{formatEur(projectedShipping.grossCents)} for one item. Free shipping when you pick two or
						more.
					</p>
				{:else}
					<p>Current shipping is shown before checkout. Free shipping when you pick two or more.</p>
				{/if}
			</article>
			<article>
				<h3>Regions</h3>
				<p>Shipping across the EU, except Slovenia, and to selected destinations in Asia.</p>
			</article>
			<article>
				<h3>Support</h3>
				<p>
					Questions about an order? Email <a href="mailto:merch@sveltesociety.dev"
						>merch@sveltesociety.dev</a
					>.
				</p>
			</article>
		</div>
	</section>

	<section class="final-cta" aria-labelledby="final-cta-title">
		<p class="eyebrow">Meetup ready</p>
		<h2 id="final-cta-title">Find your piece of the Society.</h2>
		<a class="primary-link" href={resolve('/#collection')}>Shop the collection</a>
	</section>
</main>

<style>
	main {
		color: var(--color-ink);
	}

	.hero,
	.collection,
	.commerce,
	.final-cta {
		width: min(76rem, calc(100% - 2rem));
		margin-inline: auto;
	}

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(14rem, 22rem);
		gap: clamp(2rem, 8vw, 7rem);
		align-items: center;
		min-height: clamp(28rem, 64vh, 39rem);
		padding-block: clamp(3.5rem, 9vw, 7rem);
	}

	.hero-copy {
		max-width: 50rem;
	}

	.eyebrow {
		margin: 0 0 0.75rem;
		color: var(--color-svelte-text);
		font-size: 0.75rem;
		font-weight: 800;
		letter-spacing: 0.11em;
		text-transform: uppercase;
	}

	h1,
	h2,
	h3,
	p {
		margin-top: 0;
	}

	h1 {
		max-width: 50rem;
		margin-bottom: 1.25rem;
		font-size: clamp(3rem, 8.3vw, 6.5rem);
		font-weight: 800;
		line-height: 0.91;
		letter-spacing: -0.065em;
	}

	.hero-copy > p:not(.eyebrow) {
		max-width: 42rem;
		margin-bottom: 1.75rem;
		color: var(--color-slate-700);
		font-size: clamp(1.05rem, 2vw, 1.3rem);
		line-height: 1.65;
	}

	.primary-link {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		border-radius: 0.65rem;
		padding: 0.7rem 1.05rem;
		background: var(--color-svelte-900);
		color: var(--color-ink);
		font-weight: 800;
		text-decoration: none;
		transition:
			transform 140ms ease,
			background 140ms ease;
	}

	.primary-link:hover {
		transform: translateY(-1px);
		background: var(--color-svelte-500);
	}

	.shipping-signature {
		display: grid;
		aspect-ratio: 4 / 5;
		grid-template-columns: 1fr auto;
		align-items: end;
		border-radius: 1rem;
		padding: clamp(1.25rem, 4vw, 2rem);
		background: var(--color-ink);
		color: var(--color-white);
		box-shadow: 0.9rem 0.9rem 0 var(--color-svelte-100);
	}

	.shipping-signature strong {
		align-self: center;
		color: var(--color-svelte-500);
		font-size: clamp(7rem, 19vw, 13rem);
		font-weight: 800;
		line-height: 0.7;
		letter-spacing: -0.08em;
	}

	.shipping-signature span {
		font-size: clamp(0.9rem, 2vw, 1.1rem);
		font-weight: 800;
		line-height: 1.05;
		text-align: right;
		text-transform: uppercase;
	}

	.collection,
	.commerce {
		padding-block: clamp(4rem, 9vw, 7rem);
	}

	.collection {
		border-top: 1px solid var(--color-border);
	}

	.section-heading {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(18rem, 32rem);
		gap: 2rem;
		align-items: end;
		margin-bottom: clamp(2.5rem, 6vw, 4.5rem);
	}

	.section-heading h2,
	.commerce h2,
	.final-cta h2 {
		margin-bottom: 0;
		font-size: clamp(2.1rem, 5vw, 4.2rem);
		line-height: 0.98;
		letter-spacing: -0.05em;
	}

	.section-heading > p {
		margin-bottom: 0;
		color: var(--color-text-muted);
		font-size: 1.05rem;
		line-height: 1.65;
	}

	.stale-note {
		margin-bottom: 1.5rem;
		padding: 0.85rem 1rem;
		border-left: 0.25rem solid var(--color-svelte-900);
		background: var(--color-svelte-50);
		font-weight: 700;
	}

	.commerce {
		width: 100%;
		padding-inline: max(1rem, calc((100% - 76rem) / 2));
		background: var(--color-svelte-50);
	}

	.commerce header {
		max-width: 46rem;
		margin-bottom: clamp(2.5rem, 6vw, 4rem);
	}

	.commerce-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		border-block: 1px solid color-mix(in oklch, var(--color-svelte-300) 42%, var(--color-border));
	}

	.commerce-grid article {
		padding: 1.5rem clamp(1rem, 2.5vw, 2rem);
		border-left: 1px solid color-mix(in oklch, var(--color-svelte-300) 42%, var(--color-border));
	}

	.commerce-grid article:first-child {
		border-left: 0;
	}

	.commerce-grid h3 {
		margin-bottom: 0.65rem;
		font-size: 1rem;
	}

	.commerce-grid p {
		margin-bottom: 0;
		color: var(--color-slate-700);
		font-size: 0.9rem;
		line-height: 1.6;
	}

	.commerce-grid a {
		font-weight: 750;
		text-underline-offset: 0.2rem;
	}

	.final-cta {
		display: grid;
		justify-items: center;
		padding-block: clamp(4.5rem, 11vw, 8rem);
		text-align: center;
	}

	.final-cta h2 {
		max-width: 44rem;
		margin-bottom: 1.75rem;
	}

	@media (max-width: 52rem) {
		.hero {
			grid-template-columns: minmax(0, 1fr) minmax(10rem, 15rem);
			gap: 2rem;
		}

		.commerce-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.commerce-grid article:nth-child(3) {
			border-left: 0;
			border-top: 1px solid color-mix(in oklch, var(--color-svelte-300) 42%, var(--color-border));
		}

		.commerce-grid article:nth-child(4) {
			border-top: 1px solid color-mix(in oklch, var(--color-svelte-300) 42%, var(--color-border));
		}
	}

	@media (max-width: 40rem) {
		.hero {
			grid-template-columns: 1fr;
			min-height: auto;
		}

		.shipping-signature {
			width: min(100%, 15rem);
			justify-self: end;
		}

		.section-heading {
			grid-template-columns: 1fr;
			gap: 1rem;
		}
	}

	@media (max-width: 28rem) {
		.commerce-grid {
			grid-template-columns: 1fr;
		}

		.commerce-grid article,
		.commerce-grid article:nth-child(3) {
			border-top: 1px solid color-mix(in oklch, var(--color-svelte-300) 42%, var(--color-border));
			border-left: 0;
		}

		.commerce-grid article:first-child {
			border-top: 0;
		}
	}
</style>
