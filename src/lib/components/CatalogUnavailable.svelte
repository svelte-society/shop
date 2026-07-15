<section class="unavailable" role="status" aria-labelledby="catalog-unavailable-title">
	<p class="eyebrow">Your cart is preserved</p>
	<h2 id="catalog-unavailable-title">Collection temporarily unavailable.</h2>
	<p>Your cart is safe. Try again shortly.</p>
</section>

<style>
	.unavailable {
		max-width: 42rem;
		padding: clamp(1.5rem, 5vw, 3rem);
		border: 1px solid color-mix(in oklch, var(--color-svelte-300) 44%, var(--color-border));
		border-radius: 1rem;
		background: var(--color-svelte-50);
	}

	.eyebrow {
		margin: 0 0 0.6rem;
		color: var(--color-svelte-900);
		font-size: 0.75rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	h2 {
		margin: 0;
		font-size: clamp(1.8rem, 5vw, 3rem);
		line-height: 1.05;
		letter-spacing: -0.04em;
	}

	.unavailable > p:last-child {
		margin: 1rem 0 0;
		font-size: 1.05rem;
	}
</style>
