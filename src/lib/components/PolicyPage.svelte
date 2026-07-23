<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PolicyDocument } from '$lib/content/policies';

	let { document }: { document: PolicyDocument } = $props();
	let lastUpdated = $derived(document.effectiveDate ? formatDate(document.effectiveDate) : null);

	const informationPages = [
		{ label: 'Shipping', href: '/shipping' },
		{ label: 'Returns', href: '/returns' },
		{ label: 'Withdrawal form', href: '/withdraw' },
		{ label: 'Privacy', href: '/privacy' },
		{ label: 'Terms', href: '/terms' },
		{ label: 'About', href: '/about' }
	] as const;

	function formatDate(value: string): string {
		const [year, month, day] = value.split('-').map(Number);
		return new Intl.DateTimeFormat('en-GB', {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(new Date(Date.UTC(year, month - 1, day)));
	}
</script>

<svelte:head>
	<title>{document.title} — Svelte Society Shop</title>
	<meta name="description" content={document.summary} />
</svelte:head>

<main class="policy-shell">
	<nav aria-label="Information pages">
		<p>Shop information</p>
		<ul>
			{#each informationPages as page (page.href)}
				<li><a href={resolve(page.href as '/')}>{page.label}</a></li>
			{/each}
		</ul>
	</nav>

	<article aria-labelledby="policy-title">
		<header>
			<p class="eyebrow">Svelte Society Shop</p>
			<h1 id="policy-title">{document.title}</h1>
			<p class="summary">{document.summary}</p>
			{#if lastUpdated}
				<p class="effective-date">
					<time datetime={document.effectiveDate}>Last updated {lastUpdated}</time>
				</p>
			{/if}
		</header>

		<div class="policy-sections">
			{#each document.sections as section, index (section.heading)}
				<section aria-labelledby={`policy-section-${index}`}>
					<h2 id={`policy-section-${index}`}>{section.heading}</h2>
					{#each section.paragraphs as paragraph (paragraph)}
						<p>{paragraph}</p>
					{/each}
					{#if section.links?.length}
						<ul class="section-links">
							{#each section.links as link (link.href)}
								<li>
									{#if link.href.startsWith('/')}
										<a href={resolve(link.href as '/')}>{link.label}</a>
									{:else}
										<a href={link.href} rel="external">{link.label}</a>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/each}
		</div>
	</article>
</main>

<style>
	.policy-shell {
		display: grid;
		width: min(76rem, calc(100% - 2rem));
		grid-template-columns: minmax(10rem, 13rem) minmax(0, 48rem);
		gap: clamp(2.5rem, 8vw, 8rem);
		align-items: start;
		margin-inline: auto;
		padding-block: clamp(3rem, 8vw, 7rem);
	}

	nav {
		padding-top: 0.4rem;
	}

	nav p,
	.eyebrow {
		margin: 0 0 0.75rem;
		color: var(--color-svelte-text);
		font-size: 0.75rem;
		font-weight: 800;
		letter-spacing: 0.11em;
		text-transform: uppercase;
	}

	nav ul,
	.section-links {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	nav ul {
		display: grid;
		gap: 0.2rem;
	}

	nav a {
		display: flex;
		min-height: 2.75rem;
		align-items: center;
		border-radius: 0.45rem;
		font-weight: 750;
		text-underline-offset: 0.22rem;
	}

	article {
		min-width: 0;
	}

	article > header {
		padding-bottom: clamp(2.25rem, 6vw, 4rem);
		border-bottom: 1px solid var(--color-border);
	}

	h1,
	h2,
	p {
		margin-top: 0;
	}

	h1 {
		max-width: 44rem;
		margin-bottom: 1rem;
		font-size: clamp(2.8rem, 7vw, 5.4rem);
		font-weight: 800;
		line-height: 0.94;
		letter-spacing: -0.055em;
	}

	.summary {
		max-width: 40rem;
		margin-bottom: 1rem;
		color: var(--color-slate-700);
		font-size: clamp(1rem, 2vw, 1.2rem);
		line-height: 1.65;
	}

	.effective-date {
		margin-bottom: 0;
		color: var(--color-text-muted);
		font-size: 0.9rem;
		font-weight: 700;
	}

	.policy-sections {
		display: grid;
		gap: clamp(2.5rem, 6vw, 4.5rem);
		padding-top: clamp(2.5rem, 6vw, 4.5rem);
	}

	section h2 {
		margin-bottom: 1rem;
		font-size: clamp(1.35rem, 3vw, 1.8rem);
		line-height: 1.15;
		letter-spacing: -0.025em;
	}

	section p {
		max-width: 44rem;
		margin-bottom: 0.9rem;
		color: var(--color-slate-700);
		line-height: 1.75;
	}

	section p:last-of-type {
		margin-bottom: 0;
	}

	.section-links {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1.25rem;
		margin-top: 1rem;
	}

	.section-links a {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		border-radius: 0.4rem;
		color: var(--color-svelte-text);
		font-weight: 800;
		text-underline-offset: 0.24rem;
	}

	@media (max-width: 44rem) {
		.policy-shell {
			grid-template-columns: 1fr;
			gap: 2.5rem;
		}

		nav {
			padding-bottom: 1.5rem;
			border-bottom: 1px solid var(--color-border);
		}

		nav ul {
			display: flex;
			flex-wrap: wrap;
			gap: 0.1rem 1rem;
		}
	}
</style>
