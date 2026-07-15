<script lang="ts">
	import { resolve } from '$app/paths';
	import { cart } from '$lib/stores/cart.svelte';

	let cartCount = $derived(cart.totalUnits);
</script>

<header class="site-header">
	<div class="header-inner">
		<a class="brand-link" href={resolve('/')} aria-label="Society Shop home">
			<img src="/brand/svelte-society.svg" alt="" width="117" height="55" />
			<span>Shop</span>
		</a>

		<nav aria-label="Primary navigation">
			<a href={resolve('/#collection')}>Collection</a>
			<a href="https://sveltesociety.dev/">Svelte Society</a>
			<a
				class="cart-link"
				href={resolve('/cart')}
				aria-label={`Cart, ${cartCount} ${cartCount === 1 ? 'item' : 'items'}`}
			>
				<span>Cart</span>
				<span class="cart-count" aria-hidden="true">{cartCount}</span>
			</a>
		</nav>
	</div>
</header>

<style>
	.site-header {
		position: relative;
		z-index: 10;
		border-bottom: 1px solid var(--color-border);
		background: color-mix(in oklch, var(--color-paper) 94%, transparent);
	}

	.header-inner {
		display: flex;
		width: min(76rem, calc(100% - 2rem));
		min-height: 5rem;
		align-items: center;
		justify-content: space-between;
		gap: 1.5rem;
		margin-inline: auto;
	}

	.brand-link {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		gap: 0.7rem;
		border-radius: 0.5rem;
		color: var(--color-ink);
		font-size: 0.8rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-decoration: none;
		text-transform: uppercase;
	}

	.brand-link img {
		display: block;
		width: 6.4rem;
		height: auto;
	}

	.brand-link span {
		padding-left: 0.7rem;
		border-left: 1px solid var(--color-border);
	}

	nav {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: clamp(0.15rem, 1vw, 0.75rem);
	}

	nav a {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		border-radius: 0.5rem;
		padding: 0.6rem clamp(0.55rem, 1.3vw, 0.85rem);
		font-size: 0.88rem;
		font-weight: 750;
		text-decoration: none;
		text-underline-offset: 0.25rem;
	}

	nav a:hover {
		text-decoration: underline;
	}

	.cart-link {
		gap: 0.5rem;
	}

	.cart-count {
		display: grid;
		min-width: 1.75rem;
		height: 1.75rem;
		place-items: center;
		border-radius: 999px;
		background: var(--color-svelte-900);
		color: var(--color-ink);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	@media (max-width: 44rem) {
		.header-inner {
			flex-wrap: wrap;
			gap: 0.35rem 1rem;
			padding-block: 0.75rem;
		}

		.brand-link img {
			width: 5.85rem;
		}

		nav {
			width: 100%;
			justify-content: space-between;
		}

		nav a {
			padding-inline: 0.45rem;
		}
	}
</style>
