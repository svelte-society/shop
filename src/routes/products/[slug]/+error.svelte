<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
</script>

<svelte:head><title>Product not found — Svelte Society Shop</title></svelte:head>

<main class="error-page">
	<section>
		<p class="eyebrow">{page.status}</p>
		<h1>Product not found.</h1>
		<p>That product is not in the current collection.</p>
		<a href={resolve('/#collection')}>Browse the collection</a>
	</section>
</main>

<style>
	.error-page {
		display: grid;
		width: min(76rem, calc(100% - 2rem));
		min-height: 68vh;
		place-items: center;
		margin-inline: auto;
		padding-block: 4rem;
		color: var(--color-ink);
	}

	section {
		width: min(100%, 42rem);
		padding: clamp(1.5rem, 6vw, 4rem);
		border: 1px solid color-mix(in oklch, var(--color-svelte-300) 44%, var(--color-border));
		border-radius: 1rem;
		background: var(--color-svelte-50);
		text-align: center;
	}

	.eyebrow {
		margin: 0 0 0.75rem;
		color: var(--color-svelte-900);
		font-weight: 800;
		letter-spacing: 0.1em;
	}

	h1 {
		margin: 0;
		font-size: clamp(2.5rem, 7vw, 4.6rem);
		line-height: 0.96;
		letter-spacing: -0.055em;
	}

	section > p:last-of-type {
		margin: 1.25rem auto;
		font-size: 1.05rem;
	}

	a {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		border-radius: 0.65rem;
		padding: 0.7rem 1rem;
		background: var(--color-svelte-900);
		color: var(--color-white);
		font-weight: 800;
		text-decoration: none;
	}
</style>
