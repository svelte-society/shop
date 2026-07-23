<script lang="ts">
	import { formatEur } from '$lib/domain/money';
	import type { CartDisplayPrice, PricingDestination } from '$lib/domain/pricing';

	type Props = {
		totalUnits: number;
		cartDisplayPrice: CartDisplayPrice;
		destination: PricingDestination;
		checkoutEnabled: boolean;
		checkoutPending?: boolean;
		checkoutError?: string | null;
		onCheckout?: () => void | Promise<void>;
	};

	let {
		totalUnits,
		cartDisplayPrice,
		destination,
		checkoutEnabled,
		checkoutPending = false,
		checkoutError = null,
		onCheckout = () => undefined
	}: Props = $props();
	let shippingMessage = $derived(
		totalUnits >= 2 ? 'Free shipping unlocked.' : 'Add one more item for free shipping.'
	);
	let destinationMessage = $derived(
		destination.region === 'eu'
			? `Estimated for delivery to ${destination.displayName}. Your delivery address confirms VAT and the final total at checkout.`
			: `Estimated for delivery to ${destination.displayName}. Checkout confirms the final total; import charges may apply.`
	);
</script>

<aside class="summary" aria-labelledby="cart-summary-title">
	<h2 id="cart-summary-title">Order summary</h2>

	<div class="price-rows">
		<div class="price-row">
			<span>Merchandise</span><strong>{formatEur(cartDisplayPrice.merchandise.grossCents)}</strong>
		</div>
		<div class="price-row">
			<span>Shipping</span><strong>{formatEur(cartDisplayPrice.shipping.grossCents)}</strong>
		</div>
		<div class="price-row">
			<span>{destination.region === 'eu' ? 'VAT' : 'EU VAT'}</span><strong
				>{formatEur(cartDisplayPrice.totalVatCents)}</strong
			>
		</div>
		<div class="price-row estimated-total">
			<span>Estimated total</span><strong>{formatEur(cartDisplayPrice.totalGrossCents)}</strong>
		</div>
	</div>

	<p class="shipping-message" aria-live="polite">{shippingMessage}</p>
	<p>{destinationMessage}</p>

	<button type="button" disabled={!checkoutEnabled || checkoutPending} onclick={onCheckout}>
		{checkoutPending
			? 'Opening secure checkout…'
			: checkoutEnabled
				? 'Continue to secure checkout'
				: 'Checkout opens soon'}
	</button>
	{#if checkoutError}
		<p class="checkout-error" role="alert">{checkoutError}</p>
	{/if}
</aside>

<style>
	.summary {
		position: sticky;
		top: 1.5rem;
		padding: clamp(1.25rem, 4vw, 2rem);
		border: 1px solid oklch(88% 0.03 35);
		border-radius: 1rem;
		background: var(--color-svelte-50, oklch(97.02% 0.0151 37.88));
		color: var(--color-ink, oklch(24% 0.025 255));
	}

	h2 {
		margin: 0 0 1.25rem;
		font-size: clamp(1.25rem, 3vw, 1.6rem);
	}

	.price-rows {
		display: grid;
		gap: 0.7rem;
		padding-block: 1rem;
		border-block: 1px solid oklch(86% 0.035 35);
	}

	.price-row {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	.estimated-total {
		padding-top: 0.7rem;
		border-top: 1px solid oklch(86% 0.035 35);
		font-size: 1.05rem;
	}

	.shipping-message {
		font-weight: 800;
		color: oklch(37% 0.105 145);
	}

	p {
		font-size: 0.9rem;
		line-height: 1.55;
	}

	button {
		width: 100%;
		min-height: 2.75rem;
		margin-top: 0.75rem;
		border: 0;
		border-radius: 0.65rem;
		padding: 0.75rem 1rem;
		background: var(--color-svelte-900, oklch(65.43% 0.2341 34.2));
		color: var(--color-ink, oklch(24% 0.025 255));
		font: inherit;
		font-weight: 800;
	}

	button:disabled {
		background: oklch(56% 0.02 255);
		cursor: not-allowed;
	}

	.checkout-error {
		margin-block: 0.75rem 0;
		color: oklch(45% 0.18 25);
		font-weight: 700;
	}

	@media (max-width: 52rem) {
		.summary {
			position: static;
		}
	}
</style>
