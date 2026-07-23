# Product-first Storefront Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the collection and working quick-add controls above the fold while moving the Svelte Society mission below the products.

**Architecture:** Add a focused `ProductQuickAdd` client component that receives an already-priced product and delegates cart mutations to the existing `CartController`. Compose it into `ProductCard` as a sibling of product links, then simplify the route-level hierarchy so the collection is the first section and the mission follows it. Preserve all pricing, catalog, cart persistence, checkout, and product-page behavior.

**Tech Stack:** SvelteKit 2, Svelte 5 runes, TypeScript, Vitest browser component tests, Playwright end-to-end tests, pnpm.

## Global Constraints

- Keep the existing announcement strip and sticky site header.
- The opening content is `Svelte Society Shop`, H1 `Shop the collection.`, then product cards.
- Product thumbnails must be visible in the initial viewport at 320px, 768px, 1024px, and 1440px widths.
- Move `Wear Svelte. Support the community.` and `Your purchase supports` below the complete collection.
- Keep product navigation and cart actions as separate interactive elements; never nest a button in a link.
- Multi-variant quick-add opens a labelled option group, focuses the first option, adds on selection, and closes through Escape or a dedicated close button.
- Single-variant quick-add adds immediately without revealing an option chooser.
- Use the existing variant labels, Stripe price IDs, `CartController`, persistence, limits, and analytics.
- Do not change server behavior, Stripe catalog data, pricing, tax, checkout, database, or country availability.
- Primary cart and option targets must be at least 44px high and must not create horizontal overflow.
- Every shell command in this repository is prefixed with `rtk`; use pnpm, Node.js, and the existing project scripts.
- Use test-driven development and run the Svelte autofixer on every changed Svelte file.

---

### Task 1: Accessible quick-add interaction

**Files:**
- Create: `src/lib/components/ProductQuickAdd.svelte`
- Create: `src/lib/components/ProductQuickAdd.svelte.test.ts`

**Interfaces:**
- Consumes: `PricedPublicCatalogProduct`; `CartController.add(priceId: string, quantity?: number): void`; default shared `cart`.
- Produces: `ProductQuickAdd` props `{ product: PricedPublicCatalogProduct; cartController?: CartController }`.

- [ ] **Step 1: Write failing multi-variant disclosure and selection tests**

Create browser tests with a two-size apparel product and isolated cart. Assert that `Add to cart` has `aria-expanded="false"`, clicking it changes the state to `true`, reveals a group named `Choose a size for Community Tee`, and focuses the `S` button. Select `M` and assert:

```ts
expect(cartController.lines).toEqual([{ priceId: 'price_tee_m', quantity: 1 }]);
await expect
	.element(page.getByRole('status', { name: 'Cart status' }))
	.toHaveTextContent('Community Tee, M added to cart.');
await expect.element(addButton).toHaveAttribute('aria-expanded', 'false');
```

Also assert that the chooser closes without changing the cart when its `Close size choices` button is pressed and when Escape is pressed from a size button.

- [ ] **Step 2: Verify the new tests fail because the component does not exist**

Run:

```bash
rtk pnpm exec vitest run --project client src/lib/components/ProductQuickAdd.svelte.test.ts
```

Expected: FAIL because `./ProductQuickAdd.svelte` cannot be resolved.

- [ ] **Step 3: Implement the minimum multi-variant component**

Use Svelte 5 state and native controls:

```svelte
<script lang="ts">
	import { tick } from 'svelte';
	import type { PricedPublicCatalogProduct } from '$lib/domain/pricing';
	import { cart, type CartController } from '$lib/stores/cart.svelte';

	type Props = {
		product: PricedPublicCatalogProduct;
		cartController?: CartController;
	};

	let { product, cartController = cart }: Props = $props();
	let expanded = $state(false);
	let message = $state('');
	let errorMessage = $state('');
	let trigger = $state<HTMLButtonElement | null>(null);
	let chooser = $state<HTMLDivElement | null>(null);
	let chooserId = $derived(`quick-add-${product.slug}`);

	async function openOrAdd(): Promise<void> {
		errorMessage = '';
		message = '';
		if (product.variants.length === 1) {
			addVariant(product.variants[0]);
			return;
		}
		expanded = true;
		await tick();
		chooser?.querySelector<HTMLButtonElement>('[data-variant]')?.focus();
	}

	function closeChoices({ restoreFocus = true } = {}): void {
		expanded = false;
		errorMessage = '';
		if (restoreFocus) void tick().then(() => trigger?.focus());
	}

	function addVariant(variant: PricedPublicCatalogProduct['variants'][number]): void {
		cartController.add(variant.priceId);
		expanded = false;
		message = `${product.name}, ${variant.label} added to cart.`;
	}
</script>
```

Render a trigger with `aria-expanded`, `aria-controls`, and a 44px minimum height. When expanded, render a labelled native-button group, a close button, and an `onkeydown` Escape handler. Always render a polite status region named `Cart status`.

- [ ] **Step 4: Run the focused tests and make them pass**

Run:

```bash
rtk pnpm exec vitest run --project client src/lib/components/ProductQuickAdd.svelte.test.ts
```

Expected: PASS for disclosure, focus, correct price ID, close, and Escape behavior.

- [ ] **Step 5: Add failing single-variant and cart-limit tests**

Add a one-variant accessory test that clicks `Add to cart`, asserts the sole price ID is added, and asserts no option group appears. Add parameterized tests that prefill the isolated cart to the 20-unit and 10-distinct-price limits, then assert the local alert contains respectively:

```text
Your cart holds up to 20 items. Remove one before adding another.
Your cart has 10 different options. Remove one before adding another.
```

Assert that neither failure produces success text. Add a test whose controller throws `UNEXPECTED` and assert that the exception is not swallowed.

- [ ] **Step 6: Verify the new tests fail on missing error handling**

Run the focused Vitest command from Step 4.

Expected: the single-variant happy path passes; both recoverable-error tests fail because the errors escape.

- [ ] **Step 7: Add local recoverable error handling**

Wrap only `cartController.add` and translate `CART_TOO_MANY_UNITS` and `CART_TOO_MANY_DISTINCT_PRICES` into the exact alert copy. Clear success on failure, clear error on success, and rethrow every unknown error.

- [ ] **Step 8: Verify Task 1 and commit**

Run:

```bash
rtk pnpm exec vitest run --project client src/lib/components/ProductQuickAdd.svelte.test.ts
```

Expected: all `ProductQuickAdd` tests PASS.

Then run the Svelte autofixer for `ProductQuickAdd.svelte`, fix every issue it reports, rerun the focused test, and commit:

```bash
rtk git add src/lib/components/ProductQuickAdd.svelte src/lib/components/ProductQuickAdd.svelte.test.ts
rtk git commit -m "feat: add accessible product quick add"
```

### Task 2: Product-card composition

**Files:**
- Modify: `src/lib/components/ProductCard.svelte`
- Modify: `src/lib/components/ProductCard.svelte.test.ts`

**Interfaces:**
- Consumes: `ProductQuickAdd` from Task 1 and the existing priced product prop.
- Produces: a card whose image and copy navigate to `/products/[slug]` while quick-add remains a separate sibling interaction.

- [ ] **Step 1: Write failing card-composition tests**

Update the fixture to include two apparel variants. Assert that the card exposes product links for `Community Tee`, exposes a separate `Add to cart` button, and contains no interactive element nested inside another:

```ts
const nestedInteractive = document.querySelector(
	'a button, button a, a [role="button"], button [role="link"]'
);
expect(nestedInteractive).toBeNull();
```

Click the product-name link and assert `track.mock.calls` remains exactly `[['product_viewed']]`.

- [ ] **Step 2: Verify the card test fails**

Run:

```bash
rtk pnpm exec vitest run --project client src/lib/components/ProductCard.svelte.test.ts
```

Expected: FAIL because the card does not expose `Add to cart`.

- [ ] **Step 3: Recompose the card around sibling interactions**

Import `ProductQuickAdd`. Change the frame to contain an image-only product link and `ProductQuickAdd` as siblings. Place the category/name/price in a second product link below the frame. Keep `track('product_viewed')` on both navigation links, image loading behavior unchanged, and preserve the destination-projected price.

CSS requirements:

```css
.product-frame {
	position: relative;
}

.image-link {
	display: block;
	height: 100%;
}

.card-copy-link {
	display: block;
	text-decoration: none;
}
```

The child quick-add component owns the bottom thumbnail overlay. Maintain visible `:focus-visible` treatment for links and buttons and do not suppress outlines.

- [ ] **Step 4: Verify Task 2 and commit**

Run:

```bash
rtk pnpm exec vitest run --project client src/lib/components/ProductCard.svelte.test.ts src/lib/components/ProductQuickAdd.svelte.test.ts
```

Expected: both component suites PASS.

Then run the Svelte autofixer for the complete `ProductCard.svelte`, fix any report, rerun both suites, and commit:

```bash
rtk git add src/lib/components/ProductCard.svelte src/lib/components/ProductCard.svelte.test.ts
rtk git commit -m "feat: add quick purchase controls to product cards"
```

### Task 3: Product-first homepage hierarchy

**Files:**
- Modify: `src/routes/+page.svelte`
- Modify: `src/routes/home-page.svelte.test.ts`

**Interfaces:**
- Consumes: unchanged `PageProps` and `ProductGrid`.
- Produces: route order `collection -> mission -> commerce` with a compact collection heading.

- [ ] **Step 1: Write a failing hierarchy test**

Render the page with one catalog product, then assert headings and DOM order:

```ts
const collection = page.getByRole('heading', { level: 1, name: 'Shop the collection.' });
const mission = page.getByRole('heading', {
	level: 2,
	name: 'Wear Svelte. Support the community.'
});
const commerce = page.getByRole('heading', { level: 2, name: 'From cart to doorstep.' });

expect(collection.element().compareDocumentPosition(mission.element()) & Node.DOCUMENT_POSITION_FOLLOWING)
	.toBeTruthy();
expect(mission.element().compareDocumentPosition(commerce.element()) & Node.DOCUMENT_POSITION_FOLLOWING)
	.toBeTruthy();
```

Assert the old `Shop the collection` jump link and `Svelte, out in the world.` heading are absent, while the mission paragraph and four support items remain.

- [ ] **Step 2: Verify the hierarchy test fails**

Run:

```bash
rtk pnpm exec vitest run --project client src/routes/home-page.svelte.test.ts
```

Expected: FAIL because the page still leads with the mission H1.

- [ ] **Step 3: Reorder and tighten the route**

Make the collection the first section and its heading:

```svelte
<section id="collection" class="collection collection-first" aria-labelledby="collection-title">
	<header class="collection-heading">
		<p class="eyebrow">Svelte Society Shop</p>
		<h1 id="collection-title">Shop the collection.</h1>
	</header>
	<!-- existing catalog state and ProductGrid -->
</section>
```

Move the existing mission copy and support panel below the complete product grid. Change only its heading level from H1 to H2. Remove the jump-link CTA. Keep commerce after the mission.

Use compact top spacing so thumbnails enter the initial viewport:

```css
.collection-first {
	padding-top: clamp(1.5rem, 4vw, 3rem);
}

.collection-heading {
	margin-bottom: clamp(1.25rem, 3vw, 2rem);
}

.collection-heading h1 {
	margin-bottom: 0;
	font-size: clamp(2.35rem, 6vw, 4.8rem);
	line-height: 0.95;
	letter-spacing: -0.055em;
}
```

Retain the current responsive mission grid, support panel, commerce layout, stale state, and catalog-unavailable state.

- [ ] **Step 4: Verify Task 3 and commit**

Run:

```bash
rtk pnpm exec vitest run --project client src/routes/home-page.svelte.test.ts
```

Expected: PASS.

Run the Svelte autofixer for the complete route, fix any report, rerun the focused test, and commit:

```bash
rtk git add src/routes/+page.svelte src/routes/home-page.svelte.test.ts
rtk git commit -m "feat: lead storefront with the collection"
```

### Task 4: Browser journey and responsive regression coverage

**Files:**
- Modify: `tests/e2e/storefront.spec.ts`

**Interfaces:**
- Consumes: homepage markup and quick-add accessible names from Tasks 1–3.
- Produces: browser coverage for hierarchy, cart behavior, persistence, and supported viewports.

- [ ] **Step 1: Write failing end-to-end expectations**

Update the homepage journey to expect H1 `Shop the collection.` and the collection before the mission. Add a test that never navigates away from `/` while it:

```ts
await page.getByRole('article').filter({ hasText: 'Community Tee' })
	.getByRole('button', { name: 'Add to cart' }).click();
await page.getByRole('group', { name: 'Choose a size for Community Tee' })
	.getByRole('button', { name: 'M', exact: true }).click();
await expect(page).toHaveURL(/\/$/);
await expect(page.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();
```

Reload and assert the header still says `Cart, 1 item`. Then add the sole `Society Mug` variant from its card and assert `Cart, 2 items` without an option chooser.

Extend the configured-project homepage test so it compares bounding boxes for H1, first product image, and mission heading; assert the product appears below the H1, inside the initial viewport, and before the mission. Retain the document-width overflow assertion.

- [ ] **Step 2: Run the focused end-to-end file**

Run:

```bash
rtk pnpm run build:test-e2e
rtk pnpm exec playwright test tests/e2e/storefront.spec.ts
```

Expected: failures for the old homepage heading/order and missing homepage quick-add controls.

- [ ] **Step 3: Make only test-alignment fixes required by real browser behavior**

If browser behavior exposes a layout or focus defect, fix it in the owning Svelte component. Do not relax the hierarchy, focus, cart, persistence, 44px target, or no-overflow assertions. Run the Svelte autofixer again for any component changed during this step.

- [ ] **Step 4: Run complete verification**

Run:

```bash
rtk pnpm run check
rtk pnpm run lint
rtk pnpm run test:unit
rtk pnpm run test:integration
rtk pnpm run test:e2e
rtk pnpm run build
```

Expected: every command exits 0 with no Svelte errors, lint violations, test failures, or build failures.

- [ ] **Step 5: Review and commit the finished behavior**

Review the diff for scope: no server, Stripe, pricing, tax, checkout, database, or country changes. Confirm no `Styria` copy was introduced and no product-card interaction is nested.

Commit:

```bash
rtk git add tests/e2e/storefront.spec.ts src/lib/components src/routes/+page.svelte src/routes/home-page.svelte.test.ts
rtk git commit -m "test: cover product-first storefront journey"
```

## Self-review result

- Spec coverage: collection order, mission move, multi- and single-variant behavior, focus, Escape, close, local cart errors, product links, analytics, persistence, configured viewports, and overflow all map to explicit tasks.
- Placeholder scan: no deferred implementation markers or generic error-handling instructions remain.
- Type consistency: `ProductQuickAdd` consumes the existing `PricedPublicCatalogProduct` and optional `CartController`; cards continue to consume priced products; route and grid interfaces remain unchanged.
