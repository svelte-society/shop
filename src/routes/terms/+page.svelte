<script lang="ts">
	import PolicyPage from '$lib/components/PolicyPage.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PolicyPage document={data.policyDocument!} />
