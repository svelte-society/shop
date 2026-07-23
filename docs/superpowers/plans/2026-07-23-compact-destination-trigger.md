# Compact Destination Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the verbose header destination label with a compact country flag control and remove the redundant homepage Tax card.

**Architecture:** Keep the existing `DestinationPicker` dialog, form submission, persistence, and pricing contracts intact. Derive one presentational flag string from the existing ISO country code inside the component, then remove only the homepage article that imports and renders `pricingDisclosure`.

**Tech Stack:** Svelte 5, SvelteKit, TypeScript, Vitest Browser Mode, Playwright, pnpm.

## Global Constraints

- Use Node.js and pnpm; do not use Bun, npm, or smerch.
- Add no dependency, external flag service, image asset set, or backend endpoint.
- Preserve the accessible name “Choose delivery country, currently {country}”.
- Keep the trigger at least 44px square.
- Do not change VAT calculations, displayed prices, cart tax amounts, Stripe checkout, policy copy, or the destination dialog.

---

### Task 1: Compact Flag Destination Trigger

**Files:**
- Modify: `src/lib/components/DestinationPicker.svelte`
- Test: `src/lib/components/DestinationPicker.svelte.test.ts`

**Interfaces:**
- Consumes: `destination.countryCode` and `destination.displayName` from the existing `PricingDestination` prop.
- Produces: the unchanged destination button/dialog contract with a flag-and-chevron visual trigger.

- [ ] **Step 1: Write the failing component test**

Change the opening test to require the flag, tooltip, accessible name, and removal of the visible verbose label:

```ts
const trigger = page.getByRole('button', {
	name: 'Choose delivery country, currently Sweden'
});
await expect.element(trigger).toHaveAttribute('title', 'Deliver to Sweden');
await expect.element(trigger).toHaveTextContent('🇸🇪⌄');
await expect.element(trigger).not.toHaveTextContent('Deliver to: Sweden');
```

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
pnpm exec vitest run --project client src/lib/components/DestinationPicker.svelte.test.ts
```

Expected: FAIL because the current trigger has no tooltip and still renders “Deliver to: Sweden”.

- [ ] **Step 3: Implement the ISO flag derivation and compact trigger**

Add a local, deterministic helper and derived value:

```ts
function countryFlag(countryCode: string): string {
	return [...countryCode.toUpperCase()]
		.map((character) => String.fromCodePoint(127397 + character.charCodeAt(0)))
		.join('');
}

let destinationFlag = $derived(countryFlag(destination.countryCode));
```

Render the existing button with its accessible name intact:

```svelte
<button
	bind:this={trigger}
	class="destination-trigger"
	type="button"
	aria-label={`Choose delivery country, currently ${destination.displayName}`}
	title={`Deliver to ${destination.displayName}`}
	onclick={open}
>
	<span class="destination-flag" aria-hidden="true">{destinationFlag}</span>
	<span class="destination-chevron" aria-hidden="true">⌄</span>
</button>
```

Make the control compact without shrinking the hit target:

```css
.destination-trigger {
	width: 2.75rem;
	justify-content: center;
	gap: 0.1rem;
	padding: 0.35rem;
}

.destination-flag {
	font-size: 1.25rem;
	line-height: 1;
}

.destination-chevron {
	font-size: 0.72rem;
	line-height: 1;
}

.destination-trigger:hover {
	border-color: var(--color-border);
	background: var(--color-svelte-50);
}
```

Remove the obsolete `.trigger-label` styling.

- [ ] **Step 4: Run the component test and verify green**

Run:

```bash
pnpm exec vitest run --project client src/lib/components/DestinationPicker.svelte.test.ts
```

Expected: all `DestinationPicker` tests PASS, including focus restoration and the 44px target.

- [ ] **Step 5: Validate Svelte markup**

Run the official Svelte autofixer against `DestinationPicker.svelte`, apply any required corrections, then run:

```bash
pnpm check
```

Expected: 0 errors and 0 warnings.

### Task 2: Remove the Homepage Tax Card

**Files:**
- Modify: `src/routes/+page.svelte`
- Test: `tests/e2e/storefront.spec.ts`

**Interfaces:**
- Consumes: the existing homepage highlight layout.
- Produces: Shipping, Regions, and Support highlights with no Tax highlight; pricing data and tax calculations remain unchanged.

- [ ] **Step 1: Write the failing browser assertion**

Extend the homepage journey test:

```ts
await expect(page.getByRole('heading', { level: 3, name: 'Shipping' })).toBeVisible();
await expect(page.getByRole('heading', { level: 3, name: 'Regions' })).toBeVisible();
await expect(page.getByRole('heading', { level: 3, name: 'Support' })).toBeVisible();
await expect(page.getByRole('heading', { level: 3, name: 'Tax' })).toHaveCount(0);
```

- [ ] **Step 2: Run the focused browser test and verify red**

Run:

```bash
pnpm run build:test-e2e
pnpm exec playwright test tests/e2e/storefront.spec.ts --grep "homepage presents"
```

Expected: FAIL because the homepage still renders the Tax heading.

- [ ] **Step 3: Remove the redundant card**

Delete the Tax `<article>` from `src/routes/+page.svelte` and remove `pricingDisclosure` from its import:

```ts
import { displayPriceForDestination } from '$lib/domain/pricing';
```

Keep the Shipping, Regions, and Support articles unchanged.

- [ ] **Step 4: Run the focused browser test and verify green**

Run:

```bash
pnpm run build:test-e2e
pnpm exec playwright test tests/e2e/storefront.spec.ts --grep "homepage presents"
```

Expected: PASS across the configured browser projects.

### Task 3: Responsive Regression and Release

**Files:**
- Modify: `tests/e2e/storefront.spec.ts`

**Interfaces:**
- Consumes: the compact destination trigger and existing sticky header.
- Produces: explicit 320px evidence that the header fits and the picker remains operable.

- [ ] **Step 1: Extend the existing 320px header coverage**

In the homepage journey test, assert the destination trigger is visible and the document fits its viewport:

```ts
const destinationTrigger = page.getByRole('button', {
	name: 'Choose delivery country, currently Sweden'
});
await expect(destinationTrigger).toBeVisible();
const layout = await page.evaluate(() => ({
	documentWidth: document.documentElement.scrollWidth,
	viewportWidth: window.innerWidth
}));
expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
```

- [ ] **Step 2: Run the full verification set**

Run:

```bash
pnpm check
pnpm test:unit
pnpm test:e2e
pnpm test:shutdown
```

Expected: Svelte diagnostics, unit tests, all active browser tests, the production build, and graceful shutdown proof PASS.

- [ ] **Step 3: Commit and push**

```bash
git add src/lib/components/DestinationPicker.svelte src/lib/components/DestinationPicker.svelte.test.ts src/routes/+page.svelte tests/e2e/storefront.spec.ts docs/superpowers/plans/2026-07-23-compact-destination-trigger.md
git commit -m "feat: compact the destination selector"
git push origin main
```

- [ ] **Step 4: Deploy and verify production**

Stop the Coolify application before starting the forced deployment so the persisted SQLite database has a single writer. Wait for `running:healthy`, then verify:

```text
GET https://shop.sveltesociety.dev/health/live -> 200
GET https://shop.sveltesociety.dev/health/ready -> 200
```

At a 320px viewport, verify the destination trigger shows the selected flag, opens the dialog, the Tax homepage card is absent, and `document.documentElement.scrollWidth <= window.innerWidth`.
