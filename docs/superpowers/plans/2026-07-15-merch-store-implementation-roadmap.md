# Svelte Society Merch Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved standalone Svelte Society merch MVP as a tested SvelteKit monolith on `shop.sveltesociety.dev`.

**Architecture:** One Node 24 process serves the storefront, Stripe webhook, authenticated TMCP endpoint, scheduler, and health routes. Stripe owns catalog and payment data; SQLite owns fulfillment workflow and audit state; Styria fulfills; Plunk sends operational and shipping email; encrypted SQLite backups go to S3-compatible storage.

**Tech Stack:** Svelte 5, SvelteKit 2, TypeScript, `@sveltejs/adapter-node`, Tailwind CSS, Valibot, Stripe, `better-sqlite3`, TMCP, Vitest, Playwright, Node 24, pnpm, Docker, Coolify.

## Global Constraints

- Create the app in the repository root with the official `sv` CLI through `pnpm dlx sv create`.
- Use Node 24 and pnpm only. Commit `pnpm-lock.yaml` and pin `packageManager`.
- Keep one Coolify replica and one application process. SQLite lives at `/data/shop.sqlite` in production.
- Keep payment state and fulfillment state independent.
- Never store names, street addresses, phone numbers, VAT IDs, payment methods, authorization headers, or raw provider payloads in SQLite or logs.
- Use Stripe Dashboard as the catalog back office. Browser input may contain only Stripe Price IDs and quantities.
- Require a ten-minute, one-use approval before Styria order creation. Never automatically retry an ambiguous Styria create.
- Protect `/mcp` with one constant-time static bearer comparison using `MCP_BEARER_TOKEN`.
- Keep customer accounts, order history, self-service tracking, web admin UI, discounts, and automatic returns/refunds outside this MVP.
- Keep source modules narrow. Routes translate HTTP; services enforce business rules; adapters own provider details.

Implementation must satisfy [the approved design specification](../specs/2026-07-15-standalone-svelte-society-merch-store-design.md). If a plan and the specification conflict, stop and reconcile the documents before writing code.

---

## Phase order and gates

1. [Storefront foundation and Stripe catalog](./2026-07-15-merch-store-phase-1-storefront-foundation.md)
   - Gate: lint, type checking, unit tests, component tests, and storefront Playwright smoke tests pass.
   - Produces the public shell, validated Stripe catalog, cart, feature flags, and brand system.
2. [Checkout and durable order intake](./2026-07-15-merch-store-phase-2-checkout-order-intake.md)
   - Gate: checkout matrix, webhook idempotency, SQLite migrations, outbox retry, and checkout browser tests pass.
   - Produces correlated checkout drafts, paid orders, Stripe receipts/invoices, refund status updates, and paid-order alerts.
3. [Fulfillment, Styria, Plunk, and internal MCP](./2026-07-15-merch-store-phase-3-fulfillment-mcp.md)
   - Gate: Styria contract fake, approval/replay/ambiguity tests, TMCP transport tests, bearer tests, scheduler tests, and a Codex connection smoke test pass.
   - Produces the complete administrator workflow and tracking email automation.
4. [Production hardening, backup, policies, and launch](./2026-07-15-merch-store-phase-4-production-launch.md)
   - Gate: Docker health, persistent-volume restart, encrypted backup/restore drill, policy review, security checks, browser matrix, and monitored real-order runbook pass.
   - Produces the Coolify-ready release and controlled launch procedure.

Do not begin a later phase while the prior phase gate is red. Correct the prior phase or explicitly amend the plan and specification.

## Shared directory contract

```text
src/
  lib/
    components/                 # reusable public UI
    domain/                     # pure types and rules
    stores/                     # browser cart state
    server/
      audit/                    # non-sensitive event writer
      backups/                  # snapshot/encrypt/upload/restore
      catalog/                  # Stripe catalog parsing and cache
      checkout/                 # draft and Checkout Session orchestration
      db/                       # connection, migrations, typed repositories
      fulfillment/              # state machine and approval workflow
      jobs/                     # scheduler, leases, outbox handlers
      mcp/                      # TMCP server, tools, bearer guard
      plunk/                    # email adapter
      security/                 # rate limits, host/origin checks, redaction
      stripe/                   # Stripe SDK adapter and webhook handling
      styria/                   # signing, payloads, API adapter
  routes/                       # thin SvelteKit HTTP and page adapters
migrations/                     # ordered transactional SQL
scripts/                        # operational commands, including restore
static/                         # Society-owned fonts and marks
tests/
  fixtures/                     # provider-safe test objects
  integration/                  # SQLite and provider boundary tests
  e2e/                          # Playwright journeys
docs/
  operations/                   # Coolify, catalog, MCP, backup, launch runbooks
```

## Shared domain interfaces

These types are stable across phases. A breaking change requires updating every later plan before implementation continues.

```ts
export type CartLine = { priceId: string; quantity: number };

export type CatalogVariant = {
  priceId: string;
  label: string;
  sku: string;
  styriaProductNumber: string;
  unitAmount: number;
  currency: 'eur';
  sortOrder: number;
};

export type CatalogProduct = {
  productId: string;
  slug: string;
  name: string;
  description: string;
  category: 'apparel' | 'accessory';
  imageUrls: string[];
  sizeGuideUrl: string | null;
  designReference: string;
  designs: Record<string, string>;
  materials: string;
  fit: string | null;
  care: string;
  sortOrder: number;
  variants: CatalogVariant[];
};

export type PublicCatalogVariant = Pick<CatalogVariant, 'priceId' | 'label' | 'unitAmount' | 'currency' | 'sortOrder'>;
export type PublicCatalogProduct = Omit<CatalogProduct, 'designReference' | 'designs' | 'variants'> & {
  variants: PublicCatalogVariant[];
};

export type PaymentStatus = 'paid' | 'partially_refunded' | 'refunded';

export type FulfillmentStatus =
  | 'pending_review'
  | 'submitting'
  | 'submitted'
  | 'awaiting_vendor_payment'
  | 'in_production'
  | 'shipped'
  | 'review_required'
  | 'cancelled';

export type StableError = {
  code: string;
  message: string;
  retryable: boolean;
};
```

`CatalogProduct` is server-only. Page loaders serialize only `PublicCatalogProduct`; SKU, Styria product number, design reference, design placement URLs, and operator diagnostics never enter browser page data.

## Cross-phase verification command

Every phase ends by running this exact command from the repository root:

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all commands exit `0`; no skipped test is allowed unless its reason and replacement production verification are committed in the phase plan.

## Commit policy

- Commit after each green task using the message supplied by its phase plan.
- Never mix unrelated user work into these commits.
- Do not commit `.env`, database files, backups, provider payload captures, or test output containing personal data.
- Before each phase gate, run `git status --short` and account for every path.
