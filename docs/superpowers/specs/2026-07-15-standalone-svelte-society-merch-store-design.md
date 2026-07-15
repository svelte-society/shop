# Standalone Svelte Society Merch Store Design

**Date:** 2026-07-15
**Status:** Approved design; written review complete
**Target:** New standalone application at `shop.sveltesociety.dev`

## Summary

Build a small production-capable Svelte Society merch store as a modular SvelteKit monolith. The store runs as one Node container in Coolify, uses Stripe for catalog, tax, payment, receipts, and invoices, and uses SQLite for fulfillment workflow and audit state. Styria manufactures and ships products. Plunk sends operational and shipping email. A generic internal TMCP server lets one administrator operate fulfillment from Codex or the ChatGPT desktop application's Codex host through one static bearer secret.

The storefront is independent from `sveltesociety.dev`. It reuses the current Society identity and colors but shares no application services, sessions, or customer accounts.

## Goals

- Sell four to eight Svelte Society apparel and accessory products.
- Make community identity the primary emotional promise.
- Preserve the agreed EU, US, EUR, tax, shipping, and returns rules.
- Use Stripe Dashboard as the only catalog back office.
- Require administrator approval before any paid order reaches Styria.
- Operate fulfillment and basic support from Codex through TMCP.
- Send Stripe receipts and invoices automatically after payment.
- Send shipping and tracking email automatically through Plunk.
- Run on Coolify from one Docker image with persistent SQLite data.
- Keep deployment, recovery, and daily backups simple enough for one operator.

## Non-goals

- Customer registration, login, profiles, or saved accounts
- Customer order history or self-service tracking
- Local catalog editing or a catalog administration interface
- A web administration dashboard
- Multiple administrator roles or granular MCP scopes
- ChatGPT web Plugin support or MCP OAuth
- Multiple currencies, discounts, subscriptions, or personalized products
- Automated refunds, cancellations, returns, or replacements
- Automatic Styria submission immediately after payment
- Horizontal application scaling in the MVP

## Fixed Business Rules

1. Svelte School AB is the merchant of record.
2. Styria manufactures and ships standard, non-personalized products on demand.
3. Currency is EUR.
4. Sales destinations are EU member states except Slovenia, plus the United States.
5. Allowed country codes are `AT`, `BE`, `BG`, `HR`, `CY`, `CZ`, `DK`, `EE`, `FI`, `FR`, `DE`, `GR`, `HU`, `IE`, `IT`, `LV`, `LT`, `LU`, `MT`, `NL`, `PL`, `PT`, `RO`, `SK`, `ES`, `SE`, and `US`.
6. The reference item is EUR 20 net and EUR 25 with Swedish 25% VAT.
7. Stripe Tax determines the final tax treatment from destination and business details.
8. One total unit costs EUR 10 to ship. Two or more total units ship free, including two units of the same variant.
9. The EUR 10 shipping charge includes applicable tax and does not vary by destination.
10. US customers pay import duties, brokerage, and carrier charges not collected by the store.
11. Every completed checkout creates a new Stripe Customer.
12. Stripe sends the itemized receipt and invoice. The store does not send a second order-confirmation email.
13. Plunk sends the shipping email and operational alerts.
14. Paid orders require administrator review before submission to Styria.
15. Styria payment remains manual.
16. Returns begin at `merch@sveltesociety.dev` and require approval.
17. Refunds are processed manually in Stripe.
18. Checkout opens publicly only after one monitored real order completes successfully.

## Customer and Brand Direction

### Audience

Primary audience: developers, teachers, meetup attendees, maintainers, and enthusiasts who identify with the Svelte community. Visitors usually arrive from Svelte Society properties, community posts, events, or direct links and already understand Svelte.

### Promise

The store sells community identity, not a donation claim. Copy must not say purchases fund Svelte Society unless that claim becomes documented and true.

### Visual system

The store should feel like a commerce-focused sibling of the current Svelte Society website:

- Svelte orange, slate navy, white, and pale orange surfaces
- Existing Svelte Society mark and logo treatment
- Self-hosted Manrope-led typography from existing Society brand assets
- Clean borders, restrained shadows, and generous whitespace
- Consistent 4:5 product image frames for print-on-demand mockups
- Limited decoration so product art remains dominant
- Subtle transform/opacity motion only
- Full `prefers-reduced-motion` support

Core color tokens should begin with the current site values:

```css
--color-svelte-900: oklch(65.43% 0.2341 34.2);
--color-svelte-500: oklch(71.09% 0.1862 37.91);
--color-svelte-300: oklch(86.8% 0.1825 38.6);
--color-svelte-100: oklch(92.72% 0.0386 39.91);
--color-svelte-50: oklch(97.02% 0.0151 37.88);
```

### UX decisions

- Familiar ecommerce layout: logo at left, cart at right, standard form controls.
- One primary action per surface.
- No catalog filters for four to eight products.
- Optional Apparel and Accessories grouping only when both groups contain useful choices.
- Product card boundaries establish grouping without nesting bordered cards.
- Primary touch targets are at least 44 by 44 CSS pixels.
- Mobile product pages keep the purchase action near the thumb through a sticky bottom bar.
- Important status changes appear beside the action that caused them and use accessible live regions.

These decisions apply Jakob's Law to behavior, Choice Overload to the small catalog, Common Region to product grouping, Selective Attention to calls to action, and Fitts's Law to mobile purchase controls.

## Information Architecture

### Public routes

- `/` — compact hero, catalog, commerce summary
- `/products/[slug]` — product detail and variant selection
- `/cart` — cart review and checkout action
- `/checkout/success` — receipt, fulfillment, and support expectations
- `/checkout/cancel` — preserved-cart recovery
- `/shipping` — regions, rates, delivery estimates, and US import notice
- `/returns` — withdrawal, defects, approval process, and model form
- `/privacy` — processors, retention summary, and customer rights
- `/terms` — seller, payment, tax, fulfillment, and legal terms
- `/about` — short Society-shop context

### Server routes

- `POST /checkout` — validate cart and create Stripe Checkout Session
- `POST /webhooks/stripe` — receive Stripe events using the raw body
- `GET|POST|DELETE /mcp` — TMCP Streamable HTTP transport and session cleanup
- `GET /health/live` — process liveness
- `GET /health/ready` — database, migration, volume, and required-configuration readiness

No public internal scheduler or backup endpoint exists. Jobs run inside the single application process.

## Storefront Content

### Homepage

1. Shipping strip: **Free shipping when you pick two.**
2. Header: Society Shop, collection anchor, cart count, link back to Svelte Society.
3. Hero:
   - Headline: **Made for people who make with Svelte.**
   - Body: **Official Svelte Society merch for meetups, desks, and wherever the community gathers.**
   - CTA: **Shop the collection**
4. Product grid.
5. Shipping, region, tax, and support summary.
6. Policy links and final collection CTA.

### Product page

- Mockup gallery
- Product name and Swedish consumer reference price
- Short identity-led description from Stripe
- Size radios for apparel; no size control for single-variant accessories
- Size guide beside the variant control when configured
- Materials, fit, care, delivery, and returns information
- Shipping-threshold message
- **Add to cart** primary action
- Sticky mobile purchase bar

### Cart

- Dedicated page, not a required drawer
- Product, variant, quantity, and price summary
- Editable quantities and removal
- One-item message: **Add one more item for free shipping.**
- Two-item message: **Free shipping unlocked.**
- Tax note: **Prices shown in EUR. Final tax is confirmed from your delivery and business details at checkout.**
- Region note: **Shipping to the EU, except Slovenia, and the United States.**
- Primary action: **Continue to secure checkout**
- Versioned local-storage persistence containing only Price IDs and quantities

### Empty cart

- Heading: **Your cart is empty.**
- Body: **Pick something made for Svelte people.**
- CTA: **Browse the collection**

### Success page

- Heading: **Order received.**
- Body: **Stripe is emailing your receipt and invoice now. Your order is queued for fulfillment review. We'll email again when it ships.**
- Support: **Need help? Email `merch@sveltesociety.dev`.**

### Failure state

- Heading: **Collection temporarily unavailable.**
- Body: **Your cart is safe. Try again shortly.**

### SEO

- Title: **Svelte Society Shop — Official Community Merch**
- Description: **Official Svelte Society apparel and accessories for Svelte developers. EU and US shipping. Free shipping on orders of two or more items.**

## Application Architecture

### Runtime and tooling

- Project created with the official `sv` CLI through pnpm
- Svelte 5, SvelteKit 2, and TypeScript
- Node.js 24 LTS runtime
- pnpm package management with committed lockfile and exact `packageManager` field
- `adapter-node`
- Valibot runtime validation
- Vitest for unit and integration tests
- Playwright for browser tests
- TMCP for MCP server implementation
- Direct SQL migrations and a thin typed repository layer over `better-sqlite3`

The project bootstrap command belongs in the implementation plan and must use `pnpm dlx sv create`; no Bun or npm commands belong in the project workflow.

### Deployment shape

- One Docker container
- One application process
- One Coolify replica
- Persistent volume mounted at `/data`
- Database path `/data/shop.sqlite`
- HTTPS terminated by Coolify
- Application port exposed only through Coolify routing

### Server modules

Each module has a narrow interface and no route-specific business logic:

- `catalog` — Stripe product and variant contract
- `cart` — untrusted input parsing and limits
- `checkout` — draft creation and Stripe Checkout orchestration
- `orders` — local order state and event history
- `fulfillment` — validation, state transitions, and approval workflow
- `stripe` — Stripe client adapter
- `styria` — Styria signing, payload, create, search, and status adapter
- `plunk` — operational and customer email adapter
- `mcp` — tools, schemas, authentication middleware, and structured results
- `scheduler` — job cadence, leases, recovery, and outbox processing
- `backups` — consistent snapshot, encryption, upload, retention, and restore helpers
- `audit` — structured, non-sensitive append-only events

Routes translate HTTP input into these interfaces. Webhooks, MCP tools, and scheduled jobs call the same domain services.

## Sources of Truth

### Stripe

Stripe owns:

- Products, variants, Prices, images, descriptions, and active state
- Customers and customer email
- Shipping address, phone, company, and VAT ID
- Checkout Sessions, PaymentIntents, automatic tax, invoices, receipts, and refunds
- Final paid totals and tax results

### SQLite

SQLite owns:

- Checkout-time fulfillment snapshots
- Fulfillment workflow state
- Styria order references and tracking state
- Submission approvals and payload hashes
- Outbox and email idempotency state
- Support notes
- Scheduled-job leases and runs
- Non-sensitive audit events

SQLite does not store street addresses, names, phone numbers, VAT IDs, payment method data, authorization headers, or raw provider payloads.

### Styria

Styria owns manufacturing, manual vendor-payment state, production status, shipment time, and tracking number.

### Plunk

Plunk owns delivery records for the paid-order administrator alert and customer shipping email.

### S3-compatible storage

Object storage owns encrypted daily SQLite backups.

## Stripe Catalog Contract

Stripe Dashboard is the only catalog back office.

### Product requirements

An active merch Product must have:

- `name`
- `description`
- At least one HTTPS image
- Physical-goods tax code
- Metadata `product_type=merch`
- Unique metadata `slug`
- Integer metadata `sort_order`
- Metadata `category=apparel` or `category=accessory`
- Metadata `materials`
- Metadata `care`
- Metadata `fit` for apparel
- Immutable metadata `design_reference`
- At least one immutable HTTPS design placement using `design_url_<position>`, such as `design_url_front`
- Optional `size_guide_url`

### Price requirements

An active purchasable variant must have:

- One-time EUR Price
- Integer `unit_amount`
- Explicit exclusive tax behavior
- Metadata `label`
- Integer metadata `sort_order`
- Metadata `sku`
- Metadata `styria_pn`
- Immutable fulfillment metadata after use in a checkout

Malformed Products or Prices are excluded from the catalog and produce an operator-visible diagnostic. Browser input never supplies amount, currency, SKU, tax behavior, Styria product number, or design reference.

Catalog results use a short in-memory validated cache. A recent successful value may be served during a brief Stripe outage. Without a valid cache, the collection shows its unavailable state and checkout remains blocked.

## Cart and Checkout

The browser cart schema contains only:

```ts
type CartLine = {
  priceId: string
  quantity: number
}
```

Limits:

- Maximum 10 distinct Prices
- Maximum 20 total units
- Positive integer quantities only

Before creating Stripe Checkout, the server:

1. Parses the cart with Valibot.
2. Loads and validates every Price and Product from Stripe.
3. Calculates total unit count.
4. Selects the configured paid Shipping Rate for one unit or free Shipping Rate for two or more units.
5. Creates a local checkout draft and immutable line snapshots.
6. Creates a Stripe Checkout Session containing the draft ID and contract version.
7. Records the Session ID on the draft.
8. Returns a redirect URL only after the local and Stripe records are correlated.
9. Expires the Stripe Session when local correlation fails after Session creation.

Checkout configuration includes:

- `mode=payment`
- New Customer creation for every completed checkout
- `automatic_tax.enabled=true`
- Tax-ID collection
- Shipping address and phone collection
- Exact destination allowlist
- Invoice creation
- Server-selected Shipping Rate
- Stripe Price IDs and quantities loaded by the server
- Metadata `product_type=merch`, checkout contract version, and checkout draft ID
- PaymentIntent description identifying Svelte Society merch

The storefront displays a Swedish consumer reference price derived from the exclusive Stripe Price using the configured 25% Swedish reference rate. This is presentation only. Stripe calculates final tax. An accountant must approve the exact display and checkout configuration before launch.

## Local Data Model

Migrations are committed SQL files applied transactionally at startup.

### `checkout_drafts`

- Internal ID
- Stripe Checkout Session ID, unique when assigned
- Contract version
- Currency
- Total unit count
- Selected shipping mode
- Creation and expiry timestamps
- Completion timestamp

### `checkout_draft_lines`

- Draft ID
- Stripe Product ID and Price ID
- Product name and variant label
- SKU and Styria product number
- Design reference and canonical design-placement JSON
- Quantity, unit amount, and currency

### `orders`

- Internal ID
- Stripe Checkout Session ID, unique
- Stripe PaymentIntent ID, unique
- Stripe Customer ID
- Checkout draft ID
- Currency plus subtotal, discount, shipping, tax, and total in integer cents
- Destination country code
- Independent payment status
- Independent fulfillment status
- Styria order ID and normalized status
- Tracking number
- Submission, shipment, and update timestamps
- Stable last error code

Payment status is `paid`, `partially_refunded`, or `refunded`.

Fulfillment status is one of:

- `pending_review`
- `submitting`
- `submitted`
- `awaiting_vendor_payment`
- `in_production`
- `shipped`
- `review_required`
- `cancelled`

Payment and fulfillment remain separate. A refund never implies manufacturing cancellation.

### `stripe_events`

- Stripe Event ID, unique
- Event type
- Processing status
- Referenced Checkout Session or PaymentIntent ID when applicable
- Stable error code
- First-seen and completed timestamps

This table provides durable webhook deduplication without retaining raw webhook bodies.

### `order_lines`

Immutable copy of validated checkout-draft lines attached to the paid order.

### `order_events`

Append-only non-sensitive events containing order, actor, action, prior state, next state, result, stable error code, and timestamp.

### `submission_approvals`

- Random approval ID
- Order ID
- Payload hash
- Fixed actor `codex-admin`
- Expiration timestamp
- Used timestamp

Approvals expire after ten minutes and can be used once.

### `outbox_jobs`

- Job kind
- Unique idempotency key
- Referenced order ID
- Attempt count
- Next-attempt timestamp
- Completion timestamp
- Stable last error code

Outbox payloads contain internal and provider IDs only, never customer details.

### `email_deliveries`

- Order ID
- Email kind
- Tracking reference when applicable
- Unique idempotency key
- Provider delivery ID
- Attempt and completion timestamps

### `support_notes`

Concise current outcome, external support reference, fixed actor, and timestamp. Detailed customer communication stays in the support mailbox.

### `job_leases` and `job_runs`

Prevent overlapping work and record scheduler outcomes.

No automatic local order deletion ships in the MVP. Financial retention remains in Stripe. The privacy policy describes the operational records stored locally, and a manual maintenance command supports reviewed deletion when required.

## Paid-order Flow

Stripe's webhook performs deterministic, idempotent processing:

1. Verify the raw request signature.
2. Deduplicate by Stripe Event ID.
3. Retrieve the complete Checkout Session and all paginated line items.
4. Require paid status, EUR currency, supported destination, required customer data, and a valid checkout draft.
5. Compare Stripe line items and totals with the immutable draft.
6. In one SQLite transaction, create or update the order, copy order lines, append the audit event, and enqueue the administrator-alert outbox job.
7. Return success only after transaction commit.

Plunk is not called inside the webhook transaction. The outbox scheduler sends the paid-order alert and retries failures without replaying commercial state.

Stripe emails the customer receipt and invoice. The store sends no duplicate order confirmation.

Refund events update payment status only. They do not call Styria or claim fulfillment cancellation.

## Internal MCP Server

### Transport and client

- Generic internal Streamable HTTP MCP at `/mcp`
- TMCP implementation
- Launch client: Codex through the ChatGPT desktop application's shared Codex host
- No published ChatGPT web Plugin
- No OAuth, GitHub login, DCR, PKCE, roles, or scopes

### Static bearer authentication

Coolify stores one random secret with at least 256 bits of entropy:

```env
MCP_BEARER_TOKEN=<secret>
```

The Codex host stores the same value under a client-side environment variable:

```env
SVELTE_SHOP_MCP_TOKEN=<same-secret>
```

Codex configuration references the environment variable rather than embedding the secret:

```toml
[mcp_servers.svelte_society_shop]
url = "https://shop.sveltesociety.dev/mcp"
bearer_token_env_var = "SVELTE_SHOP_MCP_TOKEN"
default_tools_approval_mode = "writes"
```

The server requires `Authorization: Bearer <secret>` and compares the supplied value with `MCP_BEARER_TOKEN` in constant time. Missing or invalid values receive `401 Unauthorized`. The header and secret are always redacted. Rotation is an explicit operational procedure that updates Coolify and the Codex host together.

All authenticated MCP activity uses audit actor `codex-admin`.

### Tools

#### `list_pending_orders`

Read-only. Lists paid orders in `pending_review` or `review_required`, ordered oldest first, with no customer address or phone.

#### `inspect_order`

Read-only. Returns payment, line, tax, support, and fulfillment summaries. Retrieves customer and shipping details from Stripe only when necessary for review and redacts unused fields.

#### `prepare_styria_submission`

Mutation because it creates an approval record. Validates the order, retrieves current Stripe fulfillment details, builds the exact Styria payload, returns warnings and blockers, hashes the payload, and creates a ten-minute one-use approval.

#### `submit_styria_order`

Mutation. Requires approval ID, recomputes the payload, verifies the hash and expiry, and checks Styria for the Stripe Checkout Session ID as `external_id`. It sets `submitting` immediately before the bounded create request. Confirmed success stores the Styria order ID and returns a manual-payment reminder.

Timeout, connection loss, malformed success, or ambiguous response sets `review_required`. Automatic retry is forbidden.

#### `reconcile_styria_order`

Mutation. Searches Styria using `external_id`, timestamp, destination, and line summary. One exact match repairs local state. Ambiguous matches stay blocked for manual review.

#### `check_fulfillment_status`

Mutation. Retrieves current Styria status and updates normalized local state.

#### `resend_shipping_email`

Mutation. Shows the target email and tracking reference before sending, then uses a new explicit support-action idempotency key and records the action.

#### `record_return_or_replacement`

Mutation. Writes a concise support outcome and external reference. Refund action remains in Stripe Dashboard.

Every tool has Valibot input/output schemas, structured results, stable error codes, and accurate read/write/destructive annotations.

## Styria Submission Safety

- Stripe Checkout Session ID is the Styria `external_id`.
- Every create attempt first searches for an existing exact `external_id`.
- Approval binds order, current payload hash, actor, expiry, and single use.
- A changed address, line, price, or design invalidates approval.
- `submitting` is committed before the network create call.
- Ambiguous network outcomes always become `review_required`.
- Only reconciliation can clear ambiguity.
- Vendor payment remains manual and visible in tool results and order events.

## Scheduler and Email

One scheduler starts once after application readiness when `SCHEDULER_ENABLED=true`.

Cadence:

- Every minute: drain due outbox jobs.
- Hourly: inspect non-terminal Styria orders and orders with tracking but no recorded shipping email.
- Daily: create and upload the encrypted SQLite backup.
- Daily: detect paid orders still awaiting review after 24 hours and enqueue an administrator alert.

Database leases prevent overlapping runs. A lease expires after a bounded interval so restart recovery can continue abandoned work.

When tracking appears:

1. Read Styria order and tracking data.
2. Load the correlated Stripe Checkout Session.
3. Verify paid merch order and retrieve customer email.
4. Enqueue `shipping:<order-id>:<tracking-number>` exactly once.
5. Send through Plunk.
6. Record delivery ID, shipped state, tracking number, and send time.

At-least-once processing is accepted. The database idempotency key prevents normal duplicates. A process failure after Plunk accepts an email but before local completion can still produce a rare duplicate; losing the only shipping email is considered worse.

Outbox retries use bounded exponential backoff. After six failed attempts, processing continues at an hourly cadence and an operator alert is created.

## Backups and Recovery

Daily backup flow:

1. Use SQLite's online backup support to create a consistent snapshot.
2. Encrypt the snapshot with AES-256-GCM using a dedicated Coolify secret.
3. Upload the encrypted file and checksum to configured S3-compatible storage.
4. Delete the local temporary snapshot after confirmed upload.
5. Keep 30 rolling daily backups through bucket lifecycle or application cleanup.

The repository includes documented backup and restore commands. Restore requires checkout maintenance mode, container shutdown, snapshot download, decryption, integrity check, replacement of `/data/shop.sqlite`, migration verification, and application restart.

A production-shaped restore drill must pass before launch.

## Security and Privacy

- All secrets remain in Coolify or the local Codex host.
- HTTPS is mandatory.
- Production Host values are allowlisted.
- Origin is validated when present.
- Checkout, webhook-adjacent, and MCP routes are rate-limited.
- Proxy headers are trusted only from the Coolify deployment boundary.
- Stripe webhook signatures use the raw request body.
- Browser-controlled prices, totals, metadata, destinations, and fulfillment identifiers are ignored.
- Styria requests use documented signing and strict timeouts.
- Stripe Product descriptions render as plain text; no unsanitized HTML is accepted.
- CSP limits scripts, frames, images, and network destinations to required providers.
- Logs are structured JSON and exclude names, addresses, email addresses, phone numbers, VAT IDs, raw webhooks, provider signatures, and authorization headers.
- MCP results return only personal data needed for the requested fulfillment or support action.
- Stable error codes replace raw provider payloads and stack traces in user-visible results.
- SQLite file permissions restrict access to the runtime user.
- Container runs as a non-root user.

## Failure and Recovery Rules

- Stripe catalog unavailable: serve recent validated memory cache or show unavailable state.
- Stripe checkout unavailable: preserve browser cart and block redirect.
- Checkout Session created but local correlation fails: expire Session and return an error.
- Webhook database failure: return non-2xx for Stripe retry.
- Duplicate or out-of-order webhook: converge through event and object idempotency.
- Plunk unavailable: keep outbox job and retry.
- Styria create ambiguous: set `review_required`; never retry automatically.
- Styria status unavailable: retain current state and retry next hourly run.
- SQLite busy: apply configured busy timeout; fail closed after timeout.
- SQLite missing, read-only, corrupt, or volume nearly full: readiness fails and checkout is disabled.
- Scheduler failure: log structured error, release or expire lease, and retry next cadence.
- Backup failure: retain source database, create operator alert, and retry next daily run.
- Invalid MCP secret: return `401`, record a non-sensitive rate-limited security event, and reveal no tool data.

External provider outages do not block policy pages, liveness, or webhook authentication. Readiness depends on local database and configuration, not transient provider availability.

## Coolify and Docker

The repository includes a multi-stage Dockerfile:

- Node 24 LTS base
- pnpm enabled and pinned
- Dependency installation from the lockfile
- SvelteKit build in the build stage
- Production dependencies and adapter-node output only in the runtime stage
- Non-root runtime user with write access only to `/data`
- Port and healthcheck configured for Coolify
- `SIGTERM` graceful shutdown

Required Coolify configuration includes:

- Domain `shop.sveltesociety.dev`
- Persistent volume mounted at `/data`
- Stripe keys, webhook secret, paid/free Shipping Rate IDs, and feature flags
- Styria App ID, signing secret, base URL, and timeout
- Plunk key, URL, and verified sender
- Static MCP bearer secret
- S3 endpoint, bucket, region, credentials, prefix, and encryption key
- Umami site ID and script origin
- Seller identity and support email
- Production origin and Host allowlist

SQLite configuration:

- WAL journal mode
- Foreign keys enabled
- Busy timeout
- Synchronous mode appropriate for durable local writes
- Startup integrity and migration check

Feature flags:

- `STOREFRONT_ENABLED`
- `CHECKOUT_ENABLED`
- `MCP_ENABLED`
- `SCHEDULER_ENABLED`

When `STOREFRONT_ENABLED=false`, public commerce routes show a branded opening-soon state while policy and health routes remain available. When `MCP_ENABLED=false`, `/mcp` returns not found. Disabling checkout blocks new Checkout Sessions but leaves webhooks, MCP reconciliation, support tools, scheduler, and shipping email active.

## Analytics and Monitoring

Use the existing Svelte Society Umami deployment.

Anonymous events:

- Product viewed
- Variant selected
- Added to cart
- Cart viewed
- Checkout started
- Checkout returned successfully
- Checkout cancelled

No order ID, email, customer ID, address, VAT ID, or cart contents enter analytics.

Operational alerts:

- Paid order pending review for more than 24 hours
- `review_required` Styria submission
- Scheduler failure
- Tracking found but shipping email unsent
- Backup failure or missed backup
- Catalog or checkout outage
- Repeated invalid MCP authentication
- Low disk or failed SQLite readiness

## Public Policies

Before checkout opens, publish:

- Svelte School AB seller identity and contact details
- EUR pricing and VAT presentation
- Supported and excluded destinations
- Shipping rates and delivery estimates
- US import-duty responsibility
- EU withdrawal instructions and model form
- Damaged and incorrect-item remedies
- Return approval and postage rules
- `merch@sveltesociety.dev` support contact
- Privacy processors and retention summary for Stripe, Styria, Plunk, shipping carriers, Umami, logs, local fulfillment state, and encrypted backups

Do not publish the internal 24-hour review alert as a customer service-level promise.

An accountant must approve tax registrations, seller presentation, and Styria ship-from treatment. Legal policy text must receive qualified review before launch.

## Testing Strategy

### Unit tests

- Stripe Product and Price contract parsing
- Reference price and integer-cent formatting
- Cart schema, quantity limits, and totals
- Destination allowlist and Slovenia rejection
- Paid/free shipping selection
- Payment and fulfillment state machines
- Checkout snapshot comparison
- Styria signing, payload generation, response parsing, and status mapping
- Approval expiry, hash binding, and replay rejection
- Static bearer comparison and redaction
- Email and outbox idempotency
- Log and MCP-result personal-data redaction

### Integration tests

- SQLite migrations, transactions, uniqueness, busy handling, leases, and recovery
- Checkout draft and Stripe Session correlation
- Stripe Checkout creation for EU consumer, US, reverse-charge, paid shipping, and free shipping
- Stripe webhook signature, pagination, retries, duplication, and out-of-order delivery
- TMCP initialization, tool listing, structured output, stable errors, and annotations
- MCP missing, invalid, and valid bearer behavior
- Styria create, list, status, tracking, ambiguity, and reconciliation using a contract-faithful fake
- Plunk outbox retries and shipping-email correlation
- Scheduler restart recovery
- Backup encryption, S3 upload fake, retention, corruption detection, and restore

### Browser tests

- Homepage, product, cart, checkout redirect, success, cancel, and failure states
- Apparel size selection and accessory purchase
- One-unit paid shipping and two-unit free shipping
- Cart persistence and recovery
- Checkout-disabled and catalog-unavailable behavior
- Keyboard navigation, focus, labels, live regions, and semantic landmarks
- Reduced-motion behavior
- Responsive layouts at 320, 768, 1024, and 1440 pixels
- Chromium, Firefox, and WebKit smoke coverage

### Production verification

- Stripe test-mode tax and total matrix
- ChatGPT desktop/Codex MCP connection using the static bearer secret
- Test Styria submission and ambiguity recovery
- Automated tracking email to a non-customer mailbox
- Encrypted backup and production-shaped restore drill
- One monitored real order from checkout through shipping email

## Launch Sequence

1. Scaffold with `pnpm dlx sv create` using the official `sv` CLI.
2. Implement and verify the modular monolith.
3. Configure Stripe catalog, Prices, tax codes, metadata, Shipping Rates, and email settings.
4. Publish reviewed policies.
5. Deploy to Coolify with checkout disabled.
6. Verify persistent volume, migrations, healthchecks, and backup restore.
7. Connect the ChatGPT desktop Codex host to `/mcp` with the bearer secret.
8. Pass Stripe, Styria, Plunk, MCP, browser, and operational test matrices.
9. Enable storefront while keeping checkout disabled.
10. Enable checkout for one monitored real order.
11. Confirm payment, local order creation, administrator alert, MCP approval, Styria submission, manual vendor payment, tracking detection, and shipping email.
12. Review results and enable checkout publicly.

## Definition of Done

- Storefront matches approved Svelte Society visual and copy direction.
- Stripe catalog contract is documented and enforced.
- All configured products and variants validate.
- Tax and shipping rules pass required examples.
- Required public policies are reviewed and published.
- SQLite persists across Coolify redeployment.
- Encrypted daily backup and restore work.
- Paid webhook is idempotent and durable.
- Codex MCP connection works with the static bearer secret.
- Two-step Styria approval and ambiguous-response recovery work.
- Hourly tracking sync and Plunk shipping email work.
- Accessibility, responsive, integration, and browser suites pass.
- Monitoring and operational alerts are active.
- One monitored real order completes through shipping email.
- Checkout is enabled only after the real-order review passes.

## References

- Current brand source: `svelte-society/sveltesociety.dev`
- Svelte CLI: <https://svelte.dev/docs/cli/sv-create>
- Stripe Checkout: <https://docs.stripe.com/payments/checkout>
- Stripe Tax IDs: <https://docs.stripe.com/tax/checkout/tax-ids>
- Styria API: <https://styriashirts.eu/api-documentation>
- TMCP: <https://tmcp.io/docs>
- Codex MCP configuration: <https://learn.chatgpt.com/docs/extend/mcp>
- MCP authorization specification: <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>
- Node release status: <https://nodejs.org/en/about/previous-releases>
