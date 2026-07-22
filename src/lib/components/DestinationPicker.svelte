<script lang="ts">
	import { recoverPricingDestination } from '$lib/client/pricing-destination-navigation';
	import type { DestinationOption, PricingDestination } from '$lib/domain/pricing';

	type Props = {
		destination: PricingDestination;
		destinations: readonly DestinationOption[];
		returnTo: string;
	};

	let { destination, destinations, returnTo }: Props = $props();
	let dialog = $state<HTMLDialogElement | null>(null);
	let trigger = $state<HTMLButtonElement | null>(null);
	let query = $state('');
	let pending = $state(false);
	let announcement = $state('');
	let error = $state('');
	let hydrated = $derived(false);
	let filtered = $derived(
		destinations.filter((option) =>
			option.displayName.toLowerCase().includes(query.trim().toLowerCase())
		)
	);
	let europeanDestinations = $derived(destinations.filter((option) => option.region === 'eu'));
	let asianDestinations = $derived(destinations.filter((option) => option.region === 'asia'));
	let filteredEuropeanDestinations = $derived(filtered.filter((option) => option.region === 'eu'));
	let filteredAsianDestinations = $derived(filtered.filter((option) => option.region === 'asia'));

	$effect(() => {
		hydrated = true;
	});

	function matchesQuery(option: DestinationOption): boolean {
		return filtered.includes(option);
	}

	function open(): void {
		announcement = '';
		error = '';
		dialog?.showModal();
	}

	function close(): void {
		query = '';
		error = '';
		trigger?.focus();
	}

	async function submit(event: SubmitEvent): Promise<void> {
		if (!(event.currentTarget instanceof HTMLFormElement) || !globalThis.fetch) return;
		event.preventDefault();
		const form = event.currentTarget;
		const selectedCode = String(new FormData(form).get('country') ?? '');
		const selected = destinations.find((option) => option.countryCode === selectedCode);
		if (!selected) return;

		pending = true;
		error = '';
		try {
			const response = await fetch(form.action, {
				method: 'POST',
				body: new FormData(form),
				redirect: 'follow'
			});
			if (!response.ok) {
				error = 'We couldn’t update your delivery country. Please try again.';
				return;
			}
			if (!(await recoverPricingDestination(returnTo))) return;
			dialog?.close();
			announcement = `Prices updated for ${selected.displayName}.`;
		} catch {
			error = 'We couldn’t update your delivery country. Please try again.';
		} finally {
			pending = false;
		}
	}
</script>

<div class="destination-picker">
	{#if !hydrated}
		<form class="no-script-destination" method="POST" action="/preferences/destination">
			<label>
				<span>Delivery country</span>
				<select name="country">
					{#each destinations as option (option.countryCode)}
						<option
							value={option.countryCode}
							selected={option.countryCode === destination.countryCode}
						>
							{option.displayName}
						</option>
					{/each}
				</select>
			</label>
			<input type="hidden" name="returnTo" value={returnTo} />
			<button type="submit">Update country</button>
		</form>
	{:else}
		<button
			bind:this={trigger}
			class="destination-trigger"
			type="button"
			aria-label={`Choose delivery country, currently ${destination.displayName}`}
			onclick={open}
		>
			<span class="trigger-label">Deliver to:</span>
			<span>{destination.displayName}</span>
			<span aria-hidden="true">⌄</span>
		</button>

		<dialog bind:this={dialog} aria-labelledby="destination-title" onclose={close}>
			<form method="POST" action="/preferences/destination" onsubmit={submit} aria-busy={pending}>
				<header class="dialog-heading">
					<p class="eyebrow">Pricing destination</p>
					<h2 id="destination-title">Choose delivery country</h2>
					<p>We’ll show your local tax treatment before checkout.</p>
				</header>

				<label class="search-field">
					<span>Search delivery countries</span>
					<input type="search" bind:value={query} placeholder="Search countries" />
				</label>

				<div class="destination-groups">
					<fieldset>
						<legend>EU countries</legend>
						{#each europeanDestinations as option (option.countryCode)}
							<label class:filtered-out={!matchesQuery(option)} class="destination-option">
								<input
									type="radio"
									name="country"
									value={option.countryCode}
									checked={option.countryCode === destination.countryCode}
									required
								/>
								<span>{option.displayName}</span>
							</label>
						{/each}
						{#if !filteredEuropeanDestinations.length}
							<p class="empty-result">No EU countries match your search.</p>
						{/if}
					</fieldset>

					<fieldset>
						<legend>Asia countries</legend>
						{#each asianDestinations as option (option.countryCode)}
							<label class:filtered-out={!matchesQuery(option)} class="destination-option">
								<input
									type="radio"
									name="country"
									value={option.countryCode}
									checked={option.countryCode === destination.countryCode}
									required
								/>
								<span>{option.displayName}</span>
							</label>
						{/each}
						{#if !filteredAsianDestinations.length}
							<p class="empty-result">No Asian countries match your search.</p>
						{/if}
					</fieldset>
				</div>

				<input type="hidden" name="returnTo" value={returnTo} aria-label="Return to" />

				<div class="dialog-footer">
					{#if error}
						<p class="form-error" role="alert">{error}</p>
					{/if}

					<footer class="dialog-actions">
						<button type="button" class="cancel" onclick={() => dialog?.close()} disabled={pending}>
							Cancel
						</button>
						<button type="submit" class="update" disabled={pending}>
							{pending ? 'Updating…' : 'Update country'}
						</button>
					</footer>
				</div>
			</form>
		</dialog>
	{/if}
</div>

<p class="visually-hidden" role="status" aria-atomic="true">{announcement}</p>

<style>
	.destination-picker {
		display: contents;
	}

	.destination-trigger,
	.destination-option,
	.dialog-actions button,
	.no-script-destination button,
	.no-script-destination select {
		min-height: 2.75rem;
	}

	.destination-trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px solid transparent;
		border-radius: 0.5rem;
		padding: 0.6rem clamp(0.55rem, 1.3vw, 0.85rem);
		background: transparent;
		color: var(--color-ink);
		font-size: 0.88rem;
		font-weight: 750;
		letter-spacing: inherit;
		text-align: left;
		text-decoration: none;
		text-underline-offset: 0.25rem;
		cursor: pointer;
	}

	.destination-trigger:hover {
		text-decoration: underline;
	}

	.trigger-label {
		color: var(--color-text-muted);
	}

	dialog {
		position: fixed;
		inset: 7.75rem 1rem auto;
		width: min(32rem, calc(100% - 2rem));
		height: min(42rem, calc(100dvh - 8.75rem));
		max-width: 32rem;
		max-height: calc(100dvh - 8.75rem);
		margin: 0 auto;
		overflow: hidden;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 0.9rem;
		background: var(--color-paper);
		color: var(--color-ink);
		box-shadow: 0 1.5rem 3.5rem color-mix(in oklch, var(--color-ink) 28%, transparent);
	}

	dialog::backdrop {
		background: color-mix(in oklch, var(--color-ink) 48%, transparent);
	}

	form {
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr) auto;
		height: 100%;
		overflow: hidden;
	}

	.dialog-heading {
		padding: 1.35rem 1.35rem 0;
	}

	.dialog-heading p,
	.dialog-heading h2,
	fieldset,
	.empty-result {
		margin: 0;
	}

	.eyebrow {
		color: var(--color-svelte-text);
		font-size: 0.72rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	h2 {
		margin-block: 0.25rem;
		font-size: clamp(1.3rem, 4vw, 1.65rem);
		line-height: 1.15;
	}

	.dialog-heading p:not(.eyebrow),
	.empty-result {
		color: var(--color-text-muted);
		font-size: 0.88rem;
	}

	.search-field {
		display: grid;
		gap: 0.35rem;
		padding: 1rem 1.35rem 0;
		font-size: 0.82rem;
		font-weight: 750;
	}

	.search-field input {
		min-height: 2.75rem;
		border: 2px solid var(--color-control-border);
		border-radius: 0.5rem;
		padding: 0.55rem 0.7rem;
		background: var(--color-white);
		color: var(--color-ink);
	}

	.destination-groups {
		display: grid;
		min-height: 0;
		align-content: start;
		gap: 1rem;
		margin-top: 1rem;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0 1.35rem 1rem;
		scrollbar-gutter: stable;
	}

	fieldset {
		display: grid;
		gap: 0.35rem;
		min-inline-size: 0;
		padding: 0;
		border: 0;
	}

	legend {
		padding: 0;
		font-size: 0.82rem;
		font-weight: 800;
		letter-spacing: 0.04em;
	}

	.destination-option {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		padding: 0.45rem 0.7rem;
		background: var(--color-white);
		font-size: 0.92rem;
		font-weight: 700;
		cursor: pointer;
	}

	.destination-option:has(input:checked) {
		border-color: var(--color-ink);
		background: var(--color-svelte-50);
	}

	.destination-option.filtered-out {
		display: none;
	}

	.form-error {
		margin: 0 0 0.75rem;
		border-left: 0.25rem solid var(--color-svelte-text);
		padding: 0.55rem 0.7rem;
		background: var(--color-svelte-50);
		color: var(--color-ink);
		font-size: 0.88rem;
		font-weight: 750;
	}

	.no-script-destination {
		display: flex;
		align-items: end;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.45rem 1rem;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-svelte-50);
	}

	.no-script-destination label {
		display: grid;
		gap: 0.15rem;
		font-size: 0.74rem;
		font-weight: 800;
	}

	.no-script-destination select,
	.no-script-destination button {
		border: 1px solid var(--color-control-border);
		border-radius: 0.4rem;
		padding: 0.35rem 0.55rem;
		background: var(--color-paper);
		color: var(--color-ink);
		font-size: 0.82rem;
		font-weight: 750;
	}

	.destination-option input {
		width: 1.15rem;
		height: 1.15rem;
		accent-color: var(--color-svelte-text);
	}

	.dialog-actions {
		display: grid;
		grid-template-columns: 1fr 1.4fr;
		gap: 0.65rem;
	}

	.dialog-footer {
		border-top: 1px solid var(--color-border);
		padding: 0.9rem 1.35rem 1.35rem;
		background: var(--color-paper);
		box-shadow: 0 -0.75rem 1.5rem color-mix(in oklch, var(--color-ink) 5%, transparent);
	}

	.dialog-actions button {
		border: 2px solid var(--color-ink);
		border-radius: 0.5rem;
		padding: 0.55rem 0.75rem;
		font-size: 0.88rem;
		font-weight: 800;
		cursor: pointer;
	}

	.cancel {
		background: var(--color-paper);
		color: var(--color-ink);
	}

	.update {
		background: var(--color-ink);
		color: var(--color-white);
	}

	.dialog-actions button:disabled {
		cursor: wait;
		opacity: 0.62;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	@media (max-width: 44rem) {
		dialog {
			inset: auto 0 0;
			width: 100%;
			height: min(88dvh, 44rem);
			max-width: none;
			max-height: calc(100dvh - 0.5rem);
			border-bottom: 0;
			border-radius: 0.9rem 0.9rem 0 0;
		}

		.dialog-heading {
			padding: 1.15rem max(1rem, env(safe-area-inset-right)) 0 max(1rem, env(safe-area-inset-left));
		}

		.search-field {
			padding: 0.9rem max(1rem, env(safe-area-inset-right)) 0 max(1rem, env(safe-area-inset-left));
		}

		.destination-groups {
			padding-right: max(1rem, env(safe-area-inset-right));
			padding-bottom: 0.9rem;
			padding-left: max(1rem, env(safe-area-inset-left));
		}

		.dialog-footer {
			padding: 0.8rem max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom))
				max(1rem, env(safe-area-inset-left));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		*,
		*::before,
		*::after {
			transition: none !important;
			animation: none !important;
		}
	}
</style>
