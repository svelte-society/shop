# Phase 4: Production and Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the store for Coolify, add health/security/monitoring, encrypted off-host backup and restore, analytics, reviewed public policies, and a controlled launch runbook.

**Architecture:** The existing modular monolith is packaged as one non-root Node 24 container with one `/data` volume. Local readiness checks gate commerce without depending on providers. Daily online SQLite snapshots are AES-256-GCM encrypted and uploaded to S3-compatible storage. Security hooks wrap thin routes. Feature flags allow policy/storefront/checkout/MCP/scheduler rollout in separate steps.

**Tech Stack:** Existing stack plus Docker, Coolify, `@aws-sdk/client-s3` 3.1087.0, Node crypto/fs APIs, Umami, Plunk operational alerts.

## Global Constraints

- Start only after the Phase 3 gate is green.
- Run one replica. Do not put SQLite behind multiple application instances.
- Production database path is `/data/shop.sqlite`; container runtime user is non-root.
- Liveness never calls providers. Readiness checks local configuration, migration/integrity state, writable volume, and free space only.
- Encrypted backups are off-host and tested by restoration. A backup without a passing restore drill is not considered complete.
- Legal and accountant review are launch blockers, not engineering substitutes.
- Checkout stays disabled until the monitored real-order gate explicitly enables it.

---

## Task 1: Add local liveness and readiness

**Files:**

- Create: `src/lib/server/health/readiness.server.ts`
- Create: `src/lib/server/health/readiness.test.ts`
- Create: `src/routes/health/live/+server.ts`
- Create: `src/routes/health/ready/+server.ts`
- Modify: `src/lib/server/app.server.ts`

**Interfaces produced:**

```ts
export type ReadinessResult = {
  ready: boolean;
  checks: {
    configuration: 'ok' | 'failed';
    database: 'ok' | 'failed';
    migrations: 'ok' | 'failed';
    volume: 'ok' | 'failed';
    disk: 'ok' | 'low' | 'failed';
  };
};

export function checkReadiness(): Promise<ReadinessResult>;
```

- [ ] Write failing tests for healthy database, missing migration, failed `PRAGMA quick_check`, read-only data directory, missing required production configuration, less than 256 MiB free space, and a transient Stripe/Styria/Plunk outage that does not affect readiness.

- [ ] Implement `GET /health/live` as static JSON with `200`:

```json
{ "status": "live" }
```

- [ ] Implement readiness using `PRAGMA quick_check`, migration ledger comparison, a create/fsync/delete sentinel in the database directory, and `fs.promises.statfs`. Return only check names, never paths, SQL, configuration values, or stack traces.

- [ ] Return `200` with `{status:'ready', checks}` when healthy and `503` with `{status:'not_ready', checks}` otherwise. Make checkout fail closed with `SERVICE_NOT_READY` when readiness is red; keep webhook signature verification and health/policy routes available.

- [ ] Run `pnpm vitest run src/lib/server/health/readiness.test.ts && pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: add local health checks"`.

---

## Task 2: Add request security, rate limits, CSP, and redacted logging

**Files:**

- Create: `src/lib/server/security/host-origin.server.ts`
- Create: `src/lib/server/security/host-origin.test.ts`
- Create: `src/lib/server/security/rate-limit.server.ts`
- Create: `src/lib/server/security/rate-limit.test.ts`
- Create: `src/lib/server/security/redact.ts`
- Create: `src/lib/server/security/redact.test.ts`
- Create: `src/lib/server/logging/logger.server.ts`
- Modify: `src/hooks.server.ts`
- Modify: `src/app.html`

**Interfaces produced:**

```ts
export function validateHostAndOrigin(request: Request, config: SecurityConfig): void;
export function takeRateLimit(key: string, policy: { limit: number; windowMs: number }, now?: number): boolean;
export function redact(value: unknown): unknown;
export function log(event: { level: 'info' | 'warn' | 'error'; code: string; fields?: Record<string, unknown> }): void;
```

- [ ] Write failing tests for allowed/disallowed Host, absent Origin, allowed/disallowed Origin, direct client address, adapter-provided proxied address, and IPv4/IPv6 normalization. Use SvelteKit `event.getClientAddress()`; never parse the left-most `X-Forwarded-For` value in application code.

- [ ] Write rate-limit tests for these defaults: checkout `10/min/IP`, webhook `120/min/IP`, MCP `60/min/IP`, invalid MCP auth `10/15min/IP`. Use an in-memory fixed-window limiter because the deployment is one replica; prune expired buckets.

- [ ] Write redaction tests against nested/case-varied keys containing `authorization`, `cookie`, `secret`, `signature`, `email`, `name`, `address`, `phone`, `vat`, `body`, and provider payload objects. The output may keep stable IDs, status, country code, counts, and error codes.

- [ ] Wrap SvelteKit handling with Host/origin validation, route-specific rate limits keyed by `event.getClientAddress()`, request ID, structured JSON result logging, and a redacted `handleError`. Do not log URLs with query strings because success URLs contain Stripe Session IDs. In Coolify, set adapter-node `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH` to the verified count of trusted proxies so the adapter reads from the right side of the chain.

- [ ] Add security headers: HSTS in production, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `frame-ancestors 'none'`, and a CSP that allows only self, Society assets, the configured Umami script/connect origin, and configured catalog image origins. Stripe Checkout is a top-level redirect and needs no frame exception.

- [ ] Add a per-response CSP nonce if any inline script is required; otherwise remove inline scripts. Verify Stripe Checkout is a top-level redirect, not an embedded frame.

- [ ] Run `pnpm vitest run src/lib/server/security && pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: harden HTTP and logging boundaries"`.

---

## Task 3: Package the app for Coolify

**Files:**

- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `scripts/.gitkeep`
- Create: `docs/operations/coolify.md`
- Create: `tests/integration/docker-health.sh`
- Modify: `package.json`
- Modify: `src/lib/server/app.server.ts`

**Interfaces produced:** one image listening on `0.0.0.0:3000`, writing only `/data`, running `node build` as UID/GID `10001`.

- [ ] Add `start: "node build"` to `package.json`.

- [ ] Create this multi-stage Dockerfile:

```dockerfile
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/data/shop.sqlite
ENV TMPDIR=/data/tmp
ENV SHUTDOWN_TIMEOUT=30
ENV BODY_SIZE_LIMIT=1M
WORKDIR /app
RUN groupadd --gid 10001 shop && useradd --uid 10001 --gid shop --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin shop
COPY --from=build --chown=shop:shop /app/build ./build
COPY --from=build --chown=shop:shop /app/node_modules ./node_modules
COPY --from=build --chown=shop:shop /app/package.json ./package.json
COPY --from=build --chown=shop:shop /app/migrations ./migrations
COPY --from=build --chown=shop:shop /app/scripts ./scripts
RUN mkdir -p /data/tmp && chown -R shop:shop /data && chmod 0555 /tmp
USER shop
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "build"]
```

- [ ] Add `.dockerignore` for `.git`, `.svelte-kit`, `node_modules`, test output, `.env*` except committed examples, SQLite/WAL/SHM files, backups, and local screenshots.

- [ ] Write `docker-health.sh` to build the image, run it with safe test configuration and a named volume, wait for both health routes, assert runtime UID `10001`, create an order fixture, restart a new container on the same volume, and assert the row remains. The script must trap cleanup.

- [ ] Register `process.on('sveltekit:shutdown', async () => { await scheduler.stop(); closeDatabase(); })` once in the application singleton. Add an integration test that sends `SIGTERM`, observes the scheduler stop and SQLite close, and confirms adapter-node exits within `SHUTDOWN_TIMEOUT`.

- [ ] Document Coolify: domain `shop.sveltesociety.dev`, one replica, port `3000`, `ORIGIN=https://shop.sveltesociety.dev`, `/data` persistent volume, HTTPS, health path, verified `ADDRESS_HEADER`/`XFF_DEPTH`, all environment variable groups, deployment order, rollback, SQLite ownership, and why replicas must remain one.

- [ ] Run:

```bash
docker build -t svelte-society-shop:test .
bash tests/integration/docker-health.sh
```

Expected: image builds; liveness/readiness pass; non-root and restart persistence assertions pass.

- [ ] Commit with `git commit -m "feat: package store for Coolify"`.

---

## Task 4: Implement encrypted S3 backup, retention, and restore

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/lib/server/backups/format.ts`
- Create: `src/lib/server/backups/format.test.ts`
- Create: `src/lib/server/backups/s3.server.ts`
- Create: `src/lib/server/backups/s3.test.ts`
- Create: `src/lib/server/backups/service.server.ts`
- Create: `src/lib/server/backups/service.test.ts`
- Create: `scripts/restore-backup.mjs`
- Create: `docs/operations/backup-restore.md`
- Modify: `src/lib/server/jobs/scheduler.server.ts`

**Interfaces produced:**

```ts
export interface BackupStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>>;
  delete(keys: string[]): Promise<void>;
}

export interface BackupService {
  run(now?: Date): Promise<{ objectKey: string; checksum: string; deleted: number }>;
}
```

- [ ] Install exact dependency:

```bash
pnpm add @aws-sdk/client-s3@3.1087.0
```

- [ ] Define binary format `SSBK1`: five ASCII magic bytes, twelve-byte random IV, sixteen-byte GCM authentication tag, then ciphertext. `BACKUP_ENCRYPTION_KEY_BASE64` must decode to exactly 32 bytes. Checksum is lower-case SHA-256 of the complete encrypted object.

- [ ] Write failing tests for round-trip, wrong key, modified IV/tag/ciphertext, invalid key length, invalid magic, checksum mismatch, and a guarantee that plaintext database bytes do not appear in the encrypted output.

- [ ] Write S3 fake tests for configured endpoint/region/path-style mode, encrypted object upload, `.sha256` companion upload, pagination, deleting both files older than 30 rolling days, and redacted AWS errors.

- [ ] Implement backup sequence exactly:

```text
database.backup(temp snapshot) -> quick_check snapshot -> encrypt to temp object
-> calculate checksum -> upload encrypted object -> upload checksum
-> verify object metadata/listing -> delete local temp files -> prune objects older than 30 days
```

Object key: `<prefix>/YYYY/MM/DD/shop-YYYYMMDDTHHmmssZ.sqlite.ssbk`.

- [ ] Add a daily 02:30 UTC scheduler job with a 120-minute lease. On failure, keep the source database untouched, remove incomplete temp files, emit stable alert `BACKUP_FAILED`, and retry at the next daily cadence.

- [ ] Implement `scripts/restore-backup.mjs` with required arguments `--key <object-key>`, `--confirm-app-stopped`, and `--confirm-replace`. It downloads object/checksum, verifies checksum, decrypts to `/data/shop.restore.tmp`, runs `PRAGMA quick_check`, closes SQLite, copies current DB to `/data/shop.pre-restore.<timestamp>.sqlite`, and atomically renames the restored DB. The runbook must stop the application container first; the explicit confirmation prevents unattended replacement while it is running.

- [ ] Document shutdown, restore command, migration verification, restart, readiness check, and rollback to the pre-restore copy. Never put the encryption key on a command line; read it from environment.

- [ ] Run backup tests and a production-shaped restore against a temporary S3-compatible test bucket.

Expected: restored database passes `quick_check`, migrations, row-count assertions, and application readiness.

- [ ] Commit with `git commit -m "feat: add encrypted backup and restore"`.

---

## Task 5: Add operational alerts and stale-order detection

**Files:**

- Create: `src/lib/server/monitoring/alerts.server.ts`
- Create: `src/lib/server/monitoring/alerts.test.ts`
- Create: `src/lib/server/jobs/stale-orders.server.ts`
- Create: `src/lib/server/jobs/stale-orders.test.ts`
- Modify: `src/lib/server/jobs/scheduler.server.ts`
- Modify: `src/lib/server/jobs/outbox-worker.server.ts`
- Modify: `src/lib/server/catalog/service.server.ts`

**Interfaces produced:**

```ts
export type AlertCode =
  | 'ORDER_PENDING_REVIEW'
  | 'STYRIA_REVIEW_REQUIRED'
  | 'SCHEDULER_FAILED'
  | 'SHIPPING_EMAIL_UNSENT'
  | 'BACKUP_FAILED'
  | 'BACKUP_MISSED'
  | 'CATALOG_UNAVAILABLE'
  | 'CHECKOUT_UNAVAILABLE'
  | 'MCP_AUTH_REPEATED_FAILURE'
  | 'DISK_LOW'
  | 'SQLITE_NOT_READY';

export function enqueueAlert(code: AlertCode, subjectId: string, now: Date): void;
```

- [ ] Write failing tests for stable alert idempotency buckets, no PII, pending review after 24 hours, review-required submission, tracking without delivery, missed backup, repeated invalid MCP auth, low disk, catalog/checkout outage, and recovery suppressing duplicate alerts.

- [ ] Use outbox idempotency key `alert:<code>:<subject-id>:<UTC-date-or-hour-bucket>`. Send operational mail only to configured `ADMIN_EMAIL` through Plunk.

- [ ] Run stale-order and missed-backup checks daily without exposing the internal 24-hour alert threshold in customer copy.

- [ ] Run focused tests and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: add shop operational alerts"`.

---

## Task 6: Add privacy-safe Umami funnel analytics

**Files:**

- Create: `src/lib/analytics/events.ts`
- Create: `src/lib/analytics/events.test.ts`
- Create: `src/lib/components/Umami.svelte`
- Modify: `src/routes/+layout.svelte`
- Modify: `src/lib/components/ProductCard.svelte`
- Modify: `src/lib/components/VariantPicker.svelte`
- Modify: `src/lib/stores/cart.svelte.ts`
- Modify: `src/routes/cart/+page.svelte`
- Modify: `src/routes/checkout/success/+page.svelte`
- Modify: `src/routes/checkout/cancel/+page.svelte`

**Interfaces produced:**

```ts
export type FunnelEvent =
  | 'product_viewed'
  | 'variant_selected'
  | 'added_to_cart'
  | 'cart_viewed'
  | 'checkout_started'
  | 'checkout_returned_successfully'
  | 'checkout_cancelled';

export function track(event: FunnelEvent): void;
```

- [ ] Write failing tests that allow only the seven fixed event names and reject all event properties. This intentionally prevents order ID, Product/Price ID, email, customer ID, address, VAT ID, and cart contents from entering analytics.

- [ ] Load the configured existing Umami script only when `UMAMI_SCRIPT_URL` is HTTPS and `UMAMI_WEBSITE_ID` is present. Use `defer` and respect Do Not Track if that matches the Society deployment configuration.

- [ ] Fire each event once at its semantic action point. Do not block navigation or checkout on analytics failure.

- [ ] Update CSP tests for the exact configured Umami script and connect origins.

- [ ] Run focused tests, component tests, and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: add privacy-safe funnel analytics"`.

---

## Task 7: Publish configured policy and information pages

**Files:**

- Create: `src/lib/content/policies.ts`
- Create: `src/lib/content/policies.test.ts`
- Create: `src/lib/components/PolicyPage.svelte`
- Create: `src/routes/shipping/+page.svelte`
- Create: `src/routes/returns/+page.svelte`
- Create: `src/routes/privacy/+page.svelte`
- Create: `src/routes/terms/+page.svelte`
- Create: `src/routes/about/+page.svelte`
- Create: `scripts/delete-local-order.mjs`
- Create: `tests/integration/delete-local-order.spec.ts`
- Create: `docs/operations/policy-review.md`
- Modify: `src/lib/config/private.server.ts`
- Modify: `src/lib/components/SiteFooter.svelte`

**Configuration consumed:** seller legal name, registration number, VAT number, postal address, merchant email, support email, EU delivery estimate, US delivery estimate, policy effective date.

- [ ] Write failing tests that checkout-enabled production config cannot start without complete seller identity, delivery estimates, policy effective date, and `merch@sveltesociety.dev` support contact.

- [ ] Implement policy view models as plain text/links, not HTML strings. Required sections:

```ts
export type PolicySection = { heading: string; paragraphs: string[]; links?: Array<{ label: string; href: string }> };
export type PolicyDocument = { title: string; effectiveDate: string; sections: PolicySection[] };
```

- [ ] Shipping must state EUR, EU except Slovenia plus US, EUR 10 for one total unit, free at two or more, configured estimates, final tax from checkout, and US customer responsibility for import duties/brokerage/carrier charges.

- [ ] Returns must state approval-first contact at `merch@sveltesociety.dev`, EU withdrawal instructions and model form, damaged/incorrect remedies, return postage rules, exclusions supported by reviewed law, and that refunds are processed manually.

- [ ] Privacy must describe Stripe, Styria, Plunk, carriers, Umami, structured logs, local operational state, encrypted S3 backups, purposes, retention summary, legal bases, transfers, rights, and contact. State that SQLite excludes name/address/phone/VAT/payment-method data, encrypted backups roll for 30 days, and local operational records have no automatic deletion in the MVP but support reviewed deletion when required.

- [ ] Terms must identify Svelte School AB from configured legal fields and cover products, pricing/VAT, payment, Stripe receipt/invoice, destinations, fulfillment, Styria manual review without a public 24-hour promise, support, returns, and governing mandatory consumer rights.

- [ ] About must remain short: official Society merch for community identity; do not claim purchases fund Svelte Society.

- [ ] Implement `scripts/delete-local-order.mjs --order-id <internal-id> --confirm-reviewed-deletion`. Require checkout and scheduler maintenance mode, create a confirmed encrypted backup first, delete matching Stripe event ledger rows plus support notes/email deliveries/outbox/approvals/events/lines/order/draft lines/draft in one transaction, run `PRAGMA quick_check`, and print only table counts and the internal ID. Add integration tests for missing confirmation, active commerce refusal, rollback, and successful reviewed deletion.

- [ ] Add every route to the footer and verify policy routes remain available when storefront is disabled.

- [ ] Obtain qualified legal review and accountant approval. Record reviewer role, review date, approved document commit SHA, and any operational conditions in `docs/operations/policy-review.md`; do not store private correspondence.

- [ ] Run `pnpm vitest run src/lib/content/policies.test.ts && pnpm test:e2e`.

Expected: tests pass and policy-review document records approval before checkout can be enabled.

- [ ] Commit with `git commit -m "feat: publish merch store policies"`.

---

## Task 8: Complete production verification and controlled launch

**Files:**

- Create: `docs/operations/stripe-catalog.md`
- Create: `docs/operations/launch-runbook.md`
- Create: `docs/operations/incident-runbook.md`
- Create: `docs/operations/production-verification.md`
- Create: `tests/e2e/production-smoke.spec.ts`
- Modify: `README.md`

- [ ] Document the exact Stripe Dashboard catalog contract, one-time EUR exclusive Prices, tax codes, metadata keys, invoice/receipt settings, webhook events, and an operator diagnostic command that prints only provider IDs and stable codes. The paid Shipping Rate must be fixed EUR 10.00 with inclusive tax behavior; the free Shipping Rate must be fixed EUR 0.00. Record both IDs and verify the displayed final shipping charge stays EUR 10.00 for every allowed destination.

- [ ] Document environment setup and four rollout states:

| State | Storefront | Checkout | MCP | Scheduler |
|---|---:|---:|---:|---:|
| Deploy/restore | off | off | off | off |
| Public preview | on | off | off | on |
| Operator verification | on | off | on | on |
| Public sale | on | on | on | on |

- [ ] Add production smoke tests for opening-soon, policies, health, public preview, catalog, cart, checkout disabled, MCP disabled/invalid bearer, and no secret/PII in response bodies or console logs.

- [ ] Execute and record this verification matrix in `production-verification.md`:

```text
Stripe test tax: SE consumer, another EU consumer, valid EU business tax ID, US
Shipping: one unit paid, two different units free, two same variant free
Webhook: signature, duplicate, retry, out-of-order, partial refund, full refund
MCP: initialize, bearer reject/accept, every tool schema and annotation
Styria: signed list/detail, approved create, manual payment reminder, ambiguity reconciliation
Plunk: admin alert and shipping email to a non-customer mailbox
Data: no PII in SQLite/logs/analytics; volume survives redeploy
Backup: encrypted upload, 30-day pruning, production-shaped restore
Browsers: Chromium, Firefox, WebKit at 320/768/1024/1440; keyboard/reduced motion
```

- [ ] Run final automated verification:

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e && pnpm build
docker build -t svelte-society-shop:release .
bash tests/integration/docker-health.sh
```

Expected: every command exits `0` with no skipped launch-critical test.

- [ ] Deploy to Coolify with all commerce flags off. Verify `/data` ownership/persistence, migrations, live/ready health, daily backup, restore drill, HTTPS, host/origin checks, CSP, and log redaction.

- [ ] Enable storefront preview only. Verify real Stripe catalog and public policy content. Keep checkout disabled.

- [ ] Enable MCP and scheduler. Connect Codex with the environment-backed static bearer. Verify read tools and a test-mode preparation/reconciliation workflow.

- [ ] Obtain explicit operator authorization for the single monitored real order. Temporarily enable checkout, place one order, and verify end to end: payment, local order, admin alert, MCP prepare/approval, Styria submit, manual vendor payment, tracking, and Plunk shipping email.

- [ ] Review the monitored order with the operator, legal/accounting conditions, alerts, logs, backup, and customer email. Enable public checkout only after the review is recorded as passed.

- [ ] Commit final runbooks and evidence with `git commit -m "docs: add production launch runbooks"`.

## Phase 4 completion gate

The MVP is complete only when automated verification is green, legal/accountant approvals are recorded, Coolify persistence and restore are proven, Codex connects through the static bearer, and the monitored real order reaches shipping email. A deployment with checkout still intentionally disabled is production-ready but not publicly launched.
