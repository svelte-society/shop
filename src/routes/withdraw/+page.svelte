<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { tick, untrack } from 'svelte';

	type ItemRow = { description: string; quantity: string };
	type Fields = {
		fullName?: string;
		receiptEmail?: string;
		enteredOrderReference?: string;
		scope?: string;
		itemDescriptions?: string[];
		itemQuantities?: string[];
	};
	type WithdrawalResult = {
		reference: string;
		createdAt: string;
		enteredOrderReference: string;
		scope: 'entire_order' | 'specific_items';
		deliveryState: 'delivered' | 'queued' | 'failed';
	};
	type WithdrawalFormBase = {
		fields?: Fields;
		errors?: Record<string, string>;
		message?: string;
		errorSummary?: boolean;
		itemRowCount?: number;
		review?: {
			fullName: string;
			receiptEmail: string;
			enteredOrderReference: string;
			scope: 'entire_order' | 'specific_items';
			items: Array<{ description: string; quantity: number }>;
		};
	};
	type WithdrawalFormState = WithdrawalFormBase &
		({ success: true; result: WithdrawalResult } | { success?: false; result?: undefined });

	let {
		data,
		form
	}: {
		data: { csrfToken: string; itemRowCount: number };
		form: WithdrawalFormState | null | undefined;
	} = $props();
	const initial = untrack(() => {
		const fields = (form?.fields ?? {}) as Fields;
		const descriptions = fields.itemDescriptions ?? Array(data.itemRowCount).fill('');
		const quantities = fields.itemQuantities ?? Array(Math.max(1, descriptions.length)).fill('1');
		return {
			fields,
			descriptions,
			quantities,
			rowCount: Math.max(1, form?.itemRowCount ?? descriptions.length)
		};
	});
	const initialFields = initial.fields;
	let fullName = $state(initialFields.fullName ?? '');
	let receiptEmail = $state(initialFields.receiptEmail ?? '');
	let enteredOrderReference = $state(initialFields.enteredOrderReference ?? '');
	let scope = $state(initialFields.scope ?? 'entire_order');
	let rows = $state<ItemRow[]>(
		Array.from({ length: initial.rowCount }, (_, index) => ({
			description: initial.descriptions[index] ?? '',
			quantity: initial.quantities[index] ?? '1'
		}))
	);
	let editingReview = $state(false);
	let lastItemInput = $state<HTMLInputElement>();

	$effect(() => {
		const current = form;
		untrack(() => {
			const fields = (current?.fields ?? {}) as Fields;
			fullName = fields.fullName ?? '';
			receiptEmail = fields.receiptEmail ?? '';
			enteredOrderReference = fields.enteredOrderReference ?? '';
			scope = fields.scope ?? 'entire_order';
			const descriptions = fields.itemDescriptions ?? Array(data.itemRowCount).fill('');
			const quantities = fields.itemQuantities ?? Array(Math.max(1, descriptions.length)).fill('1');
			rows = Array.from(
				{ length: Math.max(1, current?.itemRowCount ?? descriptions.length) },
				(_, index) => ({
					description: descriptions[index] ?? '',
					quantity: quantities[index] ?? '1'
				})
			);
			editingReview = false;
			if (current?.errorSummary || current?.message || current?.success) {
				void tick().then(() =>
					document
						.querySelector<HTMLElement>(
							current.success ? '#withdrawal-success' : '#withdrawal-errors'
						)
						?.focus()
				);
			} else if ((current?.itemRowCount ?? 0) > data.itemRowCount) {
				void tick().then(() => lastItemInput?.focus());
			}
		});
	});

	async function addRow(event: MouseEvent) {
		if (rows.length >= 20) return;
		event.preventDefault();
		rows = [
			...rows.map((row, index) => ({
				description:
					(document.getElementById(`itemDescription-${index}`) as HTMLInputElement | null)?.value ??
					row.description,
				quantity:
					(document.getElementById(`itemQuantity-${index}`) as HTMLInputElement | null)?.value ??
					row.quantity
			})),
			{ description: '', quantity: '1' }
		];
		await tick();
		lastItemInput?.focus();
	}

	function removeRow(event: MouseEvent, index: number) {
		if (rows.length <= 1) return;
		event.preventDefault();
		rows = rows.filter((_, rowIndex) => rowIndex !== index);
		void tick().then(() =>
			setTimeout(
				() =>
					document.getElementById(`itemDescription-${Math.min(index, rows.length - 1)}`)?.focus(),
				0
			)
		);
	}

	function utcLabel(value: string): string {
		return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
	}
</script>

<svelte:head>
	<title>Submit a withdrawal notice — Svelte Society Shop</title>
	<meta
		name="description"
		content="Submit a withdrawal notice for a Svelte Society Shop purchase."
	/>
</svelte:head>

{#if form?.success}
	<main class="withdrawal-shell success-shell" id="withdrawal-success" tabindex="-1">
		<header class="page-header">
			<p class="eyebrow">Receipt</p>
			<h1>Withdrawal notice received.</h1>
			<p>Your notice is recorded. This receipt confirms submission only.</p>
		</header>
		<section class="receipt" aria-labelledby="receipt-heading">
			<h2 id="receipt-heading">Notice receipt</h2>
			<dl>
				<div>
					<dt>Withdrawal reference</dt>
					<dd>{form.result.reference}</dd>
				</div>
				<div>
					<dt>Received</dt>
					<dd><time datetime={form.result.createdAt}>{utcLabel(form.result.createdAt)}</time></dd>
				</div>
				<div>
					<dt>Order reference entered</dt>
					<dd>{form.result.enteredOrderReference}</dd>
				</div>
				<div>
					<dt>Scope</dt>
					<dd>{form.result.scope === 'entire_order' ? 'The whole purchase' : 'Specific items'}</dd>
				</div>
			</dl>
			{#if form.result.deliveryState === 'delivered'}
				<p>A receipt was emailed to the address you entered.</p>
			{:else if form.result.deliveryState === 'queued'}
				<p>Your receipt email is queued. You can download it now.</p>
			{:else}
				<p>
					Email could not be sent. Your withdrawal notice is safely recorded. Download the receipt
					now.
				</p>
			{/if}
			<a
				class="primary-action"
				href={resolve('/withdraw/receipt/[reference]', { reference: form.result.reference })}
				>Download withdrawal receipt</a
			>
		</section>
	</main>
{:else}
	<main class="withdrawal-shell">
		<header class="page-header">
			<p class="eyebrow">Returns and withdrawal</p>
			<h1>Submit a withdrawal notice</h1>
			<p>
				Tell us clearly which purchase you want to withdraw from. We will record the notice and give
				you a receipt.
			</p>
		</header>

		<ol class="steps" aria-label="Withdrawal notice progress">
			<li aria-current={!form?.review || editingReview ? 'step' : undefined}>Notice details</li>
			<li aria-current={form?.review && !editingReview ? 'step' : undefined}>Review and confirm</li>
		</ol>

		{#if form?.errorSummary || form?.message}
			<section
				class="error-summary"
				id="withdrawal-errors"
				role="alert"
				tabindex="-1"
				aria-labelledby="error-title"
			>
				<h2 id="error-title">
					{form.message ? 'We could not submit the notice' : 'Check the notice details'}
				</h2>
				{#if form.message}
					<p>{form.message}</p>
				{:else}
					<ul>
						{#each Object.entries(form.errors ?? {}) as [key, message] (key)}
							<li>
								<a href={key === 'items' || key === 'form' ? '#withdrawal-form' : `#${key}`}
									>{message}</a
								>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		<form id="withdrawal-form" method="POST" action="?/review" use:enhance>
			<input type="hidden" name="csrfToken" value={data.csrfToken} />
			{#if form?.review && !editingReview}
				<section class="review" aria-labelledby="review-heading">
					<p class="eyebrow">Notice details complete</p>
					<h2 id="review-heading">Review and confirm</h2>
					<dl>
						<div>
							<dt>Full name</dt>
							<dd>{form.review.fullName}</dd>
						</div>
						<div>
							<dt>Receipt email</dt>
							<dd>{form.review.receiptEmail}</dd>
						</div>
						<div>
							<dt>Order reference</dt>
							<dd>{form.review.enteredOrderReference}</dd>
						</div>
						<div>
							<dt>Scope</dt>
							<dd>
								{form.review.scope === 'entire_order' ? 'The whole purchase' : 'Specific items'}
							</dd>
						</div>
						{#if form.review.scope === 'specific_items'}
							<div>
								<dt>Items</dt>
								<dd>
									{#each form.review.items as item, index (`${index}:${item.description}`)}<span
											>{item.quantity} × {item.description}</span
										>{/each}
								</dd>
							</div>
						{/if}
					</dl>
					<input type="hidden" name="fullName" value={fullName} />
					<input type="hidden" name="receiptEmail" value={receiptEmail} />
					<input type="hidden" name="enteredOrderReference" value={enteredOrderReference} />
					<input type="hidden" name="scope" value={scope} />
					{#each rows as row, index (index)}<input
							type="hidden"
							name="itemDescription"
							value={row.description}
						/><input type="hidden" name="itemQuantity" value={row.quantity} />{/each}
					<p class="confirmation">
						Submitting this notice does not confirm eligibility, approval, or a refund.
					</p>
					<div class="actions confirm-actions">
						<button class="secondary-action" type="button" onclick={() => (editingReview = true)}
							>Back to notice details</button
						>
						<button class="primary-action" type="submit" formaction="?/confirm"
							>Confirm withdrawal from purchase</button
						>
					</div>
				</section>
			{:else}
				<fieldset>
					<legend>Your details</legend>
					<div class="field">
						<label for="fullName">Full name</label><input
							id="fullName"
							name="fullName"
							autocomplete="name"
							bind:value={fullName}
							aria-describedby={form?.errors?.fullName ? 'fullName-error' : undefined}
						/>{#if form?.errors?.fullName}<p class="field-error" id="fullName-error">
								{form.errors.fullName}
							</p>{/if}
					</div>
					<div class="field">
						<label for="receiptEmail">Receipt email</label>
						<p class="hint" id="receiptEmail-hint">We send the withdrawal receipt here.</p>
						<input
							id="receiptEmail"
							name="receiptEmail"
							type="email"
							autocomplete="email"
							bind:value={receiptEmail}
							aria-describedby={form?.errors?.receiptEmail
								? 'receiptEmail-error'
								: 'receiptEmail-hint'}
						/>{#if form?.errors?.receiptEmail}<p class="field-error" id="receiptEmail-error">
								{form.errors.receiptEmail}
							</p>{/if}
					</div>
				</fieldset>
				<fieldset>
					<legend>Purchase</legend>
					<div class="field">
						<label for="enteredOrderReference">Order reference</label>
						<p class="hint" id="order-hint">For example, the reference in your order email.</p>
						<input
							id="enteredOrderReference"
							name="enteredOrderReference"
							bind:value={enteredOrderReference}
							aria-describedby={form?.errors?.enteredOrderReference
								? 'enteredOrderReference-error'
								: 'order-hint'}
						/>{#if form?.errors?.enteredOrderReference}<p
								class="field-error"
								id="enteredOrderReference-error"
							>
								{form.errors.enteredOrderReference}
							</p>{/if}
					</div>
				</fieldset>
				<fieldset>
					<legend>Withdrawal scope</legend>
					<div class="radio-row" id="scope">
						<label
							><input type="radio" name="scope" value="entire_order" bind:group={scope} /> The whole purchase</label
						><label
							><input type="radio" name="scope" value="specific_items" bind:group={scope} /> Specific
							items</label
						>
					</div>
					{#if form?.errors?.scope}<p class="field-error" id="scope-error">
							{form.errors.scope}
						</p>{/if}
					<div class="items">
						{#each rows as row, index (index)}
							<div class="item-row">
								<div class="field item-description">
									<label for={`itemDescription-${index}`}>Item description {index + 1}</label><input
										id={`itemDescription-${index}`}
										name="itemDescription"
										bind:value={row.description}
										bind:this={lastItemInput}
									/>{#if form?.errors?.[`itemDescription-${index}`]}<p class="field-error">
											{form.errors[`itemDescription-${index}`]}
										</p>{/if}
								</div>
								<div class="field quantity">
									<label for={`itemQuantity-${index}`}>Quantity {index + 1}</label><input
										id={`itemQuantity-${index}`}
										name="itemQuantity"
										type="number"
										min="1"
										max="99"
										inputmode="numeric"
										bind:value={row.quantity}
									/>{#if form?.errors?.[`itemQuantity-${index}`]}<p class="field-error">
											{form.errors[`itemQuantity-${index}`]}
										</p>{/if}
								</div>
								{#if rows.length > 1}<button
										class="remove-action"
										type="submit"
										name="removeIndex"
										value={index}
										formaction="?/removeItem"
										onclick={(event) => removeRow(event, index)}>Remove item {index + 1}</button
									>{/if}
							</div>
						{/each}
						<button
							class="secondary-action"
							type="submit"
							formaction="?/addItem"
							onclick={addRow}
							disabled={rows.length >= 20}>Add another item</button
						>
					</div>
				</fieldset>
				<div class="actions">
					<button class="primary-action" type="submit">Review withdrawal notice</button>
				</div>
			{/if}
		</form>
	</main>
{/if}

<style>
	.withdrawal-shell {
		width: min(58rem, calc(100% - 2rem));
		margin-inline: auto;
		padding-block: clamp(3rem, 8vw, 7rem);
		color: var(--color-ink);
	}
	.page-header {
		max-width: 48rem;
		padding-bottom: clamp(2rem, 5vw, 3.5rem);
		border-bottom: 1px solid var(--color-border);
	}
	.eyebrow {
		margin: 0 0 0.8rem;
		color: var(--color-svelte-text);
		font-size: 0.75rem;
		font-weight: 800;
		letter-spacing: 0.11em;
		text-transform: uppercase;
	}
	h1 {
		max-width: 48rem;
		margin: 0 0 1rem;
		font-size: clamp(2.65rem, 7vw, 5rem);
		line-height: 0.96;
		letter-spacing: -0.05em;
	}
	.page-header > p:last-child {
		max-width: 42rem;
		margin: 0;
		color: var(--color-slate-700);
		font-size: 1.05rem;
		line-height: 1.65;
	}
	.steps {
		display: flex;
		gap: 0.75rem 2rem;
		margin: 2rem 0 3rem;
		padding: 0;
		list-style-position: inside;
		color: var(--color-text-muted);
		font-weight: 750;
	}
	.steps [aria-current='step'] {
		color: var(--color-svelte-text);
	}
	form {
		display: grid;
		gap: 2.75rem;
	}
	fieldset {
		display: grid;
		gap: 1.25rem;
		margin: 0;
		padding: 0 0 2.75rem;
		border: 0;
		border-bottom: 1px solid var(--color-border);
	}
	legend,
	h2 {
		margin-bottom: 1.25rem;
		padding: 0;
		font-size: clamp(1.35rem, 3vw, 1.75rem);
		font-weight: 800;
	}
	.field {
		display: grid;
		gap: 0.45rem;
	}
	label {
		font-weight: 750;
	}
	.hint {
		margin: -0.1rem 0 0.1rem;
		color: var(--color-text-muted);
		font-size: 0.9rem;
	}
	input:not([type='radio']):not([type='hidden']) {
		min-height: 3rem;
		width: 100%;
		border: 1px solid var(--color-border-strong);
		border-radius: 0.45rem;
		background: var(--color-white);
		padding: 0.65rem 0.8rem;
		color: var(--color-ink);
		font: inherit;
	}
	input:focus-visible,
	button:focus-visible,
	a:focus-visible {
		outline: 3px solid var(--color-svelte-500);
		outline-offset: 3px;
	}
	.radio-row {
		display: grid;
		gap: 0.5rem;
	}
	.radio-row label {
		display: flex;
		min-height: 2.75rem;
		align-items: center;
		gap: 0.7rem;
	}
	.radio-row input {
		width: 1.25rem;
		height: 1.25rem;
		accent-color: var(--color-svelte-500);
	}
	.items {
		display: grid;
		gap: 1.5rem;
		margin-top: 1rem;
	}
	fieldset:not(:has(input[value='specific_items']:checked)) .items {
		display: none;
	}
	.item-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 7rem;
		gap: 0.75rem 1rem;
		padding-bottom: 1.5rem;
		border-bottom: 1px dashed var(--color-border);
	}
	.remove-action {
		grid-column: 1 / -1;
		justify-self: start;
	}
	button,
	.primary-action {
		min-height: 2.75rem;
		border-radius: 0.45rem;
		padding: 0.7rem 1rem;
		font: inherit;
		font-weight: 800;
		cursor: pointer;
	}
	.primary-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--color-svelte-500);
		background: var(--color-svelte-500);
		color: var(--color-white);
		text-decoration: none;
	}
	.secondary-action,
	.remove-action {
		border: 1px solid var(--color-border-strong);
		background: transparent;
		color: var(--color-ink);
	}
	.remove-action {
		color: var(--color-svelte-text);
	}
	button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
	}
	.confirm-actions {
		justify-content: space-between;
		gap: 1rem;
	}
	.field-error {
		margin: 0;
		color: #a32910;
		font-size: 0.9rem;
		font-weight: 700;
	}
	.error-summary {
		margin: 2rem 0;
		border-left: 0.3rem solid var(--color-svelte-500);
		background: var(--color-white);
		padding: 1.25rem 1.5rem;
	}
	.error-summary h2 {
		margin: 0 0 0.75rem;
		font-size: 1.2rem;
	}
	.error-summary ul {
		margin: 0;
		padding-left: 1.2rem;
	}
	.error-summary p {
		margin: 0;
	}
	.error-summary a {
		color: var(--color-svelte-text);
		font-weight: 750;
	}
	.review,
	.receipt {
		margin-top: 2.5rem;
		border-top: 0.35rem solid var(--color-svelte-500);
		background: var(--color-white);
		padding: clamp(1.25rem, 4vw, 2.5rem);
		box-shadow: 0 0.8rem 2.5rem color-mix(in oklch, var(--color-ink) 8%, transparent);
	}
	dl {
		display: grid;
		gap: 1rem;
		margin: 0 0 2rem;
	}
	dl div {
		display: grid;
		grid-template-columns: minmax(9rem, 0.45fr) 1fr;
		gap: 0.5rem 1rem;
		padding-bottom: 0.8rem;
		border-bottom: 1px solid var(--color-border);
	}
	dt {
		color: var(--color-text-muted);
		font-size: 0.85rem;
		font-weight: 750;
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
		font-weight: 700;
	}
	dd span {
		display: block;
	}
	.confirmation {
		margin: 2rem 0;
		color: var(--color-slate-700);
		line-height: 1.6;
	}
	.receipt > p {
		line-height: 1.6;
	}
	@media (max-width: 36rem) {
		.steps {
			justify-content: space-between;
			gap: 0.75rem;
			font-size: 0.9rem;
		}
		.item-row,
		dl div {
			grid-template-columns: 1fr;
		}
		.quantity {
			width: 8rem;
		}
		.actions,
		.confirm-actions {
			flex-direction: column-reverse;
			align-items: stretch;
		}
		.primary-action {
			width: 100%;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		*,
		*::before,
		*::after {
			scroll-behavior: auto !important;
			transition-duration: 0.01ms !important;
			animation-duration: 0.01ms !important;
		}
	}
</style>
