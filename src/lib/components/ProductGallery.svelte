<script lang="ts">
	type Props = { name: string; images: string[] };

	let { name, images }: Props = $props();
	let selectedIndex = $state(0);
	let imageReady = $state(false);
	let selectedImage = $derived(images[selectedIndex]);

	function selectImage(index: number): void {
		selectedIndex = index;
		imageReady = false;
	}
</script>

<div class="gallery">
	<div class="main-frame" aria-busy={!imageReady}>
		<img
			src={selectedImage}
			alt={`${name}, image ${selectedIndex + 1} of ${images.length}`}
			onload={() => (imageReady = true)}
			onerror={() => (imageReady = true)}
		/>
		{#if !imageReady}<span role="status">Loading product image…</span>{/if}
	</div>

	{#if images.length > 1}
		<div class="thumbnails" aria-label={`${name} gallery`}>
			{#each images as image, index (image)}
				<button
					type="button"
					aria-label={`Show ${name} image ${index + 1}`}
					aria-pressed={selectedIndex === index}
					onclick={() => selectImage(index)}
				>
					<img src={image} alt="" />
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.gallery {
		display: grid;
		gap: 0.75rem;
	}

	.main-frame {
		position: relative;
		aspect-ratio: 4 / 5;
		overflow: hidden;
		border: 1px solid color-mix(in oklch, var(--color-svelte-300) 42%, var(--color-border));
		border-radius: 1rem;
		background:
			linear-gradient(
				145deg,
				transparent 64%,
				color-mix(in oklch, var(--color-svelte-100) 74%, transparent)
			),
			var(--color-svelte-50);
	}

	.main-frame > img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		transition: opacity 160ms ease;
	}

	.main-frame[aria-busy='true'] > img {
		opacity: 0;
	}

	.main-frame > span {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: var(--color-text-muted);
		font-size: 0.85rem;
		font-weight: 700;
	}

	.thumbnails {
		display: flex;
		gap: 0.65rem;
		overflow-x: auto;
		padding: 0.2rem;
	}

	button {
		width: 3.3rem;
		min-width: 3.3rem;
		height: 4.125rem;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: 0.55rem;
		padding: 0;
		background: var(--color-svelte-50);
		cursor: pointer;
	}

	button[aria-pressed='true'] {
		border-color: var(--color-ink);
		box-shadow: 0 0 0 1px var(--color-ink);
	}

	button img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
