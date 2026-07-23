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
		content="Official Svelte Society merchandise that supports continued community work across the Svelte ecosystem. Free shipping on two or more items."
	/>
</svelte:head>

<main>
	<section class="hero" aria-labelledby="hero-title">
		<div class="hero-copy">
			<p class="eyebrow">Svelte Society Shop</p>
			<h1 id="hero-title">Wear Svelte. Support the community.</h1>
			<p>
				Every purchase supports Svelte Society’s continued work across the ecosystem—organizing
				community events, sharing useful resources, and helping Svelte developers connect.
			</p>
			<a class="primary-link" href={resolve('/#collection')}>Shop the collection</a>
		</div>

		<aside class="support-panel" aria-labelledby="support-title">
			<p class="eyebrow">Community-powered</p>
			<h2 id="support-title">Your purchase supports</h2>
			<ul>
				<li>Community events</li>
				<li>Shared resources</li>
				<li>Open-source projects</li>
				<li>Developer connections</li>
			</ul>
		</aside>
	</section>

	<section id="collection" class="collection" aria-labelledby="collection-title">
		<header class="section-heading">
			<div>
				<p class="eyebrow">The collection</p>
				<h2 id="collection-title">Svelte, out in the world.</h2>
			</div>
			<p>Community merch made to move from your desk to the next meetup.</p>
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
			<h2 id="commerce-title">From cart to doorstep.</h2>
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
</main>

<style>
	main {
		color: var(--color-ink);
	}

	.hero,
	.collection,
	.commerce {
		width: min(76rem, calc(100% - 2rem));
		margin-inline: auto;
	}

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(17rem, 24rem);
		gap: clamp(2rem, 7vw, 6rem);
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

	.support-panel {
		display: flex;
		min-height: clamp(24rem, 42vw, 31rem);
		flex-direction: column;
		border-radius: 1rem;
		padding: clamp(1.25rem, 4vw, 2rem);
		background: var(--color-ink);
		color: var(--color-white);
		box-shadow: 0.9rem 0.9rem 0 var(--color-svelte-100);
	}

	.support-panel .eyebrow {
		color: var(--color-svelte-500);
	}

	.support-panel h2 {
		max-width: 8ch;
		margin-bottom: 2rem;
		font-size: clamp(2.2rem, 5vw, 3.8rem);
		line-height: 0.95;
		letter-spacing: -0.05em;
	}

	.support-panel ul {
		display: grid;
		margin: auto 0 0;
		padding: 0;
		border-top: 1px solid color-mix(in oklch, var(--color-white) 24%, transparent);
		list-style: none;
	}

	.support-panel li {
		padding-block: 0.8rem;
		border-bottom: 1px solid color-mix(in oklch, var(--color-white) 24%, transparent);
		font-size: clamp(0.9rem, 2vw, 1rem);
		font-weight: 800;
		line-height: 1.25;
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
	.commerce h2 {
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
		grid-template-columns: repeat(3, minmax(0, 1fr));
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

	@media (max-width: 52rem) {
		.hero {
			grid-template-columns: minmax(0, 1fr) minmax(15rem, 19rem);
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

		.support-panel {
			min-height: auto;
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
