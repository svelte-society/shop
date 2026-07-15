<script lang="ts">
	import type { CatalogCategory, PublicCatalogVariant } from '$lib/domain/catalog';

	type Props = {
		category: CatalogCategory;
		variants: PublicCatalogVariant[];
		onSelectionChange: (priceId: string) => void;
	};

	let { category, variants, onSelectionChange }: Props = $props();
	let selectedPriceId = $state<string | null>(null);
	let announcement = $state('');
	let activeVariantIdentity = $state('');
	let variantIdentity = $derived(JSON.stringify([category, variants]));
	let selectionLabel = $derived(category === 'apparel' ? 'Choose a size' : 'Choose an option');

	$effect(() => {
		const identity = variantIdentity;
		if (identity === activeVariantIdentity) return;

		activeVariantIdentity = identity;
		selectedPriceId = null;
		announcement = category === 'apparel' ? 'Choose a size to continue.' : '';

		const onlyVariant = category === 'accessory' && variants.length === 1 ? variants[0] : null;
		if (onlyVariant) {
			selectedPriceId = onlyVariant.priceId;
			announcement = `${onlyVariant.label} selected.`;
			onSelectionChange(onlyVariant.priceId);
		}
	});

	function selectVariant(variant: PublicCatalogVariant): void {
		selectedPriceId = variant.priceId;
		announcement = `${variant.label} selected.`;
		onSelectionChange(variant.priceId);
	}
</script>

{#if category === 'apparel' || variants.length > 1}
	<fieldset role="radiogroup" aria-label={selectionLabel} aria-describedby="variant-status">
		<legend>{selectionLabel}</legend>
		<div class="options">
			{#each variants as variant (variant.priceId)}
				<label>
					<input
						type="radio"
						name="product-variant"
						value={variant.priceId}
						checked={selectedPriceId === variant.priceId}
						onchange={() => selectVariant(variant)}
					/>
					<span>{variant.label}</span>
				</label>
			{/each}
		</div>
	</fieldset>
{/if}

<p
	id="variant-status"
	class="selection-status"
	role="status"
	aria-label="Variant status"
	aria-live="polite"
>
	{announcement}
</p>

<style>
	fieldset {
		margin: 0;
		border: 0;
		padding: 0;
	}

	legend {
		margin-bottom: 0.75rem;
		font-weight: 800;
	}

	.options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	label {
		position: relative;
		display: inline-grid;
		min-width: 2.75rem;
		min-height: 2.75rem;
		place-items: center;
		cursor: pointer;
	}

	input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		clip-path: inset(50%);
		white-space: nowrap;
	}

	label span {
		display: grid;
		width: 100%;
		min-height: 2.75rem;
		place-items: center;
		border: 1px solid var(--color-control-border);
		border-radius: 0.55rem;
		padding-inline: 0.85rem;
		background: var(--color-white);
		font-weight: 750;
		transition:
			border-color 140ms ease,
			background 140ms ease,
			color 140ms ease;
	}

	input:checked + span {
		border-color: var(--color-ink);
		background: var(--color-ink);
		color: var(--color-white);
	}

	input:focus-visible + span {
		outline: 2px solid transparent;
		box-shadow: var(--focus-ring);
	}

	.selection-status {
		min-height: 1.5rem;
		margin: 0.65rem 0 0;
		color: var(--color-text-muted);
		font-size: 0.875rem;
	}
</style>
