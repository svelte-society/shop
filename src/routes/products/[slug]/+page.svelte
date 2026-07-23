<script lang="ts">
	import { resolve } from '$app/paths';
	import CatalogUnavailable from '$lib/components/CatalogUnavailable.svelte';
	import ProductGallery from '$lib/components/ProductGallery.svelte';
	import ProductPurchase from '$lib/components/ProductPurchase.svelte';
	import { pricePublicProduct } from '$lib/domain/pricing';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let sizeGuide = $derived(data.product?.sizeChart ?? null);
	let pricedProduct = $derived(
		data.product ? pricePublicProduct(data.product, data.pricingDestination) : null
	);
</script>

<svelte:head>
	<title
		>{data.product
			? `${data.product.name} — Svelte Society Shop`
			: 'Collection unavailable — Svelte Society Shop'}</title
	>
	{#if data.product}<meta name="description" content={data.product.description} />{/if}
</svelte:head>

<main class="product-page">
	{#if data.catalogUnavailable || !data.product}
		<CatalogUnavailable headingLevel="h1" />
	{:else}
		<a class="back-link" href={resolve('/#collection')}>← Back to collection</a>

		<div class="product-layout">
			<ProductGallery name={data.product.name} images={data.product.images} />

			<div class="product-copy">
				<p class="eyebrow">{data.product.category === 'apparel' ? 'Apparel' : 'Accessory'}</p>
				<h1>{data.product.name}</h1>
				<p class="description">{data.product.description}</p>
				{#if pricedProduct}<ProductPurchase
						product={pricedProduct}
						destination={data.pricingDestination}
					/>{/if}
			</div>
		</div>

		<section class="product-details" aria-labelledby="details-title">
			<header>
				<p class="eyebrow">Product details</p>
				<h2 id="details-title">Made to be used.</h2>
			</header>
			<div class="details-content">
				<div class="details-grid">
					<article>
						<h3>Materials</h3>
						<p>{data.product.materials}</p>
					</article>
					{#if data.product.fit}<article>
							<h3>Fit</h3>
							<p>{data.product.fit}</p>
						</article>{/if}
					<article>
						<h3>Care</h3>
						<p>{data.product.care}</p>
					</article>
				</div>

				{#if sizeGuide}
					<div class="size-guide">
						<h3>Size guide</h3>
						<p id="size-guide-help">
							Garment measurements in {sizeGuide.unit}. Compare them with a similar item you already
							own.
						</p>
						<div class="table-wrap">
							<table
								class:compact={sizeGuide.sizes.length <= 3}
								aria-label={`${data.product.name} size guide`}
								aria-describedby="size-guide-help"
							>
								<thead>
									<tr>
										<th scope="col">Measurement</th>
										{#each sizeGuide.sizes as size (size)}<th scope="col">{size}</th>{/each}
									</tr>
								</thead>
								<tbody>
									{#each sizeGuide.measurements as measurement (measurement.label)}
										<tr>
											<th scope="row">{measurement.label}</th>
											{#each measurement.values as value, index (index)}<td>{value}</td>{/each}
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				{/if}
			</div>
		</section>
	{/if}
</main>

<style>
	.product-page {
		width: min(76rem, calc(100% - 2rem));
		min-height: 70vh;
		margin-inline: auto;
		padding-block: clamp(2rem, 6vw, 5rem);
		color: var(--color-ink);
	}

	.back-link {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		margin-bottom: 1.5rem;
		border-radius: 0.45rem;
		font-weight: 750;
		text-underline-offset: 0.25rem;
	}

	.product-layout {
		display: grid;
		grid-template-columns: minmax(0, 1.08fr) minmax(20rem, 0.92fr);
		gap: clamp(2rem, 7vw, 6rem);
		align-items: start;
	}

	.product-copy {
		position: sticky;
		top: 1.5rem;
		padding-top: clamp(0.5rem, 3vw, 2rem);
	}

	.eyebrow {
		margin: 0 0 0.65rem;
		color: var(--color-svelte-text);
		font-size: 0.75rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	h1,
	h2,
	h3,
	p {
		margin-top: 0;
	}

	h1 {
		margin-bottom: 1rem;
		font-size: clamp(2.8rem, 7vw, 5.6rem);
		line-height: 0.94;
		letter-spacing: -0.06em;
	}

	.description {
		margin-bottom: 2rem;
		color: var(--color-slate-700);
		font-size: clamp(1rem, 2vw, 1.2rem);
		line-height: 1.7;
		white-space: pre-line;
	}

	.product-details {
		display: grid;
		grid-template-columns: minmax(14rem, 0.7fr) minmax(0, 1.3fr);
		gap: clamp(2rem, 8vw, 7rem);
		margin-top: clamp(4.5rem, 10vw, 8rem);
		padding-block: clamp(3rem, 7vw, 5rem);
		border-top: 1px solid var(--color-border);
	}

	.product-details h2 {
		margin-bottom: 0;
		font-size: clamp(2rem, 5vw, 3.7rem);
		line-height: 0.98;
		letter-spacing: -0.05em;
	}

	.details-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0;
		border: 1px solid var(--color-border);
	}

	.details-content,
	.size-guide,
	.table-wrap {
		min-width: 0;
	}

	.details-grid article {
		min-width: 0;
		padding: 1.5rem;
		background: var(--color-white);
	}

	.details-grid article + article {
		border-left: 1px solid var(--color-border);
	}

	.details-grid h3 {
		margin-bottom: 0.55rem;
		font-size: 1rem;
	}

	.details-grid p {
		margin-bottom: 0;
		color: var(--color-slate-700);
		font-size: 0.92rem;
		line-height: 1.6;
		white-space: pre-line;
	}

	.size-guide {
		margin-top: 1.5rem;
		padding: clamp(1.25rem, 3vw, 2rem);
		border: 1px solid var(--color-border);
		background: var(--color-white);
	}

	.size-guide h3 {
		margin-bottom: 0.4rem;
		font-size: 1.25rem;
	}

	.size-guide > p {
		margin-bottom: 1.25rem;
		color: var(--color-slate-700);
		font-size: 0.92rem;
		line-height: 1.6;
	}

	.table-wrap {
		overflow-x: auto;
		overscroll-behavior-inline: contain;
	}

	table {
		width: 100%;
		min-width: 28rem;
		border-collapse: collapse;
		font-variant-numeric: tabular-nums;
	}

	th,
	td {
		padding: 0.8rem 0.75rem;
		border-bottom: 1px solid var(--color-border);
		text-align: center;
	}

	thead th {
		background: var(--color-svelte-50);
		font-size: 0.8rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	th:first-child {
		text-align: left;
	}

	tbody th {
		font-size: 0.9rem;
	}

	tbody td {
		color: var(--color-slate-700);
	}

	tbody tr:last-child th,
	tbody tr:last-child td {
		border-bottom: 0;
	}

	@media (max-width: 48rem) {
		.product-layout,
		.product-details {
			grid-template-columns: 1fr;
		}

		.product-copy {
			position: static;
			padding-inline: 0.25rem;
		}

		.product-details {
			gap: 2rem;
		}
	}

	@media (max-width: 34rem) {
		table.compact {
			min-width: 0;
			table-layout: fixed;
		}

		table.compact th:first-child {
			width: 44%;
		}

		table.compact th,
		table.compact td {
			padding-inline: 0.35rem;
		}

		.details-grid {
			grid-template-columns: 1fr;
		}

		.details-grid article + article {
			border-top: 1px solid var(--color-border);
			border-left: 0;
		}
	}
</style>
