<main id="main-content" class="opening-soon" tabindex="-1">
	<section aria-labelledby="opening-soon-title">
		<p class="eyebrow">Society Shop</p>
		<h1 id="opening-soon-title">The collection is getting ready.</h1>
		<p class="intro">
			Official Svelte Society merch is on its way. Visit Svelte Society while we prepare the shop.
		</p>
		<a href="https://sveltesociety.dev/">Visit Svelte Society</a>
	</section>
</main>

<style>
	.opening-soon {
		display: grid;
		min-height: clamp(30rem, 68vh, 46rem);
		place-items: center;
		padding: clamp(3rem, 9vw, 7rem) 1rem;
		background:
			linear-gradient(135deg, transparent 0 65%, var(--color-svelte-100) 65% 100%),
			var(--color-paper);
	}

	section {
		width: min(48rem, 100%);
		padding: clamp(1.5rem, 5vw, 4rem);
		border-left: 0.35rem solid var(--color-svelte-900);
		background: color-mix(in oklch, var(--color-paper) 92%, transparent);
	}

	.eyebrow {
		margin: 0 0 0.75rem;
		color: var(--color-svelte-900);
		font-size: 0.78rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	h1 {
		max-width: 12ch;
		margin: 0;
		font-size: clamp(2.6rem, 8vw, 6rem);
		line-height: 0.96;
		letter-spacing: -0.055em;
	}

	.intro {
		max-width: 38rem;
		margin: 1.5rem 0;
		color: var(--color-slate-700);
		font-size: clamp(1rem, 2.5vw, 1.2rem);
		line-height: 1.65;
	}

	a {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		border-radius: 0.6rem;
		padding: 0.7rem 1rem;
		background: var(--color-svelte-900);
		color: var(--color-white);
		font-weight: 800;
		text-decoration: none;
		transition: transform 160ms ease;
	}

	a:hover {
		transform: translateY(-2px);
	}
</style>
