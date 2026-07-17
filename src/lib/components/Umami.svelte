<script lang="ts">
	type Props = {
		scriptUrl: string;
		websiteId: string;
		connectOrigin: string | null;
	};

	let { scriptUrl, websiteId, connectOrigin }: Props = $props();
</script>

<svelte:head>
	<script
		defer
		src={scriptUrl}
		data-website-id={websiteId}
		data-host-url={connectOrigin ?? undefined}
		data-auto-track="false"
		data-do-not-track="true"
		data-exclude-search="true"
	></script>
</svelte:head>
