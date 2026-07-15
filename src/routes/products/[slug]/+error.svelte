<script lang="ts">
	import { page } from '$app/state';
	import ProductErrorContent from '$lib/components/ProductErrorContent.svelte';
</script>

<svelte:head>
	<title
		>{page.status === 404
			? 'Product not found — Svelte Society Shop'
			: 'Shop error — Svelte Society Shop'}</title
	>
</svelte:head>

<ProductErrorContent status={page.status} />
