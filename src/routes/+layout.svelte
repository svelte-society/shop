<script lang="ts">
	import '../app.css';
	import OpeningSoon from '$lib/components/OpeningSoon.svelte';
	import ShippingStrip from '$lib/components/ShippingStrip.svelte';
	import SiteFooter from '$lib/components/SiteFooter.svelte';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import Umami from '$lib/components/Umami.svelte';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();
</script>

<svelte:head><link rel="icon" href="/brand/svelte-society.svg" /></svelte:head>

{#if data.umami}
	<Umami
		scriptUrl={data.umami.scriptUrl}
		websiteId={data.umami.websiteId}
		connectOrigin={data.umami.connectOrigin}
	/>
{/if}

<a class="skip-link" href="#main-content" tabindex="0">Skip to content</a>
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
