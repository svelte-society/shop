# Dynamic Destination Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Swedish reference pricing with a visible delivery-country selector, destination-specific storefront VAT projection, and a Stripe Checkout v2 contract based on EUR 20 net merchandise and EUR 8 net paid shipping.

**Architecture:** Stripe Price and Shipping Rate amounts remain the trusted net source. A pure domain module projects gross storefront amounts from a validated request-level destination; Stripe Automatic Tax and the complete Checkout address remain authoritative for payment. Checkout v2 freezes the selected country in SQLite, records explicit shipping tax and gross retail unit amounts, while retaining a version 1 normalization path for already-created Sessions.

**Tech Stack:** Node.js 24, pnpm 10, SvelteKit 2, Svelte 5 runes, TypeScript 6, Stripe SDK 22, SQLite/better-sqlite3, Vitest Browser Mode, Playwright, Docker/Coolify.

## Global Constraints

- Use Node.js and pnpm only; do not use Bun or npm.
- Do not use `smerch` for any part of the work.
- Every shell command in this workspace begins with `rtk`.
- Use `apply_patch` for source and documentation edits.
- Merchandise Prices are one-time EUR 20.00 (`unit_amount=2000`) with `tax_behavior=exclusive`.
- Paid shipping is EUR 8.00 net (`fixed_amount.amount=800`) with `tax_behavior=exclusive` and the Stripe Shipping tax code.
- Free shipping is EUR 0 with `tax_behavior=exclusive` for carts containing two or more total units.
- The supported destination list is the runtime `STYRIA_SUPPORTED_COUNTRIES` allowlist; Slovenia, the United States, and every destination outside that allowlist remain unavailable.
- Storefront VAT rates are server-owned basis points reviewed on 2026-07-22; Stripe Automatic Tax remains authoritative for the charge.
- The browser never supplies trusted amounts, VAT rates, Shipping Rate IDs, or Price metadata.
- Country state uses the `shop_destination_v1` first-party cookie and exact route `/preferences/destination`.
- Checkout v2 accepts exactly the selected delivery country.
- Promotion codes and discounts remain disabled.
- Preserve historical Stripe resources, v1 Sessions, orders, and provider identifiers.
- Do not write API keys, bearer tokens, customer PII, raw provider payloads, or authorization headers to source, plans, commits, test output, or logs.
- Keep the existing Svelte Society colour system and typography.
- Every implementation task follows red-green-refactor, runs focused tests, and ends in a commit.

---

## File Structure

### New files

- `src/lib/domain/pricing.ts` — VAT table, pricing types, integer-cent projection, cart projection, and display disclosures.
- `src/lib/domain/pricing.test.ts` — pure price and destination-rate contract tests.
- `src/lib/server/storefront/destination.server.ts` — request cookie/Cloudflare/fallback resolution and public option projection.
- `src/lib/server/storefront/destination.server.test.ts` — resolution precedence and allowlist tests.
- `src/routes/preferences/destination/+server.ts` — strict same-origin destination preference POST.
- `src/routes/preferences/destination/destination-route.test.ts` — cookie, redirect, and invalid-input route tests.
- `src/lib/components/DestinationPicker.svelte` — accessible delivery-country dialog.
- `src/lib/components/DestinationPicker.svelte.test.ts` — browser-component interaction and accessibility tests.
- `migrations/0007_dynamic_destination_pricing.sql` — frozen draft country, explicit shipping tax, and retail unit snapshots.
- `docs/operations/stripe-catalog.md` — operator contract and controlled Stripe/Coolify switch procedure.

### Primary modified files

- `src/lib/domain/destinations.ts`, `src/lib/domain/catalog.ts`, `src/lib/domain/money.ts`, `src/lib/domain/orders.ts`
- `src/lib/server/catalog/parse.ts`
- `src/routes/+layout.server.ts`, `src/routes/+layout.svelte`
- `src/lib/components/SiteHeader.svelte`, `ProductGrid.svelte`, `ProductCard.svelte`, `ProductPurchase.svelte`, `CartLineItem.svelte`, `CartSummary.svelte`
- `src/routes/+page.svelte`, `src/routes/products/[slug]/+page.svelte`, `src/routes/cart/+page.svelte`
- `src/lib/server/db/checkout-drafts.server.ts`, `src/lib/server/db/orders.server.ts`
- `src/lib/server/checkout/service.server.ts`, `src/routes/checkout/+server.ts`
- `src/lib/server/stripe/gateway.ts`, `checkout.server.ts`, `paid-checkout.ts`, `webhook.server.ts`
- `src/lib/server/styria/payload.ts`
- `src/lib/server/mcp/tools/inspect-order.ts`
- `src/lib/content/policies.ts`
- `.env.example`, `README.md`, `docs/operations/coolify.md`, `docs/operations/policy-review.md`, `docs/operations/styria-contract.md`
- Corresponding unit, integration, fixture, browser, and E2E files named in each task.

---

### Task 1: Destination Pricing Domain

**Files:**
- Create: `src/lib/domain/pricing.ts`
- Create: `src/lib/domain/pricing.test.ts`
- Modify: `src/lib/domain/destinations.ts`
- Modify: `src/lib/domain/destinations.test.ts`
- Modify: `src/lib/domain/money.ts`
- Modify: `src/lib/domain/money.test.ts`

**Interfaces:**
- Produces: `PricingDestination`, `DestinationOption`, `DisplayPrice`, `CartDisplayPrice`, `PAID_SHIPPING_NET_CENTS`, `displayPriceForDestination()`, `displayCartPrice()`, and `pricingDisclosure()`.
- Consumes: exported `EU_DESTINATIONS`, `ASIA_DESTINATIONS`, and `MarketDestination` from `destinations.ts`.

- [ ] **Step 1: Export the region lists and write failing destination-pricing tests**

Add tests that assert the exact approved examples and integer safety:

```ts
import { describe, expect, it } from 'vitest';
import {
	displayCartPrice,
	displayPriceForDestination,
	pricingDestination,
	VAT_TABLE_REVIEWED_AT
} from './pricing';

describe('destination pricing', () => {
	it.each([
		['SE', 2_500, 1_000, 3_500],
		['DE', 2_380, 952, 3_332],
		['FI', 2_510, 1_004, 3_514],
		['HU', 2_540, 1_016, 3_556],
		['JP', 2_000, 800, 2_800]
	] as const)('projects %s with integer cents', (country, merchandise, shipping, total) => {
		const destination = pricingDestination(country);
		expect(displayPriceForDestination(2_000, destination).grossCents).toBe(merchandise);
		expect(displayCartPrice([{ netUnitCents: 2_000, quantity: 1 }], destination)).toMatchObject({
			shipping: { grossCents: shipping },
			totalGrossCents: total
		});
	});

	it('keeps shipping free for two units', () => {
		expect(
			displayCartPrice([{ netUnitCents: 2_000, quantity: 2 }], pricingDestination('FI'))
		).toMatchObject({ shipping: { netCents: 0, vatCents: 0, grossCents: 0 } });
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER])('rejects unsafe cents %s', (cents) => {
		expect(() => displayPriceForDestination(cents, pricingDestination('SE'))).toThrowError(
			'INVALID_CENTS'
		);
	});

	it('records the VAT review date', () => expect(VAT_TABLE_REVIEWED_AT).toBe('2026-07-22'));
});
```

- [ ] **Step 2: Run the new tests and verify red**

Run: `rtk pnpm exec vitest run --project server src/lib/domain/pricing.test.ts src/lib/domain/destinations.test.ts src/lib/domain/money.test.ts`

Expected: FAIL because `pricing.ts` and the new exports do not exist.

- [ ] **Step 3: Implement the pure pricing contract**

Export the existing destination arrays and add this exact public shape:

```ts
export const PAID_SHIPPING_NET_CENTS = 800;
export const VAT_TABLE_REVIEWED_AT = '2026-07-22';
export const VAT_TABLE_SOURCE =
	'https://europa.eu/youreurope/business/finance-and-tax/vat/vat-rules-rates/index_en.htm';

export type DestinationRegion = 'eu' | 'asia';
export type PricingDestination = {
	countryCode: MarketDestination;
	displayName: string;
	region: DestinationRegion;
	vatBasisPoints: number;
	requiresImportChargeCopy: boolean;
};
export type DestinationOption = Pick<
	PricingDestination,
	'countryCode' | 'displayName' | 'region'
>;
export type DisplayPrice = { netCents: number; vatCents: number; grossCents: number };
export type CartDisplayPrice = {
	merchandise: DisplayPrice;
	shipping: DisplayPrice;
	totalNetCents: number;
	totalVatCents: number;
	totalGrossCents: number;
};

const EU_VAT_BASIS_POINTS = Object.freeze({
	AT: 2000, BE: 2100, BG: 2000, HR: 2500, CY: 1900, CZ: 2100,
	DK: 2500, EE: 2400, FI: 2550, FR: 2000, DE: 1900, GR: 2400,
	HU: 2700, IE: 2300, IT: 2200, LV: 2100, LT: 2100, LU: 1700,
	MT: 1800, NL: 2100, PL: 2300, PT: 2300, RO: 2100, SK: 2300,
	ES: 2100, SE: 2500
} satisfies Record<(typeof EU_DESTINATIONS)[number], number>);

export function pricingDestination(countryCode: MarketDestination): PricingDestination {
	const eu = (EU_DESTINATIONS as readonly string[]).includes(countryCode);
	const asia = (ASIA_DESTINATIONS as readonly string[]).includes(countryCode);
	if (!eu && !asia) throw new Error('PRICING_DESTINATION_INVALID');
	const displayName = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode);
	if (!displayName) throw new Error('PRICING_DESTINATION_INVALID');
	return {
		countryCode,
		displayName,
		region: eu ? 'eu' : 'asia',
		vatBasisPoints: eu ? EU_VAT_BASIS_POINTS[countryCode as keyof typeof EU_VAT_BASIS_POINTS] : 0,
		requiresImportChargeCopy: !eu
	};
}

export function displayPriceForDestination(
	netCents: number,
	destination: PricingDestination
): DisplayPrice {
	if (!Number.isSafeInteger(netCents) || netCents < 0) throw new Error('INVALID_CENTS');
	const numerator = BigInt(netCents) * BigInt(10_000 + destination.vatBasisPoints);
	const gross = (numerator + 5_000n) / 10_000n;
	if (gross > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_CENTS');
	const grossCents = Number(gross);
	return { netCents, vatCents: grossCents - netCents, grossCents };
}

function safeCents(value: bigint): number {
	if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_CENTS');
	return Number(value);
}

export function displayCartPrice(
	lines: readonly { netUnitCents: number; quantity: number }[],
	destination: PricingDestination
): CartDisplayPrice {
	let units = 0;
	let merchandiseNet = 0n;
	for (const line of lines) {
		if (
			!Number.isSafeInteger(line.netUnitCents) || line.netUnitCents < 0 ||
			!Number.isSafeInteger(line.quantity) || line.quantity < 1
		) throw new Error('INVALID_CENTS');
		units += line.quantity;
		if (!Number.isSafeInteger(units)) throw new Error('INVALID_CENTS');
		merchandiseNet += BigInt(line.netUnitCents) * BigInt(line.quantity);
	}
	const merchandise = displayPriceForDestination(safeCents(merchandiseNet), destination);
	const shipping = displayPriceForDestination(units === 1 ? PAID_SHIPPING_NET_CENTS : 0, destination);
	return {
		merchandise,
		shipping,
		totalNetCents: safeCents(BigInt(merchandise.netCents) + BigInt(shipping.netCents)),
		totalVatCents: safeCents(BigInt(merchandise.vatCents) + BigInt(shipping.vatCents)),
		totalGrossCents: safeCents(BigInt(merchandise.grossCents) + BigInt(shipping.grossCents))
	};
}

function formatVatRate(basisPoints: number): string {
	return basisPoints % 100 === 0 ? String(basisPoints / 100) : (basisPoints / 100).toFixed(1);
}

export function pricingDisclosure(destination: PricingDestination): string {
	return destination.region === 'eu'
		? `Includes ${formatVatRate(destination.vatBasisPoints)}% ${destination.displayName} VAT. Exact tax is confirmed from your delivery address at checkout.`
		: 'EU VAT excluded. Import VAT, duties, brokerage, or carrier fees may be charged on arrival.';
}
```

Remove `swedishReferenceGrossCents` from `money.ts` and its tests; `formatEur` remains unchanged.

- [ ] **Step 4: Run focused tests and verify green**

Run: `rtk pnpm exec vitest run --project server src/lib/domain/pricing.test.ts src/lib/domain/destinations.test.ts src/lib/domain/money.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
rtk git add src/lib/domain/destinations.ts src/lib/domain/destinations.test.ts src/lib/domain/money.ts src/lib/domain/money.test.ts src/lib/domain/pricing.ts src/lib/domain/pricing.test.ts
rtk git commit -m "feat: add destination pricing domain"
```

---

### Task 2: Request Destination Resolution and Preference Endpoint

**Files:**
- Create: `src/lib/server/storefront/destination.server.ts`
- Create: `src/lib/server/storefront/destination.server.test.ts`
- Create: `src/routes/preferences/destination/+server.ts`
- Create: `src/routes/preferences/destination/destination-route.test.ts`
- Modify: `src/routes/+layout.server.ts`
- Modify: `src/routes/layout.server.test.ts`

**Interfaces:**
- Consumes: `pricingDestination()`, `DestinationOption`, and `parseStyriaSupportedCountries()`.
- Produces: `DESTINATION_COOKIE`, `resolvePricingDestination()`, `destinationOptions()`, and layout fields `pricingDestination`/`destinationOptions`.

- [ ] **Step 1: Write failing resolver, route, and layout tests**

Cover explicit-cookie precedence, supported Cloudflare hint, invalid hint, Sweden fallback, runtime removal, strict form fields, open-redirect rejection, and cookie flags. Use this core assertion:

```ts
expect(
	resolvePricingDestination({
		cookieValue: 'DE',
		cloudflareCountry: 'JP',
		allowedCountries: ['SE', 'DE', 'JP']
	})
).toMatchObject({ countryCode: 'DE', source: 'cookie', vatBasisPoints: 1900 });
```

The route test must assert `country=DE&returnTo=%2Fcart` returns `303`, `Location: /cart`, and a `shop_destination_v1=DE` cookie with `Path=/`, `Max-Age=31536000`, `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Reject `//evil.example`, absolute URLs, duplicate fields, missing fields, lowercase/unsupported countries, and payloads over 4 KiB.

- [ ] **Step 2: Run focused tests and verify red**

Run: `rtk pnpm exec vitest run --project server src/lib/server/storefront/destination.server.test.ts src/routes/preferences/destination/destination-route.test.ts src/routes/layout.server.test.ts`

Expected: FAIL because resolver and route do not exist and layout lacks pricing data.

- [ ] **Step 3: Implement deterministic server resolution**

Use these signatures:

```ts
export const DESTINATION_COOKIE = 'shop_destination_v1';
export type DestinationSource = 'cookie' | 'cloudflare_hint' | 'fallback';
export type ResolvedPricingDestination = PricingDestination & { source: DestinationSource };

export function resolvePricingDestination(input: {
	cookieValue: string | undefined;
	cloudflareCountry: string | null;
	allowedCountries: readonly MarketDestination[];
}): ResolvedPricingDestination;

export function destinationOptions(
	allowedCountries: readonly MarketDestination[]
): readonly DestinationOption[];
```

Require Sweden in the runtime allowlist so the approved fallback is always possible. Accept a cookie or Cloudflare code only when it is exact uppercase ASCII and present in the runtime list. Sort options by region (`eu` first) and English display name. Do not expose `source` through layout data.

- [ ] **Step 4: Implement strict POST and root layout data**

The endpoint must parse `request.formData()`, require exactly one `country` and one `returnTo`, validate the destination against `parseStyriaSupportedCountries(runtimeEnv.STYRIA_SUPPORTED_COUNTRIES)`, and validate `returnTo` with:

```ts
function safeReturnPath(value: string): string | null {
	if (value.length < 1 || value.length > 2_048 || !value.startsWith('/') || value.startsWith('//')) {
		return null;
	}
	const parsed = new URL(value, 'https://shop.invalid');
	return parsed.origin === 'https://shop.invalid'
		? `${parsed.pathname}${parsed.search}${parsed.hash}`
		: null;
}
```

Set the cookie with SvelteKit `cookies.set()` and return an empty `303` Response. In `_createLayoutServerLoad`, destructure `{ route, cookies, request, depends }`, call `depends('app:pricing-destination')`, resolve from the cookie and `request.headers.get('cf-ipcountry')`, and return the public destination plus options alongside existing data.

- [ ] **Step 5: Run tests and verify green**

Run: `rtk pnpm exec vitest run --project server src/lib/server/storefront/destination.server.test.ts src/routes/preferences/destination/destination-route.test.ts src/routes/layout.server.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
rtk git add src/lib/server/storefront/destination.server.ts src/lib/server/storefront/destination.server.test.ts src/routes/preferences/destination src/routes/+layout.server.ts src/routes/layout.server.test.ts
rtk git commit -m "feat: resolve delivery country per request"
```

---

### Task 3: Accessible Header Destination Picker

**Files:**
- Create: `src/lib/components/DestinationPicker.svelte`
- Create: `src/lib/components/DestinationPicker.svelte.test.ts`
- Modify: `src/lib/components/SiteHeader.svelte`
- Modify: `src/lib/components/SiteHeader.svelte.test.ts`
- Modify: `src/routes/+layout.svelte`
- Modify: `src/routes/layout.svelte.test.ts`

**Interfaces:**
- Consumes: `PricingDestination`, `DestinationOption`, `DESTINATION_COOKIE` endpoint behavior, and the layout dependency key `app:pricing-destination`.
- Produces: header interaction before Cart with props `{ destination, destinations, returnTo }`.

- [ ] **Step 1: Write failing browser-component tests**

Assert the visible trigger `Deliver to: Sweden`, accessible name `Choose delivery country, currently Sweden`, EU/Asia group headings, search filtering, current radio selection, native form action, Escape close, trigger focus restoration, and minimum 44px trigger/option height. Add a SiteHeader test that verifies the destination control precedes the Cart link in DOM order.

- [ ] **Step 2: Run tests and verify red**

Run: `rtk pnpm exec vitest run --project client src/lib/components/DestinationPicker.svelte.test.ts src/lib/components/SiteHeader.svelte.test.ts src/routes/layout.svelte.test.ts`

Expected: FAIL because the picker and props do not exist.

- [ ] **Step 3: Implement the native dialog and enhanced form**

Use this public component contract and state:

```svelte
<script lang="ts">
	import { invalidate } from '$app/navigation';
	import type { DestinationOption, PricingDestination } from '$lib/domain/pricing';

	type Props = {
		destination: PricingDestination;
		destinations: readonly DestinationOption[];
		returnTo: string;
	};
	let { destination, destinations, returnTo }: Props = $props();
	let dialog: HTMLDialogElement;
	let trigger: HTMLButtonElement;
	let query = $state('');
	let pending = $state(false);
	let announcement = $state('');
	let filtered = $derived(
		destinations.filter((option) => option.displayName.toLowerCase().includes(query.trim().toLowerCase()))
	);

	async function submit(event: SubmitEvent): Promise<void> {
		if (!(event.currentTarget instanceof HTMLFormElement) || !globalThis.fetch) return;
		event.preventDefault();
		const form = event.currentTarget;
		const selectedCode = String(new FormData(form).get('country') ?? '');
		const selected = destinations.find((option) => option.countryCode === selectedCode);
		if (!selected) return;
		pending = true;
		const response = await fetch(form.action, {
			method: 'POST', body: new FormData(form), redirect: 'follow'
		});
		if (!response.ok) { pending = false; return; }
		dialog.close();
		await invalidate('app:pricing-destination');
		announcement = `Prices updated for ${selected.displayName}.`;
		pending = false;
	}
</script>
```

Render a trigger, `<dialog aria-labelledby="destination-title">`, labelled search input, `fieldset`/`legend` groups, radio inputs named `country`, hidden `returnTo`, Cancel and `Update country` buttons. On close, clear search and call `trigger.focus()`. The enhanced announcement uses the validated selected option and never announces the previous country.

CSS requirements are exact: trigger/options/buttons `min-height:2.75rem`; desktop dialog anchored visually below the header at max width `32rem`; at `max-width:44rem` use `width:100%`, bottom-aligned sheet layout, and no horizontal overflow; `::backdrop` uses a translucent ink colour; `prefers-reduced-motion: reduce` removes transition/animation.

- [ ] **Step 4: Wire the root layout and header**

In `+layout.svelte`, derive `returnTo` from `$app/state` as `${page.url.pathname}${page.url.search}` and pass layout data to SiteHeader. SiteHeader receives:

```ts
type Props = {
	destination: PricingDestination;
	destinations: readonly DestinationOption[];
	returnTo: string;
};
```

Render `<DestinationPicker>` immediately before the Cart link in primary navigation. Keep Svelte Society branding and existing colour tokens.

- [ ] **Step 5: Run component tests, check, and verify green**

Run: `rtk pnpm exec vitest run --project client src/lib/components/DestinationPicker.svelte.test.ts src/lib/components/SiteHeader.svelte.test.ts src/routes/layout.svelte.test.ts && rtk pnpm check`

Expected: PASS with no Svelte accessibility warnings.

- [ ] **Step 6: Commit**

```sh
rtk git add src/lib/components/DestinationPicker.svelte src/lib/components/DestinationPicker.svelte.test.ts src/lib/components/SiteHeader.svelte src/lib/components/SiteHeader.svelte.test.ts src/routes/+layout.svelte src/routes/layout.svelte.test.ts
rtk git commit -m "feat: add delivery country picker"
```

---

### Task 4: Net Catalog Contract and Destination-Neutral Public Data

**Files:**
- Modify: `src/lib/domain/catalog.ts`
- Modify: `src/lib/server/catalog/parse.ts`
- Modify: `src/lib/server/catalog/parse.test.ts`
- Modify: `src/lib/server/catalog/service.test.ts`
- Modify: `src/lib/server/checkout/service.test.ts`
- Modify: `tests/fixtures/stripe-catalog.ts`
- Modify every source/test fixture returned by `rtk rg -l referenceGrossCents src tests`

**Interfaces:**
- Consumes: `unitAmountCents` from Stripe and the approved EUR 20 catalog contract.
- Produces: `CatalogVariant`/`PublicCatalogVariant` without `referenceGrossCents`.

- [ ] **Step 1: Change tests to expect net-only variants**

Replace fixtures shaped like:

```ts
{ unitAmountCents: 2_000, referenceGrossCents: 2_500 }
```

with:

```ts
{ unitAmountCents: 2_000 }
```

Add a parser test that a one-time EUR exclusive Price with `unit_amount: 2_001` produces `PRICE_AMOUNT_INVALID`, and retain tests rejecting inclusive/unspecified tax behavior.

- [ ] **Step 2: Run catalog tests and verify red**

Run: `rtk pnpm exec vitest run --project server src/lib/server/catalog/parse.test.ts src/lib/server/catalog/service.test.ts src/lib/server/checkout/service.test.ts`

Expected: FAIL because catalog types and parser still emit Swedish gross references and accept other amounts.

- [ ] **Step 3: Remove Swedish projection and enforce the approved source amount**

Delete `referenceGrossCents` from `CatalogVariant`, its exact-key validator, clone/public conversion, and all consumers. In `parse.ts`, keep the existing one-time EUR exclusive checks and add:

```ts
if (source.unit_amount !== 2_000) {
	add(source.id, 'PRICE_AMOUNT_INVALID');
	continue;
}
```

Return only `unitAmountCents: source.unit_amount`. Update the test Stripe catalog so every active purchasable fixture Price is 2_000; retain deliberately invalid fixtures only in diagnostic scenarios.

- [ ] **Step 4: Run the reference scan and focused tests**

Run: `rtk rg referenceGrossCents src tests`

Expected: no matches.

Run: `rtk pnpm exec vitest run --project server src/lib/server/catalog/parse.test.ts src/lib/server/catalog/service.test.ts src/lib/server/checkout/service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
rtk git add src/lib/domain/catalog.ts src/lib/server/catalog/parse.ts src/lib/server/catalog/parse.test.ts src/lib/server/catalog/service.test.ts src/lib/server/checkout/service.test.ts tests/fixtures/stripe-catalog.ts src/lib/components src/routes
rtk git commit -m "refactor: keep catalog prices net"
```

---

### Task 5: Destination-Specific Product and Cart Presentation

**Files:**
- Modify: `src/lib/domain/pricing.ts`
- Modify: `src/lib/domain/pricing.test.ts`
- Modify: `src/lib/components/ProductGrid.svelte`
- Modify: `src/lib/components/ProductCard.svelte`
- Modify: `src/lib/components/ProductPurchase.svelte`
- Modify: `src/lib/components/CartLineItem.svelte`
- Modify: `src/lib/components/CartSummary.svelte`
- Modify: `src/routes/+page.svelte`
- Modify: `src/routes/products/[slug]/+page.svelte`
- Modify: `src/routes/cart/+page.svelte`
- Modify corresponding component/page tests listed in the design.

**Interfaces:**
- Consumes: net `PublicCatalogVariant`, `PricingDestination`, `DisplayPrice`, `CartDisplayPrice`.
- Produces: destination-priced product/card/cart view models; components render supplied `DisplayPrice` rather than recomputing hidden tax rules.

- [ ] **Step 1: Write failing SE/DE/JP component tests**

Assert a net 2_000 variant renders EUR 25.00 for SE, EUR 23.80 for DE, and EUR 20.00 plus import-charge copy for JP. Assert a one-unit German cart shows merchandise EUR 23.80, shipping EUR 9.52, VAT EUR 5.32, total EUR 33.32; a two-unit cart shows free shipping.

- [ ] **Step 2: Run component tests and verify red**

Run: `rtk pnpm exec vitest run --project client src/lib/components/ProductCard.svelte.test.ts src/lib/components/ProductPurchase.svelte.test.ts src/lib/components/CartSummary.svelte.test.ts src/routes/products/'[slug]'/page.svelte.test.ts src/routes/cart/checkout-page.svelte.test.ts`

Expected: FAIL because components still consume `referenceGrossCents` or lack destination display data.

- [ ] **Step 3: Add explicit priced view models**

Add these helpers to `pricing.ts`:

```ts
export type PricedPublicCatalogVariant = PublicCatalogVariant & { displayPrice: DisplayPrice };
export type PricedPublicCatalogProduct = Omit<PublicCatalogProduct, 'variants'> & {
	variants: PricedPublicCatalogVariant[];
};

export function pricePublicProduct(
	product: PublicCatalogProduct,
	destination: PricingDestination
): PricedPublicCatalogProduct {
	return {
		...product,
		variants: product.variants.map((variant) => ({
			...variant,
			displayPrice: displayPriceForDestination(variant.unitAmountCents, destination)
		}))
	};
}
```

ProductGrid receives raw products plus destination, derives priced products once, and ProductCard receives `PricedPublicCatalogProduct`. Product detail derives one priced product and ProductPurchase receives it. Cart derives `unitDisplayPrice`, `lineDisplayPrice`, and one `CartDisplayPrice`; CartLineItem and CartSummary receive those values.

- [ ] **Step 4: Replace public copy and amounts**

Render gross cents as the primary amount. ProductPurchase renders `pricingDisclosure(destination)`. CartSummary rows are exactly `Merchandise`, `Shipping`, `VAT` for EU or `EU VAT` with EUR 0 for Asia, and `Estimated total`; supporting text names the selected delivery country and Checkout authority. Homepage Shipping uses the projected EUR 8 rate and Tax uses the same disclosure. Remove `Reference price`, `Reference subtotal`, Swedish VAT reference copy, and hard-coded `€10`.

For stale cart lines, when `catalogUnavailable` is false, remove unresolved old Price IDs on mount and show `A product price changed. Please add the item again.` with a collection link; do not silently map old IDs to new IDs. When the catalog itself is unavailable, preserve the cart unchanged and keep the existing retry state.

- [ ] **Step 5: Run focused tests and check**

Run: `rtk pnpm exec vitest run --project client src/lib/components/ProductCard.svelte.test.ts src/lib/components/ProductPurchase.svelte.test.ts src/lib/components/CatalogComponents.svelte.test.ts src/lib/components/ContrastSemantics.svelte.test.ts src/lib/components/CartSummary.svelte.test.ts src/routes/products/'[slug]'/page.svelte.test.ts src/routes/cart/checkout-page.svelte.test.ts && rtk pnpm check`

Expected: PASS and no `referenceGrossCents`, Swedish reference, or hard-coded `€10` matches in `src`.

- [ ] **Step 6: Commit**

```sh
rtk git add src/lib/domain/pricing.ts src/lib/domain/pricing.test.ts src/lib/components src/routes
rtk git commit -m "feat: show destination-specific storefront prices"
```

---

### Task 6: Durable Pricing Snapshot Schema

**Files:**
- Create: `migrations/0007_dynamic_destination_pricing.sql`
- Modify: `src/lib/domain/orders.ts`
- Modify: `src/lib/server/db/checkout-drafts.server.ts`
- Modify: `src/lib/server/db/orders.server.ts`
- Modify: `src/lib/server/db/schema.test.ts`
- Modify: `src/lib/server/db/migrate.test.ts`
- Modify: `src/lib/server/db/repositories.test.ts`
- Modify: `src/lib/server/health/readiness.test.ts`
- Modify: `src/lib/server/jobs/scheduler.test.ts`
- Modify raw SQL fixtures identified by `rtk rg -l "INSERT INTO (checkout_drafts|orders|order_lines)" src tests`.

**Interfaces:**
- Produces: `NewCheckoutDraft.destinationCountry`, `OrderAmounts.shippingTax`, `PaidOrderLineAmount`, and `OrderLine.retailUnitAmount`.
- Preserves: v1 drafts may have a null database destination; every v2 draft must have a supported destination.

- [ ] **Step 1: Write failing migration and repository tests**

Test that migration:

- adds nullable `checkout_drafts.destination_country` and backfills it from existing orders;
- adds non-null `orders.shipping_tax_amount` and backfills a historical SE row correctly;
- adds non-null `order_lines.retail_unit_amount` and backfills it from `unit_amount`;
- aborts on a historical row whose merchandise/shipping tax relationship is negative;
- requires new v2 drafts to contain an allowed destination;
- round-trips explicit shipping tax and retail unit amounts.

- [ ] **Step 2: Run database tests and verify red**

Run: `rtk pnpm exec vitest run --project server src/lib/server/db/schema.test.ts src/lib/server/db/migrate.test.ts src/lib/server/db/repositories.test.ts`

Expected: FAIL because migration and fields do not exist.

- [ ] **Step 3: Add the schema migration with guarded backfill**

Use this migration shape:

```sql
ALTER TABLE checkout_drafts ADD COLUMN destination_country TEXT
  CHECK (destination_country IS NULL OR (length(destination_country) = 2 AND destination_country = upper(destination_country)));

UPDATE checkout_drafts
SET destination_country = (
  SELECT destination_country FROM orders WHERE orders.checkout_draft_id = checkout_drafts.id
)
WHERE EXISTS (SELECT 1 FROM orders WHERE orders.checkout_draft_id = checkout_drafts.id);

ALTER TABLE orders ADD COLUMN shipping_tax_amount INTEGER NOT NULL DEFAULT 0
  CHECK (shipping_tax_amount >= 0);

CREATE TABLE _pricing_migration_guard (invalid_count INTEGER NOT NULL CHECK (invalid_count = 0));
INSERT INTO _pricing_migration_guard
SELECT count(*) FROM orders
WHERE total_amount - (subtotal_amount - discount_amount) - shipping_amount < 0
   OR tax_amount - (total_amount - (subtotal_amount - discount_amount) - shipping_amount) < 0
   OR tax_amount - (total_amount - (subtotal_amount - discount_amount) - shipping_amount) > shipping_amount;

UPDATE orders
SET shipping_tax_amount = tax_amount -
  (total_amount - (subtotal_amount - discount_amount) - shipping_amount);
DROP TABLE _pricing_migration_guard;

ALTER TABLE order_lines ADD COLUMN retail_unit_amount INTEGER NOT NULL DEFAULT 0
  CHECK (retail_unit_amount >= 0);
UPDATE order_lines SET retail_unit_amount = unit_amount;
```

- [ ] **Step 4: Extend domain and repositories**

Add:

```ts
export type NewCheckoutDraft = {
	contractVersion: number;
	destinationCountry: MarketDestination;
	currency: 'eur';
	totalUnitCount: number;
	shippingMode: ShippingMode;
	createdAt: Date;
	expiresAt: Date;
	lines: NewCheckoutDraftLine[];
};
export type CheckoutDraft = Omit<
	NewCheckoutDraft,
	'lines' | 'destinationCountry'
> & {
	id: string;
	destinationCountry: MarketDestination | null;
	checkoutSessionId: string | null;
	completedAt: Date | null;
};
export type OrderAmounts = {
	subtotal: number;
	discount: number;
	shipping: number;
	shippingTax: number;
	tax: number;
	total: number;
};
export type PaidOrderLineAmount = {
	stripePriceId: string;
	quantity: number;
	unitAmount: number;
	retailUnitAmount: number;
};
export type PaidOrderInput = {
	checkoutSessionId: string;
	paymentIntentId: string;
	customerId: string;
	checkoutDraftId: string;
	currency: 'eur';
	amounts: OrderAmounts;
	destinationCountry: string;
	updatedAt: Date;
	lines: PaidOrderLineAmount[];
};
export type OrderLine = CheckoutDraftLine & {
	orderId: string;
	retailUnitAmount: number;
};
```

Validate the durable invariant with BigInt:

```ts
const merchandiseTax = BigInt(tax) - BigInt(shippingTax);
const expectedTotal = BigInt(subtotal) - BigInt(discount) + merchandiseTax + BigInt(shipping);
if (merchandiseTax < 0n || shippingTax > shipping || expectedTotal !== BigInt(total)) {
	fail('PAID_ORDER_INVALID');
}
```

Require a v2 draft destination, map v1 null rows without inventing a frozen country, and insert every new amount explicitly rather than relying on defaults. Reject a new v2 draft when its destination is absent from the runtime Styria allowlist.

- [ ] **Step 5: Update raw fixtures deliberately**

For historical v1 fixtures, keep gross shipping and compute its included shipping tax. For v2 fixtures use destination country, gross customer shipping, explicit shipping tax, and gross retail unit amount. Do not mechanically replace every `1000` with `800`.

- [ ] **Step 6: Run database tests and verify green**

Run: `rtk pnpm exec vitest run --project server src/lib/server/db/schema.test.ts src/lib/server/db/migrate.test.ts src/lib/server/db/repositories.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
rtk git add migrations/0007_dynamic_destination_pricing.sql src/lib/domain/orders.ts src/lib/server/db src/lib/server/fulfillment src/lib/server/jobs src/lib/server/mcp/runtime.test.ts tests/integration tests/fixtures
rtk git commit -m "feat: persist pricing tax snapshots"
```

---

### Task 7: Checkout Contract v2 and Frozen Country

**Files:**
- Modify: `src/lib/server/stripe/gateway.ts`
- Modify: `src/lib/server/stripe/checkout.server.ts`
- Create: `src/lib/server/stripe/checkout.test.ts`
- Modify: `src/lib/server/checkout/service.server.ts`
- Modify: `src/lib/server/checkout/service.test.ts`
- Modify: `src/routes/checkout/+server.ts`
- Modify: `src/routes/checkout/checkout-route.test.ts`

**Interfaces:**
- Consumes: request-resolved `PricingDestination`, draft destination persistence, catalog net amounts.
- Produces: `CHECKOUT_CONTRACT_VERSION = 2`, metadata destination, and a one-country Stripe Session.

- [ ] **Step 1: Write failing checkout v2 tests**

Assert checkout reads the validated destination cookie rather than request JSON, stores `destinationCountry: 'DE'`, passes `allowed_countries: ['DE']`, sets contract version 2 and `destination_country: DE` metadata, chooses configured paid/free Shipping Rate by quantity, and rejects missing/unsupported destination configuration before provider work.

- [ ] **Step 2: Run checkout tests and verify red**

Run: `rtk pnpm exec vitest run --project server src/lib/server/checkout/service.test.ts src/routes/checkout/checkout-route.test.ts`

Expected: FAIL because checkout still sends the full country allowlist and contract version 1.

- [ ] **Step 3: Update gateway and service signatures**

Use:

```ts
export const CHECKOUT_CONTRACT_VERSION = 2;
export type CreateCheckoutInput = {
	draftId: string;
	destinationCountry: string;
	lines: Array<{ priceId: string; quantity: number }>;
	shippingRateId: string;
	successUrl: string;
	cancelUrl: string;
};
export interface CheckoutService {
	start(input: unknown, destinationCountry: MarketDestination): Promise<{ redirectUrl: string }>;
}
```

Store the destination in the draft. Gateway metadata includes `destination_country`, and `shipping_address_collection.allowed_countries` is exactly `[input.destinationCountry]`.

- [ ] **Step 4: Resolve destination in the route**

The POST handler receives `{ request, cookies }`, parses the same runtime country allowlist used by layout, calls the shared resolver using cookie and `cf-ipcountry`, then calls `service.start(input, destination.countryCode)`. Browser JSON remains cart lines only; any `country`, `amount`, or `vat` keys are rejected by the existing strict cart parser.

- [ ] **Step 5: Run checkout tests and verify green**

Run: `rtk pnpm exec vitest run --project server src/lib/server/checkout/service.test.ts src/routes/checkout/checkout-route.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
rtk git add src/lib/server/stripe/gateway.ts src/lib/server/stripe/checkout.server.ts src/lib/server/checkout src/routes/checkout
rtk git commit -m "feat: freeze destination in checkout v2"
```

---

### Task 8: Versioned Stripe Paid-Checkout Normalization

**Files:**
- Modify: `src/lib/server/stripe/gateway.ts`
- Modify: `src/lib/server/stripe/paid-checkout.ts`
- Modify: `src/lib/server/stripe/paid-checkout.test.ts`
- Modify: `tests/fixtures/stripe-paid-checkout.ts`
- Modify: `tests/integration/checkout-webhook.spec.ts`
- Modify: `src/routes/checkout/success/page.server.test.ts`

**Interfaces:**
- Produces: `PaidCheckoutSnapshot.contractVersion`, `amounts.shippingTax`, and line `retailUnitAmount`.
- Preserves: complete v1 inclusive-shipping normalization for historical Sessions.

- [ ] **Step 1: Split fixtures and write the v2 matrix first**

Keep the existing v1 builder unchanged in meaning. Add `paidCheckoutV2Fixture()` that creates exclusive shipping with `amount_subtotal=800`, destination tax, `amount_total=subtotal+tax`, version 2 metadata, and full line tax totals. Add SE/DE/FI/HU/JP cases with expected totals from the approved spec, plus free shipping, reverse charge, destination mismatch, inclusive-v2 shipping rejection, line non-divisibility, hidden shipping tax, and cross-version draft mismatch.

- [ ] **Step 2: Run the paid-checkout suite and verify red**

Run: `rtk pnpm exec vitest run --project server src/lib/server/stripe/paid-checkout.test.ts`

Expected: FAIL because only the v1 mixed-tax contract exists.

- [ ] **Step 3: Expand the normalized snapshot**

Use:

```ts
export type PaidCheckoutSnapshot = {
	contractVersion: 1 | 2;
	// existing provider fields
	amounts: {
		subtotal: number;
		discount: number;
		shipping: number;
		shippingTax: number;
		tax: number;
		total: number;
	};
	lines: Array<{
		priceId: string;
		quantity: number;
		unitAmount: number;
		retailUnitAmount: number;
	}>;
};
```

Parse metadata into `{ draftId, contractVersion, destinationCountry }` without assuming the current version. Dispatch to `normalizePaidCheckoutV1` or `normalizePaidCheckoutV2`.

- [ ] **Step 4: Preserve v1 and implement v2 exclusive reconciliation**

For v1, retain the current inclusive Shipping Rate checks, derive `shippingTax` from `shipping_cost.amount_tax`, and set historical `retailUnitAmount = unitAmount`.

For v2, require:

```ts
rate.type === 'fixed_amount';
rate.tax_behavior === 'exclusive';
rate.fixed_amount.currency === 'eur';
rate.fixed_amount.amount === (shippingMode === 'paid' ? 800 : 0);
shipping.amount_total === shipping.amount_subtotal + shipping.amount_tax;
providerTax === lineTax + shipping.amount_tax;
providerTotal === merchandiseTotal + shipping.amount_total;
session.total_details.amount_shipping === shipping.amount_subtotal;
```

Set persisted `shipping` to `shipping_cost.amount_total` and `shippingTax` to `shipping_cost.amount_tax`. With discounts zero, require `line.amount_total % line.quantity === 0` and set `retailUnitAmount = line.amount_total / line.quantity`.

`comparePaidCheckout()` first requires draft version equality. V2 also requires paid destination equals `draft.destinationCountry`; v1 retains the historical allowlist comparison.

- [ ] **Step 5: Run paid-checkout and webhook integration tests**

Run: `rtk pnpm exec vitest run --project server src/lib/server/stripe/paid-checkout.test.ts && rtk pnpm exec vitest run --config vitest.integration.config.ts tests/integration/checkout-webhook.spec.ts`

Expected: PASS for retained v1 and new v2 cases.

- [ ] **Step 6: Commit**

```sh
rtk git add src/lib/server/stripe/gateway.ts src/lib/server/stripe/paid-checkout.ts src/lib/server/stripe/paid-checkout.test.ts tests/fixtures/stripe-paid-checkout.ts tests/integration/checkout-webhook.spec.ts
rtk git commit -m "feat: normalize paid checkout v2"
```

---

### Task 9: Order Commit, Styria Retail Price, and MCP Inspection

**Files:**
- Modify: `src/lib/server/stripe/webhook.server.ts`
- Modify: `src/lib/server/stripe/webhook.test.ts`
- Modify: `src/lib/server/db/orders.server.ts`
- Modify: `src/lib/server/db/repositories.test.ts`
- Modify: `src/lib/server/styria/payload.ts`
- Modify: `src/lib/server/styria/payload.test.ts`
- Modify: `src/lib/server/fulfillment/reconcile.server.ts`
- Modify: `src/lib/server/fulfillment/reconcile.test.ts`
- Modify: `src/lib/server/mcp/tools/inspect-order.ts`
- Modify: `src/lib/server/mcp/tools/tools.test.ts`
- Modify fulfillment/order fixtures that construct `OrderWithLines`.

**Interfaces:**
- Consumes: verified paid snapshot lines and explicit `shippingTax`.
- Produces: immutable `retail_unit_amount`, Styria gross `retailPrice`, and unambiguous MCP fields.

- [ ] **Step 1: Write failing persistence/provider/MCP tests**

Assert webhook passes paid line amounts into the unit of work, repository writes one retail amount per exact draft Price/quantity, idempotent replay rejects conflicting retail values, Styria uses 2_380 for a German EUR 20 line as `23.8`, and MCP output includes `shipping_tax`, existing net `unit_amount`, and `retail_unit_amount`.

- [ ] **Step 2: Run focused tests and verify red**

Run: `rtk pnpm exec vitest run --project server src/lib/server/stripe/webhook.test.ts src/lib/server/db/repositories.test.ts src/lib/server/styria/payload.test.ts src/lib/server/mcp/tools/tools.test.ts`

Expected: FAIL because paid line amounts are not persisted or exposed.

- [ ] **Step 3: Persist the verified line mapping transactionally**

Webhook maps:

```ts
lines: paid.lines.map(({ priceId, quantity, unitAmount, retailUnitAmount }) => ({
	stripePriceId: priceId,
	quantity,
	unitAmount,
	retailUnitAmount
}))
```

In `SqlitePaidOrderUnitOfWork`, match each paid line one-to-one with its draft line by Price ID, quantity, and net unit amount before inserting. Insert draft snapshot fields plus explicit `retail_unit_amount`; reject missing, duplicate, reordered-conflicting, or extra lines with `ORDER_LINE_CONFLICT`. Include `shippingTax` and line retail amounts in idempotent commercial-data comparison.

- [ ] **Step 4: Change Styria and MCP semantics**

Replace:

```ts
retailPrice: line.unitAmount / 100
```

with:

```ts
retailPrice: line.retailUnitAmount / 100
```

Use `line.retailUnitAmount` in `fulfillment/reconcile.server.ts` when comparing expected provider `retailPrice`, so valid v2 orders do not fail reconciliation.

In `inspect-order.ts`, output payment amounts as:

```ts
amounts: {
	subtotal: v.number(), discount: v.number(), shipping: v.number(),
	shipping_tax: v.number(), tax: v.number(), total: v.number()
}
```

Keep the compatibility field `unit_amount` as the net Stripe amount and add `retail_unit_amount` as the customer-facing gross amount. Update the tool description and tests to state that both values are integer cents; do not silently change the meaning of the existing field.

- [ ] **Step 5: Run focused tests and check**

Run: `rtk pnpm exec vitest run --project server src/lib/server/stripe/webhook.test.ts src/lib/server/db/repositories.test.ts src/lib/server/styria/payload.test.ts src/lib/server/mcp/tools/tools.test.ts && rtk pnpm check`

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
rtk git add src/lib/server/stripe/webhook.server.ts src/lib/server/stripe/webhook.test.ts src/lib/server/db/orders.server.ts src/lib/server/db/repositories.test.ts src/lib/server/styria src/lib/server/mcp src/lib/server/fulfillment src/lib/server/jobs
rtk git commit -m "feat: preserve customer retail prices"
```

---

### Task 10: Policy Copy and End-to-End Storefront Coverage

**Files:**
- Modify: `src/lib/content/policies.ts`
- Modify: `src/lib/content/policies.test.ts`
- Modify: `playwright.config.ts`
- Modify: `tests/fixtures/catalog-server.ts`
- Modify: `tests/e2e/storefront.spec.ts`
- Modify: `tests/e2e/cart.spec.ts`
- Modify: `tests/e2e/checkout.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/integration/test-catalog-command-portability.test.ts`

**Interfaces:**
- Consumes: completed destination UI and v2 fixtures.
- Produces: public destination-aware terms and browser acceptance coverage.

- [ ] **Step 1: Write failing policy assertions**

Require exact concepts: `EUR 8 excluding tax`, free shipping for `two or more total units`, `Deliver to`, selected EU standard VAT, exact Checkout tax, selected non-EU EU-VAT exclusion, recipient import charges, and that changing country can change displayed price. Assert `EUR 10` and `Swedish VAT reference` are absent.

- [ ] **Step 2: Update policy prose**

Shipping policy text becomes:

```text
All store prices and charges are in EUR. The country shown in “Deliver to” controls the storefront tax projection.
Shipping is EUR 8 excluding tax when an order contains one total unit and is free for two or more total units. For an EU destination, the storefront displays shipping with that country’s standard VAT projection.
For EU destinations, displayed prices include the selected country’s standard VAT projection. Stripe confirms exact tax from the complete delivery and business details at checkout.
For supported destinations outside the EU, displayed prices exclude EU VAT. Import VAT, customs duties, brokerage fees, or carrier charges may be assessed after checkout and are the recipient’s responsibility.
Changing “Deliver to” can change the displayed merchandise, shipping, and total prices.
```

Terms pricing text becomes:

```text
Prices are in EUR. The country shown in “Deliver to” controls the storefront tax projection. For EU destinations, displayed prices include that country’s standard VAT projection; Stripe confirms exact tax from the complete delivery and business details at checkout. For supported destinations outside the EU, displayed prices exclude EU VAT and import charges may still be assessed after checkout.
Shipping is EUR 8 excluding tax for one total unit and is free for two or more total units. Changing “Deliver to” can change the displayed merchandise, shipping, and total prices. The Shipping page contains delivery estimates and the complete notice about charges outside the EU.
```

Preserve all withdrawal, complaint, delivery-estimate, and recipient-responsibility decisions.

- [ ] **Step 3: Add browser scenarios**

Expand fixture countries to `SE,DE,FI,HU,JP,TW`. Test:

- Sweden default and Cloudflare suggestion only without cookie;
- changing to Germany updates card/product/cart totals and persists across navigation/reload;
- changing to Japan shows EUR 20/EUR 8 and import copy;
- country change does not alter cart Price IDs;
- two-unit shipping remains free;
- Checkout accepts only selected country;
- no-JS form POST/303 updates SSR prices;
- keyboard open/search/radio/submit/Escape/focus restoration;
- 44px controls and no 320px horizontal overflow.

- [ ] **Step 4: Run policy and E2E tests**

Run: `rtk pnpm exec vitest run --project server src/lib/content/policies.test.ts && rtk pnpm run build:test-e2e && rtk pnpm exec playwright test tests/e2e/storefront.spec.ts tests/e2e/cart.spec.ts tests/e2e/checkout.spec.ts tests/e2e/accessibility.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
rtk git add src/lib/content/policies.ts src/lib/content/policies.test.ts playwright.config.ts tests/fixtures tests/e2e tests/integration/test-catalog-command-portability.test.ts
rtk git commit -m "test: cover destination pricing journey"
```

---

### Task 11: Operator Contract, Stripe Sandbox Resources, and Coolify Rollout

**Files:**
- Create: `docs/operations/stripe-catalog.md`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/operations/coolify.md`
- Modify: `docs/operations/policy-review.md`
- Modify: `docs/operations/styria-contract.md`
- Modify: `tests/integration/coolify-package.spec.ts`

**Interfaces:**
- Consumes: completed code, authenticated Stripe sandbox, existing Coolify application, existing Price metadata, and current persistent volume.
- Produces: inactive replacement Stripe resources, updated Coolify IDs, deployed migration, and verified sandbox acceptance.

- [ ] **Step 1: Write failing runbook-contract tests**

Assert documentation includes `unit_amount=2000`, exclusive merchandise, paid `fixed_amount.amount=800`, exclusive Shipping tax behavior, free EUR 0, checkout-off maintenance, v1 resource retention, stop-first deployment, persistent backup, default Price switch, and the SE/DE/FI/HU/Asia test matrix.

- [ ] **Step 2: Write the exact operator documentation**

Document this sequence without secrets:

1. Take and verify the encrypted SQLite backup.
2. Set `CHECKOUT_ENABLED=false` in Coolify and perform the existing stop-first redeploy.
3. Require `/health/live` and `/health/ready` to return 200 and checkout creation to return `CHECKOUT_DISABLED`.
4. In the Stripe sandbox, create one inactive EUR 20 one-time exclusive Price per active variant and copy exact `label`, `sort_order`, `sku`, and `styria_pn` metadata.
5. Create EUR 8 fixed exclusive paid shipping with the Shipping tax code; create an exclusive EUR 0 rate if the existing free rate is not exclusive.
6. Keep old Prices and Shipping Rates for historical Sessions.
7. Put replacement Shipping Rate IDs into the existing Coolify variables.
8. Deploy code/migration stop-first while checkout remains disabled.
9. Activate replacement Prices, update Product `default_price`, then deactivate old EUR 25 Prices.
10. Restart once to clear the 60-second fresh/15-minute stale catalog cache.
11. Run acceptance, policy/accounting review, then re-enable checkout.

Update Styria docs to say `retailPrice` is the immutable paid gross customer unit amount while `unit_amount` is net. `.env.example` comments describe the exact Shipping Rate contracts; no environment variable names change.

- [ ] **Step 3: Run documentation and package tests**

Run: `rtk pnpm exec vitest run --config vitest.integration.config.ts tests/integration/coolify-package.spec.ts`

Expected: PASS.

- [ ] **Step 4: Provision inactive Stripe sandbox resources**

Using the authenticated Stripe MCP, inspect the current Community Tee Product and active variants, then create one replacement Price for each `existingPrice` with this exact mapping:

```ts
{
	product: existingPrice.product,
	currency: 'eur',
	unit_amount: 2_000,
	tax_behavior: 'exclusive',
	active: false,
	metadata: {
		label: existingPrice.metadata.label,
		sort_order: existingPrice.metadata.sort_order,
		sku: existingPrice.metadata.sku,
		styria_pn: existingPrice.metadata.styria_pn
	}
}
```

Create paid/free Shipping Rates with the contracts above. Record returned non-secret IDs in the operator handoff, not hard-coded source. Do not activate or archive resources yet.

- [ ] **Step 5: Commit documentation before deployment**

```sh
rtk git add .env.example README.md docs/operations tests/integration/coolify-package.spec.ts
rtk git commit -m "docs: add dynamic pricing rollout"
```

- [ ] **Step 6: Run the full local verification gate**

Run in this order:

```sh
rtk pnpm test
rtk pnpm check
rtk pnpm lint
rtk pnpm build
rtk bash tests/integration/docker-health.sh
```

Expected: every command exits 0.

- [ ] **Step 7: Perform the controlled Coolify switch**

Disable checkout first, verify backup, update the two existing Shipping Rate environment values, deploy the tested commit stop-first, verify both health endpoints, activate new Prices/default Price, deactivate old EUR 25 Prices, restart once, and leave old Shipping Rates active until the v1 Session window has elapsed.

- [ ] **Step 8: Run manual sandbox acceptance**

For a one-tee order verify:

| Destination | Merchandise display | Shipping display | Stripe tax | Stripe total |
| --- | ---: | ---: | ---: | ---: |
| SE | EUR 25.00 | EUR 10.00 | EUR 7.00 | EUR 35.00 |
| DE | EUR 23.80 | EUR 9.52 | EUR 5.32 | EUR 33.32 |
| FI | EUR 25.10 | EUR 10.04 | EUR 7.14 | EUR 35.14 |
| HU | EUR 25.40 | EUR 10.16 | EUR 7.56 | EUR 35.56 |
| Supported Asia | EUR 20.00 | EUR 8.00 | EUR 0.00 in current setup | EUR 28.00 |

Also verify two tees have free shipping, Checkout allows only the selected country, Stripe receipt/invoice tax is correct, the local order stores shipping tax and retail unit amount, MCP labels net/gross values clearly, and the Styria preview receives the customer-facing gross unit `retailPrice`.

- [ ] **Step 9: Complete launch gate**

Record the reviewed deployed commit in `docs/operations/policy-review.md`, update `POLICY_EFFECTIVE_DATE` if required by the reviewer, run `rtk pnpm verify:public-headers`, and enable checkout only after legal/accounting review of OSS display, Stripe receipts/invoices, shipping tax, and Styria parcel invoice price.

---

## Final Verification Checklist

- [ ] `rtk rg -n "referenceGrossCents|swedishReferenceGrossCents|Reference price|Reference subtotal|€10 for one item" src tests` returns no matches.
- [ ] `rtk git diff --check` passes.
- [ ] `rtk pnpm test` passes.
- [ ] `rtk pnpm check` passes.
- [ ] `rtk pnpm lint` passes.
- [ ] `rtk pnpm build` passes.
- [ ] `rtk bash tests/integration/docker-health.sh` passes.
- [ ] Live `/health/live` and `/health/ready` return 200 after stop-first deployment.
- [ ] Sandbox totals match the five-destination matrix.
- [ ] Styria preview `retailPrice` matches the customer-facing paid gross unit amount.
- [ ] Old Stripe resources remain available for v1 history.
- [ ] Checkout is re-enabled only after policy/accounting sign-off.
