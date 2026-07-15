# Phase 1: Storefront Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the SvelteKit app and deliver the branded, accessible storefront, validated Stripe catalog, product pages, and persistent cart without opening checkout.

**Architecture:** SvelteKit page loaders call a `CatalogService` backed by Stripe and a short validated memory cache. Browser cart state contains only Price IDs and quantities. Pure domain modules own cart, catalog, money, and destination rules. Public layout and components apply the approved Svelte Society brand and copy.

**Tech Stack:** Node 24, pnpm, Svelte 5, SvelteKit 2, TypeScript, Tailwind CSS, Valibot 1.4.2, Stripe 22.3.1, Vitest, Playwright, `@sveltejs/adapter-node`.

## Global Constraints

- Run this phase on top of the roadmap and approved specification.
- Launch with four to eight active merch Products across apparel and accessories.
- Keep `CHECKOUT_ENABLED=false`; Phase 1 does not create Checkout Sessions.
- Do not add a local product editor, product JSON source of truth, filters, accounts, or an admin route.
- Product descriptions render as plain text.
- Use Society-owned logo and Manrope assets copied from the current `svelte-society/sveltesociety.dev` repository. Record their upstream path and commit SHA in `docs/brand-assets.md`.
- Use Svelte orange, slate navy, white, and pale orange. Keep product mockups in 4:5 frames and primary controls at least 44 by 44 CSS pixels.

---

## Task 1: Scaffold the application with `sv`

**Files:**

- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `.npmrc`
- Create: `.nvmrc`
- Create: `.gitignore`
- Create: `pnpm-workspace.yaml`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `prettier.config.js`
- Create: `playwright.config.ts`
- Create: `vitest.integration.config.ts`
- Create: `src/app.html`
- Create: `src/app.d.ts`
- Create: `src/routes/+layout.svelte`
- Create: `src/routes/layout.css`
- Create: `src/routes/+page.svelte`
- Preserve: `docs/**`

**Interfaces produced:** `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm check`, Vitest, Playwright, Tailwind, and adapter-node are available.

- [ ] Verify the repository contains only committed planning documents with `git status --short`.

- [ ] Scaffold in the repository root:

```bash
pnpm dlx sv create . --template minimal --types ts --add prettier eslint vitest="usages:unit,component" playwright tailwindcss="plugins:none" sveltekit-adapter="adapter:node" --install pnpm --no-dir-check --no-download-check
```

Expected: `sv` reports successful project creation, pnpm completes installation, and `docs/` remains unchanged.

- [ ] Pin the runtime and package manager in `package.json`:

```json
{
  "name": "svelte-society-shop",
  "engines": { "node": ">=24 <25" },
  "packageManager": "pnpm@10.28.1"
}
```

Merge these fields into the generated file; do not replace generated scripts or dependencies.

- [ ] Add `.nvmrc` containing `24` and `.npmrc` containing `engine-strict=true`.

- [ ] Install Phase 1 runtime dependencies:

```bash
pnpm add valibot@1.4.2 stripe@22.3.1
```

- [ ] Normalize scripts in `package.json`:

```json
{
  "scripts": {
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
    "test": "pnpm run test:unit && pnpm run test:integration && pnpm run test:e2e",
    "test:unit": "vitest run --project client --project server",
    "test:integration": "vitest run --config vitest.integration.config.ts --passWithNoTests",
    "test:e2e": "playwright test"
  }
}
```

Create `vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'integration',
    environment: 'node',
    include: ['tests/integration/**/*.{test,spec}.ts']
  }
});
```

The generated `test` script uses another package manager; replacing it is required even if it is not invoked during this task.

- [ ] Run the generated baseline:

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm build
```

Expected: all commands exit `0`; the production build uses adapter-node.

- [ ] Commit:

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc .gitignore vite.config.ts vitest.integration.config.ts tsconfig.json eslint.config.js prettier.config.js playwright.config.ts src
git commit -m "chore: scaffold SvelteKit merch store"
```

---

## Task 2: Add typed configuration and feature gates

**Files:**

- Create: `src/lib/config/public.ts`
- Create: `src/lib/config/private.server.ts`
- Create: `src/lib/config/config.test.ts`
- Create: `.env.example`
- Modify: `src/app.d.ts`
- Modify: `.gitignore`

**Interfaces produced:**

```ts
export type PublicConfig = {
  storefrontEnabled: boolean;
  checkoutEnabled: boolean;
  productionOrigin: URL;
  supportEmail: string;
};

export type PrivateConfig = PublicConfig & {
  stripeSecretKey: string;
  stripePaidShippingRateId: string;
  stripeFreeShippingRateId: string;
};

export function parsePublicConfig(env: Record<string, string | undefined>): PublicConfig;
export function parsePrivateConfig(env: Record<string, string | undefined>): PrivateConfig;
```

- [ ] Write failing tests for strict booleans, HTTPS production origin, support email, and required Stripe values. Include a test proving the string `false` becomes `false`, not truthy.

```ts
import { describe, expect, it } from 'vitest';
import { parsePublicConfig } from './public';

describe('parsePublicConfig', () => {
  it('parses explicit feature booleans', () => {
    const config = parsePublicConfig({
      STOREFRONT_ENABLED: 'true',
      CHECKOUT_ENABLED: 'false',
      PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
      SUPPORT_EMAIL: 'merch@sveltesociety.dev'
    });
    expect(config).toMatchObject({ storefrontEnabled: true, checkoutEnabled: false });
  });
});
```

- [ ] Run `pnpm vitest run src/lib/config/config.test.ts`.

Expected: fail because the config modules do not exist.

- [ ] Implement both parsers with Valibot, explicit `true`/`false` transforms, stable configuration error codes, and no secret values in error messages.

- [ ] Add every variable from all four phases to `.env.example` as names grouped by Storefront, Stripe, SQLite, MCP, Styria, Plunk, S3, Umami, and Seller. Use empty values for secrets and safe literal defaults for booleans, URLs, port, timeouts, and `/data/shop.sqlite`.

- [ ] Run `pnpm vitest run src/lib/config/config.test.ts && pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: add typed runtime configuration"`.

---

## Task 3: Implement pure money, cart, and destination rules

**Files:**

- Create: `src/lib/domain/money.ts`
- Create: `src/lib/domain/money.test.ts`
- Create: `src/lib/domain/cart.ts`
- Create: `src/lib/domain/cart.test.ts`
- Create: `src/lib/domain/destinations.ts`
- Create: `src/lib/domain/destinations.test.ts`

**Interfaces produced:**

```ts
export type CartLine = { priceId: string; quantity: number };
export type ShippingMode = 'paid' | 'free';
export function parseCart(input: unknown): CartLine[];
export function totalUnits(lines: CartLine[]): number;
export function selectShippingMode(lines: CartLine[]): ShippingMode;
export function swedishReferenceGrossCents(netCents: number): number;
export function formatEur(cents: number, locale?: string): string;
export const ALLOWED_DESTINATIONS: readonly string[];
export function isAllowedDestination(countryCode: string): boolean;
```

- [ ] Write table-driven failing tests covering zero/negative/fractional quantities, duplicate Price IDs, 11 distinct Prices, 21 units, one-unit paid shipping, two-unit free shipping including the same variant, EUR 20 net to EUR 25 reference gross, every allowed country, and Slovenia rejection.

- [ ] Run:

```bash
pnpm vitest run src/lib/domain/money.test.ts src/lib/domain/cart.test.ts src/lib/domain/destinations.test.ts
```

Expected: fail because the modules do not exist.

- [ ] Implement the cart schema with Valibot. Merge duplicate Price IDs before enforcing limits, use integer cents only, and freeze the exact destination allowlist from the specification.

```ts
export function selectShippingMode(lines: CartLine[]): ShippingMode {
  return totalUnits(lines) >= 2 ? 'free' : 'paid';
}

export function swedishReferenceGrossCents(netCents: number): number {
  if (!Number.isSafeInteger(netCents) || netCents < 0) throw new Error('INVALID_CENTS');
  return Math.round((netCents * 125) / 100);
}
```

- [ ] Run the focused tests and `pnpm check`.

Expected: all pass.

- [ ] Commit with `git commit -m "feat: add cart and commerce rules"`.

---

## Task 4: Build the Stripe catalog contract and cache

**Files:**

- Create: `src/lib/domain/catalog.ts`
- Create: `src/lib/server/catalog/parse.ts`
- Create: `src/lib/server/catalog/parse.test.ts`
- Create: `src/lib/server/catalog/gateway.ts`
- Create: `src/lib/server/catalog/stripe-catalog.server.ts`
- Create: `src/lib/server/catalog/cache.server.ts`
- Create: `src/lib/server/catalog/service.server.ts`
- Create: `src/lib/server/catalog/service.test.ts`
- Create: `tests/fixtures/stripe-catalog.ts`

**Interfaces consumed:** `stripeSecretKey`, Stripe Product/Price metadata contract, `swedishReferenceGrossCents`.

**Interfaces produced:**

```ts
export type CatalogDiagnostic = { providerId: string; code: string };
export type CatalogSnapshot = {
  products: CatalogProduct[];
  diagnostics: CatalogDiagnostic[];
  loadedAt: Date;
  stale: boolean;
};

export interface CatalogGateway {
  loadMerchCatalog(): Promise<CatalogSnapshot>;
  resolveVariants(priceIds: readonly string[]): Promise<CatalogVariant[]>;
}

export interface CatalogService {
  listPublic(): Promise<{ products: PublicCatalogProduct[]; stale: boolean }>;
  findPublicBySlug(slug: string): Promise<PublicCatalogProduct | null>;
  resolveCart(lines: CartLine[]): Promise<Array<{ line: CartLine; product: CatalogProduct; variant: CatalogVariant }>>;
  diagnostics(): Promise<CatalogDiagnostic[]>;
}
```

- [ ] Write failing parser tests for valid apparel, valid single-variant accessory, missing HTTPS image, missing/duplicate slug, wrong currency, inclusive tax behavior, missing SKU/Styria product number, missing materials/care/apparel fit, missing design reference/placement, invalid design placement URL, inactive Product/Price, stable sort order, and a diagnostic that contains no Product description.

- [ ] Run `pnpm vitest run src/lib/server/catalog/parse.test.ts`.

Expected: fail because the parser does not exist.

- [ ] Implement strict parsing. Retrieve active Products expanded with default Price only for discovery, then list all active Prices for each accepted Product so every variant is available. Accept only one-time EUR Prices with integer `unit_amount` and `tax_behavior='exclusive'`. Parse metadata keys matching `design_url_<position>` into a sorted placement map and require HTTPS values; keep `design_reference`, materials, fit, care, and placements server-trusted. Add an explicit public projection that removes SKU, Styria product number, design reference, design URLs, and diagnostics before returning page data.

- [ ] Write failing cache tests using an injected clock: fresh values are returned, expired values refresh, a refresh failure serves the recent last-known-good value, and no valid value throws `CATALOG_UNAVAILABLE`.

- [ ] Implement a 60-second fresh TTL and 15-minute stale-if-error window. Store only validated `CatalogSnapshot` objects in memory.

- [ ] Run `pnpm vitest run src/lib/server/catalog && pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: validate Stripe merch catalog"`.

---

## Task 5: Add Society brand assets and the public shell

**Files:**

- Create: `static/fonts/manrope-variable.woff2`
- Create: `static/brand/svelte-society.svg`
- Create: `docs/brand-assets.md`
- Create: `src/lib/components/ShippingStrip.svelte`
- Create: `src/lib/components/SiteHeader.svelte`
- Create: `src/lib/components/SiteFooter.svelte`
- Create: `src/lib/components/OpeningSoon.svelte`
- Create: `src/lib/components/SiteHeader.svelte.test.ts`
- Create: `src/app.css`
- Modify: `src/routes/+layout.svelte`
- Create: `src/routes/+layout.server.ts`

**Interfaces consumed:** `PublicConfig`, cart count store from Task 7.

- [ ] Use `gh` to read the current `svelte-society/sveltesociety.dev` default branch and copy only the Society-owned logo and Manrope webfont. Record repository, upstream file paths, commit SHA, and license/ownership note in `docs/brand-assets.md`.

- [ ] Write a failing component test proving the header exposes a labelled home link, Collection link, external Svelte Society link, and Cart link with an accessible count.

- [ ] Implement the CSS token system and shell. Start with the exact approved orange tokens, add slate/white/surface/text/focus tokens, set `@font-face`, and include global focus-visible and reduced-motion rules.

```css
:root {
  --color-svelte-900: oklch(65.43% 0.2341 34.2);
  --color-svelte-500: oklch(71.09% 0.1862 37.91);
  --color-svelte-300: oklch(86.8% 0.1825 38.6);
  --color-svelte-100: oklch(92.72% 0.0386 39.91);
  --color-svelte-50: oklch(97.02% 0.0151 37.88);
  --color-ink: oklch(24% 0.025 255);
  --color-paper: oklch(99% 0.004 40);
  --focus-ring: 0 0 0 3px var(--color-svelte-300);
}
```

- [ ] Make `+layout.server.ts` return public feature flags. When storefront is disabled, render `OpeningSoon` for commerce pages while leaving policy and health routing available for later phases.

- [ ] Run `pnpm vitest run src/lib/components/SiteHeader.svelte.test.ts && pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: add Svelte Society storefront shell"`.

---

## Task 6: Implement homepage catalog and product detail pages

**Files:**

- Create: `src/lib/components/ProductCard.svelte`
- Create: `src/lib/components/ProductGrid.svelte`
- Create: `src/lib/components/ProductGallery.svelte`
- Create: `src/lib/components/VariantPicker.svelte`
- Create: `src/lib/components/CatalogUnavailable.svelte`
- Create: `src/lib/components/VariantPicker.svelte.test.ts`
- Create: `src/routes/+page.server.ts`
- Modify: `src/routes/+page.svelte`
- Create: `src/routes/products/[slug]/+page.server.ts`
- Create: `src/routes/products/[slug]/+page.svelte`
- Create: `src/routes/products/[slug]/+error.svelte`

**Interfaces consumed:** `CatalogService.listPublic`, `CatalogService.findPublicBySlug`, cart `add` action from Task 7.

- [ ] Write a failing VariantPicker component test: apparel requires an explicit selection; an accessory with one variant selects it automatically; keyboard selection updates the live region.

- [ ] Implement the homepage in this order: shipping strip, header, compact identity hero, collection grid, commerce summary, footer CTA. Use the approved headline, body, CTA, threshold copy, title, and meta description verbatim.

- [ ] Implement product details with plain-text description, 4:5 gallery, reference gross price, size radios for apparel, no redundant selector for a one-variant accessory, size-guide link when configured, materials/fit/care/delivery/returns sections, and a sticky mobile add action.

- [ ] Return `404` for unknown slugs. For an unavailable catalog with no valid cache, render the approved temporary-unavailable copy and keep navigation/policies available.

- [ ] Run `pnpm vitest run src/lib/components/VariantPicker.svelte.test.ts && pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: add catalog and product pages"`.

---

## Task 7: Implement the versioned persistent cart

**Files:**

- Create: `src/lib/stores/cart.svelte.ts`
- Create: `src/lib/stores/cart.test.ts`
- Create: `src/lib/components/CartLineItem.svelte`
- Create: `src/lib/components/CartSummary.svelte`
- Create: `src/routes/cart/+page.server.ts`
- Create: `src/routes/cart/+page.svelte`
- Create: `src/routes/checkout/cancel/+page.svelte`

**Interfaces produced:**

```ts
export type CartController = {
  readonly lines: CartLine[];
  readonly totalUnits: number;
  add(priceId: string, quantity?: number): void;
  setQuantity(priceId: string, quantity: number): void;
  remove(priceId: string): void;
  clear(): void;
};

export function createCart(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): CartController;
```

- [ ] Write failing tests for schema version `1`, corrupt storage recovery, duplicate merging, quantity changes, removal, 20-unit enforcement, no storage during SSR, and persistence containing only `{version, lines:[{priceId, quantity}]}`.

- [ ] Implement the Svelte rune-backed controller with `localStorage` key `svelte-society-shop:cart:v1`. Treat stored data as untrusted and parse it through `parseCart`.

- [ ] Implement `/cart` with server-resolved product details and current Stripe prices, editable quantities, removal, the approved empty state, one-item/free-shipping messages, tax note, region note, and a disabled checkout button labelled `Checkout opens soon` while `CHECKOUT_ENABLED=false`.

- [ ] Implement `/checkout/cancel` as a preserved-cart recovery page with `Return to cart` as its primary action.

- [ ] Run `pnpm vitest run src/lib/stores/cart.test.ts && pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: add persistent merch cart"`.

---

## Task 8: Verify responsive and accessible storefront journeys

**Files:**

- Create: `tests/e2e/storefront.spec.ts`
- Create: `tests/e2e/cart.spec.ts`
- Create: `tests/e2e/accessibility.spec.ts`
- Create: `tests/fixtures/catalog-server.ts`
- Modify: `playwright.config.ts`
- Modify: `vite.config.ts`

**Interfaces consumed:** a test-only injected `CatalogGateway`; no production fixture fallback.

- [ ] Add a deterministic test catalog with one apparel Product and one accessory Product. Inject it only when `TEST_CATALOG_FIXTURE=true` and `NODE_ENV=test`; throw at startup if that flag is set elsewhere.

- [ ] Write browser tests for homepage, product selection, accessory add, apparel size requirement, cart persistence after reload, quantity threshold copy, empty cart, catalog unavailable, storefront disabled, keyboard navigation, visible focus, live regions, reduced motion, and 44px primary controls.

- [ ] Run at the required viewports:

```ts
projects: [
  { name: 'chromium-320', use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 900 } } },
  { name: 'chromium-768', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } } },
  { name: 'firefox-1024', use: { ...devices['Desktop Firefox'], viewport: { width: 1024, height: 900 } } },
  { name: 'webkit-1440', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1000 } } }
]
```

- [ ] Install browser binaries with `pnpm exec playwright install` and run `pnpm test:e2e`.

Expected: all Phase 1 browser tests pass in all four projects.

- [ ] Run the phase gate:

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e && pnpm build
```

Expected: all commands exit `0`.

- [ ] Commit with `git commit -m "test: verify storefront journeys"`.

## Phase 1 handoff

Before Phase 2, record these concrete values in the deployment secret manager, not the repository: Stripe test secret key, paid Shipping Rate ID, and free Shipping Rate ID. Confirm at least one apparel Product and one accessory Product pass the catalog diagnostics in Stripe test mode.
