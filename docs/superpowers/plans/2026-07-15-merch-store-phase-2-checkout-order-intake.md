# Phase 2: Checkout and Order Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-trusted Stripe Checkout, durable checkout drafts, idempotent paid-order intake, independent refund state, and retryable Plunk administrator alerts.

**Architecture:** The checkout service resolves every browser Price ID against Stripe, snapshots fulfillment data into SQLite, creates a Checkout Session, and correlates both sides. The webhook normalizes Stripe objects into a provider-independent paid snapshot, compares it with the draft, and commits order/audit/outbox changes atomically. A one-minute in-process scheduler drains the outbox outside webhook transactions.

**Tech Stack:** Phase 1 stack plus `better-sqlite3` 12.11.1, `@types/better-sqlite3` 7.6.13, Stripe Checkout/Webhooks, Plunk `POST /v1/send`.

## Global Constraints

- Start only after the Phase 1 gate is green.
- SQLite stores provider IDs and fulfillment snapshots, never customer name, email, address, phone, VAT ID, raw webhooks, or provider signatures.
- Stripe sends the customer receipt and invoice. Do not add a Plunk customer order-confirmation email.
- Checkout accepts only `{priceId, quantity}` lines and recalculates everything server-side.
- Return webhook success only after the SQLite transaction commits.
- Keep checkout and webhook provider calls behind interfaces so tests use contract fakes.

---

## Task 1: Add SQLite connection and transactional migration runner

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/lib/server/db/connection.server.ts`
- Create: `src/lib/server/db/migrate.server.ts`
- Create: `src/lib/server/db/migrate.test.ts`
- Create: `src/lib/server/db/types.ts`
- Create: `migrations/0001_initial.sql`
- Modify: `.gitignore`

**Interfaces produced:**

```ts
import type Database from 'better-sqlite3';

export type ShopDatabase = Database.Database;
export function openDatabase(path: string): ShopDatabase;
export function migrate(database: ShopDatabase, migrationsDirectory: string): void;
export function closeDatabase(): void;
```

- [ ] Install dependencies:

```bash
pnpm add better-sqlite3@12.11.1
pnpm add -D @types/better-sqlite3@7.6.13
```

- [ ] Write failing integration tests proving migrations apply once, reruns are no-ops, a failing migration rolls back, foreign keys reject invalid children, WAL is enabled for file databases, and busy timeout is `5000` milliseconds.

- [ ] Run `pnpm vitest run src/lib/server/db/migrate.test.ts`.

Expected: fail because the database modules do not exist.

- [ ] Implement `openDatabase` with these pragmas:

```ts
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.pragma('busy_timeout = 5000');
database.pragma('synchronous = FULL');
```

- [ ] Implement an ordered `.sql` migration runner with a private `_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)` table. Apply each unapplied file and its ledger insert inside one `database.transaction`.

- [ ] Create `0001_initial.sql` with this exact schema contract:

```sql
CREATE TABLE checkout_drafts (
  id TEXT PRIMARY KEY,
  stripe_checkout_session_id TEXT UNIQUE,
  contract_version INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'eur'),
  total_unit_count INTEGER NOT NULL CHECK (total_unit_count BETWEEN 1 AND 20),
  shipping_mode TEXT NOT NULL CHECK (shipping_mode IN ('paid', 'free')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE checkout_draft_lines (
  draft_id TEXT NOT NULL REFERENCES checkout_drafts(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL,
  stripe_product_id TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  variant_label TEXT NOT NULL,
  sku TEXT NOT NULL,
  styria_product_number TEXT NOT NULL,
  design_reference TEXT NOT NULL,
  design_json TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_amount INTEGER NOT NULL CHECK (unit_amount >= 0),
  currency TEXT NOT NULL CHECK (currency = 'eur'),
  PRIMARY KEY (draft_id, line_index)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT NOT NULL,
  checkout_draft_id TEXT NOT NULL UNIQUE REFERENCES checkout_drafts(id),
  currency TEXT NOT NULL CHECK (currency = 'eur'),
  subtotal_amount INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL,
  shipping_amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,
  destination_country TEXT NOT NULL,
  payment_status TEXT NOT NULL CHECK (payment_status IN ('paid', 'partially_refunded', 'refunded')),
  fulfillment_status TEXT NOT NULL CHECK (fulfillment_status IN ('pending_review', 'submitting', 'submitted', 'awaiting_vendor_payment', 'in_production', 'shipped', 'review_required', 'cancelled')),
  styria_order_id TEXT UNIQUE,
  styria_status TEXT,
  tracking_number TEXT,
  submitted_at TEXT,
  shipped_at TEXT,
  updated_at TEXT NOT NULL,
  last_error_code TEXT
);

CREATE TABLE stripe_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processing_status TEXT NOT NULL CHECK (processing_status IN ('processing', 'completed', 'failed')),
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  last_error_code TEXT,
  first_seen_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE order_lines (
  order_id TEXT NOT NULL REFERENCES orders(id),
  line_index INTEGER NOT NULL,
  stripe_product_id TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  variant_label TEXT NOT NULL,
  sku TEXT NOT NULL,
  styria_product_number TEXT NOT NULL,
  design_reference TEXT NOT NULL,
  design_json TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_amount INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'eur'),
  PRIMARY KEY (order_id, line_index)
);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  prior_state TEXT,
  next_state TEXT,
  result TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE submission_approvals (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  payload_hash TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor = 'codex-admin'),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE outbox_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  order_id TEXT REFERENCES orders(id),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  completed_at TEXT,
  last_error_code TEXT
);

CREATE TABLE email_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL,
  tracking_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_delivery_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT
);

CREATE TABLE support_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  outcome TEXT NOT NULL,
  external_reference TEXT,
  actor TEXT NOT NULL CHECK (actor = 'codex-admin'),
  created_at TEXT NOT NULL
);

CREATE TABLE job_leases (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  error_code TEXT
);

CREATE INDEX idx_orders_fulfillment_status ON orders(fulfillment_status, updated_at);
CREATE INDEX idx_outbox_due ON outbox_jobs(completed_at, next_attempt_at);
CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);
```

- [ ] Add `*.sqlite`, `*.sqlite-shm`, and `*.sqlite-wal` to `.gitignore`.

- [ ] Run `pnpm vitest run src/lib/server/db/migrate.test.ts && pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: add SQLite schema and migrations"`.

---

## Task 2: Add typed checkout, order, event, and outbox repositories

**Files:**

- Create: `src/lib/server/db/checkout-drafts.server.ts`
- Create: `src/lib/server/db/orders.server.ts`
- Create: `src/lib/server/db/stripe-events.server.ts`
- Create: `src/lib/server/db/outbox.server.ts`
- Create: `src/lib/server/db/repositories.test.ts`
- Create: `src/lib/server/audit/order-events.server.ts`
- Create: `src/lib/domain/orders.ts`

**Interfaces produced:**

```ts
export interface CheckoutDraftRepository {
  create(input: NewCheckoutDraft): CheckoutDraft;
  attachSession(draftId: string, sessionId: string): void;
  findById(draftId: string): CheckoutDraftWithLines | null;
  markCompleted(draftId: string, completedAt: Date): void;
}

export interface StripeEventRepository {
  begin(eventId: string, eventType: string, now: Date): 'new' | 'completed' | 'retry';
  complete(eventId: string, refs: ProviderReferences, now: Date): void;
  fail(eventId: string, errorCode: string): void;
}

export interface OrderRepository {
  createPaidOrder(input: PaidOrderInput): Order;
  findByCheckoutSession(sessionId: string): OrderWithLines | null;
  updatePaymentStatus(paymentIntentId: string, status: PaymentStatus, now: Date): void;
}

export interface OutboxRepository {
  enqueue(input: NewOutboxJob): void;
  claimDue(now: Date, limit: number): OutboxJob[];
  complete(id: number, now: Date): void;
  reschedule(id: number, attemptCount: number, nextAttemptAt: Date, errorCode: string): void;
}
```

- [ ] Write failing repository tests for immutable draft lines, unique provider IDs, event begin/retry/complete behavior, atomic paid-order plus copied-lines plus event plus outbox creation, refund status independent from fulfillment, and outbox idempotency.

- [ ] Run `pnpm vitest run src/lib/server/db/repositories.test.ts`.

Expected: fail because repositories do not exist.

- [ ] Implement explicit SQL statements and map every row at the repository boundary. Use `crypto.randomUUID()` for internal IDs and ISO-8601 UTC strings for timestamps.

- [ ] Expose one transaction method for webhook intake rather than allowing the webhook service to coordinate partial repository writes:

```ts
export interface PaidOrderUnitOfWork {
  commitPaidOrder(input: PaidOrderInput, event: StripeEventInput): Order;
}
```

The implementation must create or converge the order, copy draft lines, mark the draft complete, append `order_events`, enqueue `paid-order-alert:<order-id>`, and complete the Stripe event in one database transaction.

- [ ] Run focused tests and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: add durable order repositories"`.

---

## Task 3: Build correlated Stripe Checkout creation

**Files:**

- Create: `src/lib/server/stripe/gateway.ts`
- Create: `src/lib/server/stripe/client.server.ts`
- Create: `src/lib/server/stripe/checkout.server.ts`
- Create: `src/lib/server/checkout/service.server.ts`
- Create: `src/lib/server/checkout/service.test.ts`
- Create: `src/routes/checkout/+server.ts`
- Create: `src/routes/checkout/checkout-route.test.ts`
- Modify: `src/routes/cart/+page.svelte`

**Interfaces consumed:** `CatalogService.resolveCart`, `CheckoutDraftRepository`, public/private config.

**Interfaces produced:**

```ts
export interface StripeCheckoutGateway {
  createSession(input: CreateCheckoutInput): Promise<{ id: string; url: string }>;
  expireSession(sessionId: string): Promise<void>;
}

export interface CheckoutService {
  start(input: unknown): Promise<{ redirectUrl: string }>;
}
```

- [ ] Write failing service tests for invalid cart, stale Price, one-unit paid rate, two-unit free rate, same-variant threshold, exact destination allowlist, new customer, automatic tax, tax-ID/phone/address collection, invoice creation, draft metadata, correlation success, Stripe failure, and local attach failure that expires the created Session.

- [ ] Run `pnpm vitest run src/lib/server/checkout/service.test.ts`.

Expected: fail because the service does not exist.

- [ ] Implement `CreateCheckoutInput` so provider configuration is constructed only from validated server data:

```ts
type CreateCheckoutInput = {
  draftId: string;
  lines: Array<{ priceId: string; quantity: number }>;
  shippingRateId: string;
  allowedCountries: readonly string[];
  successUrl: string;
  cancelUrl: string;
};
```

Map it to Stripe with `mode: 'payment'`, `customer_creation: 'always'`, `automatic_tax.enabled`, `tax_id_collection.enabled`, `phone_number_collection.enabled`, `invoice_creation.enabled`, one server-selected `shipping_options` rate, `shipping_address_collection.allowed_countries`, `client_reference_id=draftId`, merch/contract/draft metadata, and a merch PaymentIntent description.

- [ ] Create the immutable draft before the Stripe call. After Session creation, attach the Session ID. If attach fails, attempt expiry, return `CHECKOUT_CORRELATION_FAILED`, and never return the Session URL.

- [ ] Implement `POST /checkout` as JSON-only with same-origin validation. Return `{redirectUrl}` on `200`, stable problem JSON on expected errors, `404` when storefront is disabled, and `503` when checkout is disabled.

- [ ] Enable the cart button only from the public checkout flag. On success, navigate with `window.location.assign(redirectUrl)`; on failure, preserve cart and announce the error next to the button.

- [ ] Run route/service tests and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: create correlated Stripe Checkout sessions"`.

---

## Task 4: Normalize and compare paid Stripe checkout data

**Files:**

- Create: `src/lib/server/stripe/paid-checkout.ts`
- Create: `src/lib/server/stripe/paid-checkout.test.ts`
- Modify: `src/lib/server/stripe/gateway.ts`
- Modify: `src/lib/server/stripe/client.server.ts`
- Create: `tests/fixtures/stripe-paid-checkout.ts`

**Interfaces produced:**

```ts
export type PaidCheckoutSnapshot = {
  checkoutSessionId: string;
  paymentIntentId: string;
  customerId: string;
  draftId: string;
  currency: 'eur';
  paymentStatus: 'paid';
  destinationCountry: string;
  amounts: { subtotal: number; discount: number; shipping: number; tax: number; total: number };
  lines: Array<{ priceId: string; quantity: number; unitAmount: number }>;
};

export interface StripeOrderGateway {
  retrievePaidCheckout(sessionId: string): Promise<PaidCheckoutSnapshot>;
  retrieveRefundStatus(paymentIntentId: string): Promise<PaymentStatus>;
}

export function comparePaidCheckout(draft: CheckoutDraftWithLines, paid: PaidCheckoutSnapshot): void;
```

- [ ] Write failing tests for unpaid Session, non-EUR Session, missing customer/address/phone, unsupported country, missing draft ID, paginated lines, Price/quantity mismatch, paid/free shipping mismatch, total mismatch, and a valid EU and US snapshot.

- [ ] Implement Stripe pagination inside the adapter until `has_more=false`. Normalize API-version-specific Stripe fields at this boundary; domain code must not access Stripe SDK object shapes.

- [ ] Compare immutable Price IDs, quantities, unit amounts, currency, total unit count, selected shipping mode, and draft ID. Do not compare final tax to the Swedish reference display price.

- [ ] Run focused tests and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: normalize paid Stripe checkouts"`.

---

## Task 5: Implement idempotent Stripe webhooks and refund convergence

**Files:**

- Create: `src/lib/server/stripe/webhook.server.ts`
- Create: `src/lib/server/stripe/webhook.test.ts`
- Create: `src/routes/webhooks/stripe/+server.ts`
- Create: `src/routes/webhooks/stripe/webhook-route.test.ts`
- Create: `src/lib/server/orders/intake.server.ts`

**Interfaces produced:**

```ts
export interface StripeWebhookService {
  handle(rawBody: string, signature: string): Promise<{ duplicate: boolean }>;
}
```

- [ ] Write failing tests for missing signature, invalid signature, duplicate Event ID, retry after failed processing, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, unpaid completion ignored safely, out-of-order events, partial refund, full refund, transaction rollback, and no raw payload persisted.

- [ ] Implement the route using `await request.text()` exactly once and Stripe signature verification before JSON parsing. Never call `request.json()`.

- [ ] In the service: construct the Stripe Event, call `stripeEvents.begin`, normalize/retrieve the current Stripe object, compare against the draft, and call `PaidOrderUnitOfWork.commitPaidOrder`. Mark failed events with a stable code and rethrow so Stripe receives non-2xx.

- [ ] Handle refund notifications by retrieving current PaymentIntent/Charge refund totals through `StripeOrderGateway`, then update `payment_status` only and append an audit event. Never mutate `fulfillment_status` from a refund event.

- [ ] Return `200` for completed duplicates and irrelevant verified event types; return non-2xx for retryable database/provider failures.

- [ ] Run focused tests and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: ingest Stripe orders idempotently"`.

---

## Task 6: Add Plunk adapter and paid-order alert outbox worker

**Files:**

- Create: `src/lib/server/plunk/gateway.ts`
- Create: `src/lib/server/plunk/client.server.ts`
- Create: `src/lib/server/plunk/client.test.ts`
- Create: `src/lib/server/jobs/backoff.ts`
- Create: `src/lib/server/jobs/backoff.test.ts`
- Create: `src/lib/server/jobs/outbox-worker.server.ts`
- Create: `src/lib/server/jobs/outbox-worker.test.ts`

**Interfaces produced:**

```ts
export interface PlunkGateway {
  send(input: {
    to: string;
    from: { name: string; email: string };
    replyTo: string;
    subject: string;
    html: string;
  }): Promise<{ deliveryId: string }>;
}

export interface OutboxWorker {
  drain(now: Date, limit?: number): Promise<{ completed: number; rescheduled: number }>;
}
```

- [ ] Write failing Plunk tests for `POST /v1/send`, Bearer auth, verified sender, reply-to, response validation, timeout, `429`, `5xx`, and response redaction. Use an injected `fetch`.

- [ ] Implement the client against configured `PLUNK_BASE_URL` defaulting to `https://next-api.useplunk.com`; never log headers, recipient, body, or raw response.

- [ ] Write failing worker tests for paid-order alert content, idempotency, success, exponential retry, six-attempt transition to hourly retry, and one failed job not blocking the batch.

- [ ] Use this bounded retry function:

```ts
export function nextOutboxAttempt(now: Date, attempt: number): Date {
  const minutes = attempt >= 6 ? 60 : Math.min(2 ** attempt, 30);
  return new Date(now.getTime() + minutes * 60_000);
}
```

- [ ] Keep the alert free of personal data. Subject: `Svelte Society Shop: paid order awaiting review`. Body includes internal order ID, unit count, total EUR amount, destination country, and the instruction `Open Codex and use list_pending_orders.`

- [ ] Run focused tests and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: send paid-order alerts through outbox"`.

---

## Task 7: Start the one-minute scheduler safely

**Files:**

- Create: `src/lib/server/jobs/leases.server.ts`
- Create: `src/lib/server/jobs/leases.test.ts`
- Create: `src/lib/server/jobs/scheduler.server.ts`
- Create: `src/lib/server/jobs/scheduler.test.ts`
- Create: `src/lib/server/app.server.ts`
- Create: `src/hooks.server.ts`

**Interfaces produced:**

```ts
export interface LeaseRepository {
  acquire(name: string, ownerId: string, now: Date, ttlMs: number): boolean;
  release(name: string, ownerId: string): void;
}

export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
  runOutboxOnce(now?: Date): Promise<void>;
}
```

- [ ] Write failing tests for exclusive lease acquisition, expired lease takeover, owner-only release, scheduler disabled, one start despite repeated imports/requests, no overlapping drain, and recovery after worker failure.

- [ ] Implement one application singleton that opens/migrates SQLite before serving business routes. Start the scheduler only after local startup readiness is green, `SCHEDULER_ENABLED=true`, and runtime is not a SvelteKit build/prerender/test process.

- [ ] Run the outbox immediately after readiness, then every 60 seconds. Use a 55-second lease and record `job_runs`; use an unref'd timer so tests/process shutdown are not held open.

- [ ] Run focused tests and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: add recoverable outbox scheduler"`.

---

## Task 8: Add success page and end-to-end checkout coverage

**Files:**

- Create: `src/routes/checkout/success/+page.server.ts`
- Create: `src/routes/checkout/success/+page.svelte`
- Create: `tests/e2e/checkout.spec.ts`
- Create: `tests/integration/checkout-webhook.spec.ts`
- Modify: `tests/fixtures/catalog-server.ts`

**Interfaces consumed:** Stripe checkout/order fakes, temporary SQLite file, Plunk fake.

- [ ] Implement the success page with the exact approved heading/body/support copy. Accept `session_id` only to verify a completed merch Session server-side; do not render customer, address, payment, or order details. Clear the browser cart only after the verified success page loads.

- [ ] Add integration tests for EU consumer, US customer, reverse-charge tax-ID path, one-unit paid shipping, two-unit free shipping, duplicate webhook, webhook retry after database failure, and partial/full refund convergence.

- [ ] Add Playwright tests for checkout disabled, checkout error preserving cart, secure redirect, cancel preserving cart, verified success clearing cart, and unverified success not clearing cart.

- [ ] Run:

```bash
pnpm test:integration && pnpm test:e2e
```

Expected: all checkout and webhook tests pass.

- [ ] Run the phase gate:

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e && pnpm build
```

Expected: all commands exit `0`.

- [ ] Commit with `git commit -m "test: verify checkout and order intake"`.

## Phase 2 handoff

In Stripe test mode, verify Dashboard email settings send both receipt and invoice, webhook delivery reaches the deployed raw-body route, and the local order contains only allowed operational fields. Leave production checkout disabled.
