<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<footer>
	<div class="footer-inner">
		<div class="footer-intro">
			<p class="footer-title">Society Shop</p>
			<p>Official merch for Svelte people, wherever the community gathers.</p>
		</div>

		<nav aria-label="Shop information">
			<a href={resolve('/withdraw' as '/')}>Withdraw from purchase</a>
			<a href={resolve('/shipping' as '/')}>Shipping</a>
			<a href={resolve('/returns' as '/')}>Returns</a>
			<a href={resolve('/privacy' as '/')}>Privacy</a>
			<a href={resolve('/terms' as '/')}>Terms</a>
			<a href={resolve('/about' as '/')}>About</a>
		</nav>

		<a class="support-link" href="mailto:merch@sveltesociety.dev">merch@sveltesociety.dev</a>
	</div>
</footer>

<style>
	footer {
		border-top: 1px solid var(--color-border);
		background: var(--color-ink);
		color: var(--color-white);
	}

	.footer-inner {
		display: grid;
		width: min(76rem, calc(100% - 2rem));
		grid-template-columns: minmax(15rem, 1fr) auto;
		gap: 1.5rem 3rem;
		align-items: start;
		margin-inline: auto;
		padding-block: clamp(2.5rem, 7vw, 4.5rem);
	}

	.footer-intro {
		max-width: 30rem;
	}

	.footer-intro p {
		margin: 0;
		color: color-mix(in oklch, var(--color-white) 72%, transparent);
	}

	.footer-intro .footer-title {
		margin-bottom: 0.5rem;
		color: var(--color-white);
		font-size: 1.15rem;
		font-weight: 800;
	}

	nav {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.25rem 1rem;
	}

	nav a,
	.support-link {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		border-radius: 0.4rem;
		font-weight: 700;
		text-underline-offset: 0.25rem;
	}

	.support-link {
		grid-column: 1 / -1;
		width: fit-content;
		color: var(--color-svelte-300);
	}

	@media (max-width: 44rem) {
		.footer-inner {
			grid-template-columns: 1fr;
		}

		nav {
			justify-content: flex-start;
		}

		.support-link {
			grid-column: auto;
		}
	}
</style>
