<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import OpeningSoon from '$lib/components/OpeningSoon.svelte';
	import ShippingStrip from '$lib/components/ShippingStrip.svelte';
	import SiteFooter from '$lib/components/SiteFooter.svelte';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<a class="skip-link" href="#main-content">Skip to content</a>
<ShippingStrip />
<SiteHeader />

{#if data.showOpeningSoon}
	<OpeningSoon />
{:else}
	<div id="main-content" tabindex="-1">
		{@render children()}
	</div>
{/if}

<SiteFooter />
