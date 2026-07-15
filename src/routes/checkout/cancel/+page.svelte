<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<svelte:head>
	<title>Checkout cancelled — Svelte Society Shop</title>
	<meta name="description" content="Return to your saved Svelte Society Shop cart." />
</svelte:head>

<main class="cancel-page">
	<section class="cancel-card">
		<p class="eyebrow">Nothing was lost</p>
		<h1>Checkout cancelled.</h1>
		<p>Your cart is still saved. Review it whenever you are ready.</p>
		<a href={resolve('/cart')}>Return to cart</a>
	</section>
</main>

<style>
	.cancel-page {
		display: grid;
		width: min(72rem, calc(100% - 2rem));
		min-height: 70vh;
		place-items: center;
		margin-inline: auto;
		padding-block: clamp(3rem, 8vw, 6rem);
		color: var(--color-ink, oklch(24% 0.025 255));
	}

	.cancel-card {
		width: min(100%, 42rem);
		padding: clamp(1.5rem, 6vw, 4rem);
		border: 1px solid oklch(88% 0.03 35);
		border-radius: 1rem;
		background: var(--color-svelte-50, oklch(97.02% 0.0151 37.88));
		text-align: center;
	}

	.eyebrow {
		margin: 0 0 0.75rem;
		color: var(--color-svelte-900, oklch(65.43% 0.2341 34.2));
		font-size: 0.8rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	h1 {
		margin: 0;
		font-size: clamp(2.25rem, 7vw, 4.5rem);
		line-height: 1;
		letter-spacing: -0.045em;
	}

	.cancel-card > p:last-of-type {
		margin: 1.25rem auto;
		font-size: clamp(1rem, 2vw, 1.15rem);
		line-height: 1.6;
	}

	a {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		border-radius: 0.65rem;
		padding: 0.65rem 1rem;
		background: var(--color-svelte-900, oklch(65.43% 0.2341 34.2));
		color: white;
		font-weight: 800;
		text-decoration: none;
	}
</style>
