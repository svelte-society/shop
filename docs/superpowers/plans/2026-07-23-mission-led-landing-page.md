# Mission-led landing page implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the Society Shop landing page around supporting Svelte Society while preserving
one clear shopping action and all existing commerce behaviour.

**Architecture:** Keep the change within the existing Svelte presentation layer. Rename the global
shipping strip to a purpose-neutral announcement component, then replace the homepage's duplicate
shipping hero card with a static mission panel. Product, destination, pricing, cart, checkout, and
server-loader data remain unchanged.

**Tech Stack:** Svelte 5, SvelteKit, TypeScript, scoped CSS, Vitest browser component tests,
adapter-node, pnpm.

## Global constraints

- The global message is exactly `Every purchase supports Svelte Society.`
- The hero heading is exactly `Wear Svelte. Support the community.`
- Do not claim that all revenue, all profit, or a fixed percentage funds a programme.
- Keep exactly one `Shop the collection` link on the homepage.
- Keep free-shipping information on product, cart, and homepage ordering-information surfaces.
- Do not change catalog, pricing, shipping, tax, cart, checkout, or fulfillment behaviour.
- Preserve the existing Svelte Society colour system, semantic headings, keyboard behaviour, and
  responsive layout.
- Do not deploy until formatting, Svelte diagnostics, linting, all unit tests, a production build,
  and local desktop/mobile inspection pass.
- Follow the repository's stop-first Coolify deployment procedure because production SQLite must
  never be mounted by overlapping application containers.

---

### Task 1: Replace the shipping strip with a global announcement

**Files:**

- Create: `src/lib/components/AnnouncementStrip.svelte`
- Create: `src/lib/components/AnnouncementStrip.svelte.test.ts`
- Modify: `src/routes/+layout.svelte`
- Delete: `src/lib/components/ShippingStrip.svelte`

**Interfaces:**

- Consumes: no props or runtime data.
- Produces: a default Svelte component imported as `AnnouncementStrip` by the root layout.

- [ ] **Step 1: Write the failing component test**

```ts
import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import AnnouncementStrip from './AnnouncementStrip.svelte';

describe('AnnouncementStrip', () => {
	it('states the shop purpose without repeating the shipping promotion', async () => {
		render(AnnouncementStrip);

		await expect
			.element(page.getByText('Every purchase supports Svelte Society.', { exact: true }))
			.toBeVisible();
		expect(page.getByText('Free shipping when you pick two.', { exact: true }).query()).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test and verify the missing component fails**

Run:

```sh
pnpm vitest run src/lib/components/AnnouncementStrip.svelte.test.ts
```

Expected: FAIL because `AnnouncementStrip.svelte` does not exist.

- [ ] **Step 3: Implement the announcement and update the layout**

Create the component with the existing compact global-strip presentation:

```svelte
<div class="announcement-strip">
	<p>Every purchase supports Svelte Society.</p>
</div>

<style>
	.announcement-strip {
		display: grid;
		min-height: 2.5rem;
		place-items: center;
		padding: 0.45rem 1rem;
		background: var(--color-ink);
		color: var(--color-white);
		text-align: center;
	}

	p {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 750;
		letter-spacing: 0.025em;
	}
</style>
```

In `src/routes/+layout.svelte`, replace the import and rendered component:

```svelte
import AnnouncementStrip from '$lib/components/AnnouncementStrip.svelte';
```

```svelte
<AnnouncementStrip />
```

Delete `ShippingStrip.svelte` after no imports remain.

- [ ] **Step 4: Run the focused test and Svelte diagnostics**

Run:

```sh
pnpm vitest run src/lib/components/AnnouncementStrip.svelte.test.ts
pnpm check
```

Expected: the component test passes and Svelte reports zero errors and zero warnings.

- [ ] **Step 5: Commit the announcement change**

```sh
git add src/lib/components/AnnouncementStrip.svelte \
  src/lib/components/AnnouncementStrip.svelte.test.ts \
  src/lib/components/ShippingStrip.svelte \
  src/routes/+layout.svelte
git commit -m "feat: make shop purpose the global announcement"
```

---

### Task 2: Build the mission-led homepage hero

**Files:**

- Modify: `src/routes/home-page.svelte.test.ts`
- Modify: `src/routes/+page.svelte`

**Interfaces:**

- Consumes: the existing `PageProps` data and current catalog/pricing components without changing
  their types.
- Produces: the approved static hero, support list, metadata, and the existing collection and
  commerce sections.

- [ ] **Step 1: Write failing homepage assertions**

Extend the existing rendered-page test with these assertions:

```ts
await expect
	.element(page.getByRole('heading', { name: 'Wear Svelte. Support the community.' }))
	.toBeVisible();
await expect
	.element(
		page.getByText(
			'Every purchase supports Svelte Society’s continued work across the ecosystem—organizing community events, sharing useful resources, and helping Svelte developers connect.',
			{ exact: true }
		)
	)
	.toBeVisible();
await expect.element(page.getByRole('heading', { name: 'Your purchase supports' })).toBeVisible();

for (const item of [
	'Community events',
	'Shared resources',
	'Open-source projects',
	'Developer connections'
]) {
	await expect.element(page.getByText(item, { exact: true })).toBeVisible();
}

expect(page.getByText('items ship free', { exact: false }).query()).toBeNull();
expect(page.getByRole('link', { name: 'Shop the collection' }).all()).toHaveLength(1);
await expect
	.element(page.getByRole('heading', { name: 'From cart to doorstep.' }))
	.toBeVisible();
```

- [ ] **Step 2: Run the homepage test and verify the old hero fails the new assertions**

Run:

```sh
pnpm vitest run src/routes/home-page.svelte.test.ts
```

Expected: FAIL because the new hero heading and support list are absent.

- [ ] **Step 3: Replace the hero markup and metadata**

Use this approved hero content in `src/routes/+page.svelte`:

```svelte
<meta
	name="description"
	content="Official Svelte Society merchandise that supports continued community work across the Svelte ecosystem. Free shipping on two or more items."
/>
```

```svelte
<section class="hero" aria-labelledby="hero-title">
	<div class="hero-copy">
		<p class="eyebrow">Svelte Society Shop</p>
		<h1 id="hero-title">Wear Svelte. Support the community.</h1>
		<p>
			Every purchase supports Svelte Society’s continued work across the ecosystem—organizing
			community events, sharing useful resources, and helping Svelte developers connect.
		</p>
		<a class="primary-link" href={resolve('/#collection')}>Shop the collection</a>
	</div>

	<aside class="support-panel" aria-labelledby="support-title">
		<p class="eyebrow">Community-powered</p>
		<h2 id="support-title">Your purchase supports</h2>
		<ul>
			<li>Community events</li>
			<li>Shared resources</li>
			<li>Open-source projects</li>
			<li>Developer connections</li>
		</ul>
	</aside>
</section>
```

Remove the `.shipping-signature` markup and CSS. Style `.support-panel` as the dark editorial card
using the existing ink, white, Svelte orange, radius, and offset-shadow tokens. Use a real list with
no bullets, separated rows, and no interactive styling. At the `40rem` breakpoint, let the panel
fill the available width beneath the hero copy instead of constraining it to the former card width.

- [ ] **Step 4: Run the Svelte autofixer on both changed Svelte components**

Pass the complete contents of `AnnouncementStrip.svelte` and `+page.svelte` to the official Svelte
autofixer with Svelte version 5. Apply every relevant accessibility, markup, or scoped-CSS fix, then
run the autofixer again if it requests another pass.

- [ ] **Step 5: Run the focused tests and diagnostics**

Run:

```sh
pnpm vitest run src/lib/components/AnnouncementStrip.svelte.test.ts \
  src/routes/home-page.svelte.test.ts
pnpm check
```

Expected: both test files pass and Svelte reports zero errors and zero warnings.

- [ ] **Step 6: Commit the homepage change**

```sh
git add src/routes/+page.svelte src/routes/home-page.svelte.test.ts
git commit -m "feat: lead shop with the Society mission"
```

---

### Task 3: Verify, review locally, and release

**Files:**

- Verify: all current source and test files
- Deploy: reviewed `main` branch through the existing Coolify Docker Compose resource

**Interfaces:**

- Consumes: the completed presentation commits and the existing production configuration.
- Produces: one verified production deployment at `https://shop.sveltesociety.dev/`.

- [ ] **Step 1: Audit the remaining worktree before release**

Run:

```sh
git status --short
git diff --check
git diff --stat
```

Review every remaining uncommitted file. Preserve unrelated user changes; include only the already
reviewed storefront and policy changes intended for this release.

- [ ] **Step 2: Run complete verification**

Run:

```sh
pnpm exec prettier --write .
pnpm check
pnpm lint
pnpm test:unit
pnpm build
```

Expected: formatting succeeds, Svelte reports zero errors and zero warnings, lint exits zero, all
unit tests pass, and the adapter-node production build exits zero.

- [ ] **Step 3: Rebuild and inspect the production-style local fixture**

Run `pnpm build:test-e2e`, restart the existing fixture on `http://127.0.0.1:4173`, and inspect the
homepage at desktop and narrow-mobile widths. Verify the announcement, hero, support list, product
collection, ordering information, sticky header, no horizontal overflow, and one primary CTA.

- [ ] **Step 4: Commit the remaining reviewed release changes**

Stage only the reviewed files shown by `git status`, inspect `git diff --cached`, and commit them with
an accurate release-scoped message. Do not stage local databases, build artifacts, secrets, or
unrelated user files.

- [ ] **Step 5: Push the reviewed main branch**

Run:

```sh
git push origin main
```

Expected: the remote `main` branch advances to the locally verified commit.

- [ ] **Step 6: Use the Coolify stop-first deployment procedure**

Confirm Auto Deploy remains off and the deployment queue is empty. Stop the current Society Shop
resource, verify no container still owns the `shop-data` volume, deploy the reviewed `main` commit,
and require exactly one healthy application container before reopening traffic. Never start a
replacement while the old container can still mount `/data`.

- [ ] **Step 7: Verify production**

Run:

```sh
curl --fail --silent --show-error https://shop.sveltesociety.dev/health/live
curl --fail --silent --show-error https://shop.sveltesociety.dev/health/ready
pnpm verify:production -- https://shop.sveltesociety.dev
```

Then inspect the public homepage and confirm the deployed HTML contains the new announcement and
hero while omitting the old hero shipping promotion. Expected: both health endpoints return `200`,
the production verifier passes, and the public UI matches the reviewed local fixture.
