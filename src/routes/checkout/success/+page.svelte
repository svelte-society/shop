<script lang="ts">
	import { onMount } from 'svelte';
	import { track } from '$lib/analytics/events';
	import { cart } from '$lib/stores/cart.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	onMount(() => {
		if (data.verified) {
			track('checkout_returned_successfully');
			cart.clear();
		}
	});
</script>

<svelte:head>
	<title>Order received — Svelte Society Shop</title>
	<meta
		name="description"
		content="Receipt, fulfillment, and support expectations for a verified Svelte Society Shop order."
	/>
</svelte:head>

<main class="success-page">
	<section class="success-card">
		<h1>Order received.</h1>
		<p>
			Stripe is emailing your receipt and invoice now. Your order is queued for fulfillment review.
			We'll email again when it ships.
		</p>
		<p>Need help? Email <a href="mailto:merch@sveltesociety.dev">merch@sveltesociety.dev</a>.</p>
	</section>
</main>

<style>
	.success-page {
		display: grid;
		width: min(72rem, calc(100% - 2rem));
		min-height: 70vh;
		place-items: center;
		margin-inline: auto;
		padding-block: clamp(3rem, 8vw, 6rem);
		color: var(--color-ink, oklch(24% 0.025 255));
	}

	.success-card {
		width: min(100%, 42rem);
		padding: clamp(1.5rem, 6vw, 4rem);
		border: 1px solid oklch(88% 0.03 35);
		border-radius: 1rem;
		background: var(--color-svelte-50, oklch(97.02% 0.0151 37.88));
		text-align: center;
	}

	h1 {
		margin: 0;
		font-size: clamp(2.25rem, 7vw, 4.5rem);
		line-height: 1;
		letter-spacing: -0.045em;
	}

	.success-card > p {
		margin: 1.25rem auto 0;
		font-size: clamp(1rem, 2vw, 1.15rem);
		line-height: 1.6;
	}

	a {
		color: var(--color-svelte-text, oklch(54% 0.22 34.2));
		font-weight: 800;
		text-underline-offset: 0.2em;
	}
</style>
