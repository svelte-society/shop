# Phase 3: Fulfillment and Internal MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the administrator-operated fulfillment workflow: Styria preparation/approval/submission/reconciliation, static-bearer TMCP tools for Codex, hourly fulfillment sync, and idempotent Plunk shipping email.

**Architecture:** A provider-independent fulfillment service owns state transitions and approvals. A Styria adapter signs and validates the documented JSON API. TMCP exposes thin structured tools over the same services and is guarded before protocol handling by one constant-time bearer check. The scheduler polls non-terminal Styria orders and enqueues shipping email without storing customer contact details.

**Tech Stack:** Existing stack plus `tmcp` 1.19.4, `@tmcp/transport-http` 0.8.6, `@tmcp/adapter-valibot` 0.1.6, Node `crypto`, Styria JSON API, Plunk.

## Global Constraints

- Start only after the Phase 2 gate is green.
- Launch client is Codex through the ChatGPT desktop application's shared Codex host; do not publish a ChatGPT web Plugin.
- Use one administrator actor: `codex-admin`. Do not add users, roles, scopes, OAuth, PKCE, DCR, or a token table.
- Read `MCP_BEARER_TOKEN` only from server environment. Codex reads the same secret from `SVELTE_SHOP_MCP_TOKEN`; never write either value to config files, logs, SQLite, tool results, or error messages.
- Styria create always requires a current ten-minute approval tied to a canonical payload hash.
- Commit `submitting` before the network create. Any timeout, connection loss, malformed success, or uncertain response becomes `review_required`; never retry create automatically.
- Styria vendor payment stays manual and appears in submission results.
- Retrieve customer email and shipping details from Stripe only when the current action needs them. Do not persist those values locally.

---

## Task 1: Implement fulfillment state and repository operations

**Files:**

- Create: `src/lib/domain/fulfillment.ts`
- Create: `src/lib/domain/fulfillment.test.ts`
- Create: `src/lib/server/fulfillment/repository.server.ts`
- Create: `src/lib/server/fulfillment/repository.test.ts`
- Modify: `src/lib/server/db/orders.server.ts`
- Modify: `src/lib/server/audit/order-events.server.ts`

**Interfaces produced:**

```ts
export type FulfillmentStatus =
  | 'pending_review'
  | 'submitting'
  | 'submitted'
  | 'awaiting_vendor_payment'
  | 'in_production'
  | 'shipped'
  | 'review_required'
  | 'cancelled';

export function assertTransition(from: FulfillmentStatus, to: FulfillmentStatus): void;
export function mapStyriaStatus(input: { status: string; deleted: boolean; trackingNumber: string | null }): FulfillmentStatus;

export interface FulfillmentRepository {
  listPending(limit: number): OrderSummary[];
  inspect(orderId: string): OrderWithLinesAndEvents | null;
  beginSubmission(orderId: string, approvalId: string, payloadHash: string, now: Date): void;
  recordSubmitted(orderId: string, styriaOrderId: string, styriaStatus: string, now: Date): void;
  requireReview(orderId: string, errorCode: string, now: Date): void;
  applyStyriaStatus(orderId: string, update: StyriaStatusUpdate, now: Date): void;
  recordSupportNote(input: NewSupportNote): void;
}
```

- [ ] Write failing state tests for allowed lifecycle transitions, forbidden skips, refund independence, received/manual-payment mapping, production statuses, tracking-to-shipped, deleted/refunded/internal-query review handling, and unknown status review handling.

- [ ] Use this explicit transition table; no route or tool may set status directly:

```ts
const ALLOWED: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
  pending_review: ['submitting', 'review_required', 'cancelled'],
  submitting: ['awaiting_vendor_payment', 'review_required'],
  submitted: ['awaiting_vendor_payment', 'in_production', 'shipped', 'review_required', 'cancelled'],
  awaiting_vendor_payment: ['in_production', 'shipped', 'review_required', 'cancelled'],
  in_production: ['shipped', 'review_required', 'cancelled'],
  shipped: ['review_required'],
  review_required: ['pending_review', 'awaiting_vendor_payment', 'in_production', 'shipped', 'cancelled'],
  cancelled: ['review_required']
};
```

- [ ] Write failing repository tests proving `beginSubmission` atomically validates/consumes approval, verifies current state and hash, moves to `submitting`, and appends an audit event. Test expiry, replay, wrong order, wrong hash, wrong actor, concurrent use, and every provider-result mutation.

- [ ] Implement all mutations as database transactions with actor `codex-admin`, prior/next state, result, stable error code, and timestamp. Do not include tool arguments or provider responses in audit events.

- [ ] Run `pnpm vitest run src/lib/domain/fulfillment.test.ts src/lib/server/fulfillment/repository.test.ts && pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: add fulfillment state workflow"`.

---

## Task 2: Build the Styria signing, payload, and API adapter

**Files:**

- Create: `src/lib/server/styria/types.ts`
- Create: `src/lib/server/styria/signing.ts`
- Create: `src/lib/server/styria/signing.test.ts`
- Create: `src/lib/server/styria/payload.ts`
- Create: `src/lib/server/styria/payload.test.ts`
- Create: `src/lib/server/styria/gateway.ts`
- Create: `src/lib/server/styria/client.server.ts`
- Create: `src/lib/server/styria/client.test.ts`
- Create: `tests/fixtures/styria.ts`
- Create: `docs/operations/styria-contract.md`

**Interfaces produced:**

```ts
export type StyriaOrderPayload = {
  external_id: string;
  brandName: string;
  comment: string;
  shipping_address: {
    firstName: string;
    lastName: string;
    company: string;
    address1: string;
    address2: string;
    city: string;
    county: string;
    postcode: string;
    country: string;
    phone1: string;
  };
  shipping: { shippingMethod: 'courier' };
  items: Array<{
    pn: string;
    quantity: number;
    retailPrice: number;
    description: string;
    designs: Record<string, string>;
  }>;
};

export interface StyriaGateway {
  searchByExternalId(externalId: string, createdAfter: Date): Promise<StyriaOrder[]>;
  create(payload: StyriaOrderPayload): Promise<StyriaOrder>;
  get(orderId: string): Promise<StyriaOrder>;
}
```

- [ ] Before coding, re-read `https://styriashirts.eu/api-documentation`, record its `article:modified_time`, endpoints, signing text, accepted status list, create fields, and any account-specific differences in `docs/operations/styria-contract.md`. Resolve differences in favor of the live account and amend this plan/spec before continuing if create semantics materially changed.

- [ ] Write failing signing tests. POST signature is lower-case SHA-1 of the exact UTF-8 JSON body concatenated with the secret. GET signature is lower-case SHA-1 of the exact canonical query string excluding `Signature`, concatenated with the secret.

```ts
export function signPost(body: string, secret: string): string {
  return createHash('sha1').update(body + secret, 'utf8').digest('hex');
}

export function signGet(queryWithoutSignature: string, secret: string): string {
  return createHash('sha1').update(queryWithoutSignature + secret, 'utf8').digest('hex');
}
```

- [ ] Write failing payload tests for EU/US addresses, company optionality, phone required, full country name conversion, Price-to-`pn`, quantity, two-decimal EUR `retailPrice`, checkout-snapshotted design positions, immutable design references, courier shipping, external ID equal to Stripe Checkout Session ID, and rejection of missing fulfillment data.

- [ ] Build JSON with a stable recursive canonicalizer for payload hashing, but sign the exact serialized body actually sent. Use `SHA-256(canonicalJson(payload))` for approvals and Styria's documented SHA-1 only for API authentication.

- [ ] Write client tests for `GET /api/orders.php` page size 250, local exact `external_id` filtering across pages, `GET /api/order.php`, `POST /api/orders.php`, deterministic query ordering, AppId/Signature, JSON response validation, 10-second timeout, HTTP errors, malformed success, and no PII/provider body logging.

- [ ] Implement search by paging orders created after the local order timestamp and filtering exact `external_id`; the public Styria list documentation does not promise an `external_id` query filter.

- [ ] Run `pnpm vitest run src/lib/server/styria && pnpm check`.

Expected: pass.

- [ ] With a non-production Styria account, run one signed list and one signed detail request. Record only timestamp, endpoint, HTTP status, and stable result code in the contract document; record no returned order data.

- [ ] Commit with `git commit -m "feat: add signed Styria API adapter"`.

---

## Task 3: Implement preparation and one-use approval

**Files:**

- Modify: `src/lib/server/stripe/gateway.ts`
- Modify: `src/lib/server/stripe/client.server.ts`
- Create: `src/lib/server/fulfillment/prepare.server.ts`
- Create: `src/lib/server/fulfillment/prepare.test.ts`
- Create: `src/lib/server/fulfillment/approvals.server.ts`
- Create: `src/lib/server/fulfillment/approvals.test.ts`

**Interfaces consumed:** local order/lines; transient Stripe customer/shipping details; Styria payload builder.

**Interfaces produced:**

```ts
export type FulfillmentDetails = {
  recipient: { firstName: string; lastName: string; company: string; phone: string };
  address: { line1: string; line2: string; city: string; state: string; postalCode: string; countryCode: string };
  email: string;
};

export interface StripeFulfillmentGateway {
  retrieveFulfillmentDetails(checkoutSessionId: string): Promise<FulfillmentDetails>;
}

export type PreparationResult = {
  orderId: string;
  approvalId: string;
  expiresAt: string;
  payloadHash: string;
  payload: StyriaOrderPayload;
  warnings: Array<{ code: string; message: string }>;
  blockers: Array<{ code: string; message: string }>;
};

export interface PreparationService {
  prepare(orderId: string, now?: Date): Promise<PreparationResult>;
}
```

- [ ] Write failing Stripe adapter tests for complete name/address/phone/email, missing fields, unsupported destination, and response redaction. Return PII only from this method; do not cache it.

- [ ] Write failing preparation tests for paid/pending order, refunded warning without automatic block, terminal fulfillment block, missing design block, unsupported country block, exact Styria payload, deterministic hash, random approval ID, ten-minute expiry, and no local PII writes.

- [ ] Insert an approval only when `blockers` is empty. Use `crypto.randomBytes(32).toString('base64url')` for approval ID and `now + 10 minutes` for expiry.

- [ ] Return the payload so the administrator can review exactly what will be sent. Do not include customer email because Styria create does not need it.

- [ ] Run focused tests and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: prepare approved Styria submissions"`.

---

## Task 4: Implement submission and ambiguity reconciliation

**Files:**

- Create: `src/lib/server/fulfillment/submit.server.ts`
- Create: `src/lib/server/fulfillment/submit.test.ts`
- Create: `src/lib/server/fulfillment/reconcile.server.ts`
- Create: `src/lib/server/fulfillment/reconcile.test.ts`

**Interfaces produced:**

```ts
export interface SubmissionService {
  submit(input: { orderId: string; approvalId: string }, now?: Date): Promise<{
    orderId: string;
    styriaOrderId: string;
    fulfillmentStatus: 'awaiting_vendor_payment';
    manualPaymentRequired: true;
  }>;
}

export interface ReconciliationService {
  reconcile(orderId: string, now?: Date): Promise<{
    outcome: 'reconciled' | 'not_found' | 'ambiguous';
    matches: number;
    fulfillmentStatus: FulfillmentStatus;
  }>;
}
```

- [ ] Write submission tests for expired/wrong/replayed approval, changed Stripe address, changed line/design/price hash, preflight existing exact order, successful create, deterministic `4xx`, timeout, connection reset, malformed `2xx`, and database failure after create.

- [ ] Submission sequence must be exact:

```text
rebuild payload -> hash -> consume approval and commit submitting
-> search Styria exact external_id
-> if one exact match, record it without create
-> if zero, call create once
-> if confirmed valid success, record awaiting_vendor_payment
-> otherwise commit review_required and return a reconciliation instruction
```

- [ ] Do not wrap the network call in a database transaction. If confirmed create succeeds but the subsequent local write fails, treat the outcome as ambiguous and require reconciliation.

- [ ] Write reconciliation tests for zero, one, and multiple exact `external_id` matches; use created timestamp, destination country, and local line summary as secondary evidence. Only one exact, consistent match may repair local state.

- [ ] Run focused tests and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: submit and reconcile Styria orders"`.

---

## Task 5: Add constant-time bearer guard and TMCP transport

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/lib/server/mcp/auth.server.ts`
- Create: `src/lib/server/mcp/auth.test.ts`
- Create: `src/lib/server/mcp/server.ts`
- Create: `src/lib/server/mcp/transport.server.ts`
- Create: `src/routes/mcp/+server.ts`
- Create: `src/routes/mcp/mcp-route.test.ts`

**Interfaces produced:**

```ts
export function authorizeBearer(header: string | null, expectedSecret: string): boolean;
export function createMcpServer(services: McpServices): McpServer;
export function handleMcp(request: Request): Promise<Response>;
```

- [ ] Install exact dependencies:

```bash
pnpm add tmcp@1.19.4 @tmcp/transport-http@0.8.6 @tmcp/adapter-valibot@0.1.6
```

- [ ] Write bearer tests for missing header, wrong scheme, empty token, whitespace variants, short/long wrong tokens, correct token, absent server secret, and an assertion that logs/results contain neither supplied nor expected token.

- [ ] Implement fixed-length comparison by hashing both supplied and expected token before `timingSafeEqual`:

```ts
export function authorizeBearer(header: string | null, expectedSecret: string): boolean {
  const match = header?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match || expectedSecret.length === 0) return false;
  const supplied = createHash('sha256').update(match[1]).digest();
  const expected = createHash('sha256').update(expectedSecret).digest();
  return timingSafeEqual(supplied, expected);
}
```

- [ ] Construct TMCP with `ValibotJsonSchemaAdapter`, tools capability, and instructions that this is the internal Svelte Society Shop fulfillment server for one `codex-admin` operator.

```ts
const server = new McpServer(
  { name: 'svelte-society-shop', version: '1.0.0' },
  {
    adapter: new ValibotJsonSchemaAdapter(),
    capabilities: { tools: { listChanged: false } },
    instructions: 'Operate paid Svelte Society Shop orders. Prepare before submit; reconcile every ambiguous Styria create.'
  }
);
const transport = new HttpTransport(server, { path: '/mcp' });
```

- [ ] Guard the route before `transport.respond(request)`. Return `404` when `MCP_ENABLED=false`, `401` with `WWW-Authenticate: Bearer` for bad auth, and the transport response for authenticated GET/POST/DELETE requests. Do not enable browser CORS.

- [ ] Add TMCP protocol tests for initialize, tools/list, missing/invalid/valid bearer, disabled flag, session header preservation, and DELETE cleanup.

- [ ] Run focused tests and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: secure internal TMCP endpoint"`.

---

## Task 6: Register all fulfillment and support tools

**Files:**

- Create: `src/lib/server/mcp/result.ts`
- Create: `src/lib/server/mcp/tools/list-pending.ts`
- Create: `src/lib/server/mcp/tools/inspect-order.ts`
- Create: `src/lib/server/mcp/tools/prepare-styria.ts`
- Create: `src/lib/server/mcp/tools/submit-styria.ts`
- Create: `src/lib/server/mcp/tools/reconcile-styria.ts`
- Create: `src/lib/server/mcp/tools/check-status.ts`
- Create: `src/lib/server/mcp/tools/resend-shipping.ts`
- Create: `src/lib/server/mcp/tools/record-support.ts`
- Create: `src/lib/server/mcp/tools/tools.test.ts`
- Modify: `src/lib/server/mcp/server.ts`

**Tool contract:**

| Tool | Input | Annotation |
|---|---|---|
| `list_pending_orders` | `{limit?: 1..100}` | read-only, idempotent, closed-world |
| `inspect_order` | `{order_id, include_shipping_details?: boolean}` | read-only, idempotent, open-world |
| `prepare_styria_submission` | `{order_id}` | write, non-destructive, open-world |
| `submit_styria_order` | `{order_id, approval_id}` | write, open-world, non-idempotent |
| `reconcile_styria_order` | `{order_id}` | write, open-world, idempotent |
| `check_fulfillment_status` | `{order_id}` | write, open-world, idempotent |
| `resend_shipping_email` | `{order_id, mode, expected_email?, expected_tracking_number?}` | write/open-world only for `mode='send'` |
| `record_return_or_replacement` | `{order_id, outcome, note?, external_reference?}` | write, closed-world |

- [ ] Write failing protocol-level tests for all tool names, Valibot input rejection, structured output, required JSON-string text mirror, stable error result with `isError: true`, and exact annotations.

- [ ] Implement a result helper that always returns both `content[0].text=JSON.stringify(data)` and `structuredContent=data`. Catch domain/provider errors and return stable codes; never return stack traces or raw provider bodies.

- [ ] `list_pending_orders` returns oldest first and excludes customer contact data. `inspect_order` returns contact data only when explicitly requested and necessary.

- [ ] `resend_shipping_email` defaults to `mode='preview'` and returns the current target email/tracking without sending. `mode='send'` requires exact `expected_email` and `expected_tracking_number` matches so the administrator has reviewed the target.

- [ ] `record_return_or_replacement` accepts an outcome enum (`return_approved`, `return_received`, `replacement_ordered`, `replacement_shipped`, `refund_processed`, `request_declined`, `other_reviewed`), an optional note of at most 160 characters, and an external reference of at most 120 characters. Reject line breaks and obvious email/address/phone content; detailed customer communication stays in the support mailbox. It does not refund Stripe or mutate Styria.

- [ ] Run `pnpm vitest run src/lib/server/mcp/tools/tools.test.ts && pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: expose fulfillment MCP tools"`.

---

## Task 7: Add hourly Styria sync and shipping email

**Files:**

- Create: `src/lib/server/plunk/shipping-email.ts`
- Create: `src/lib/server/plunk/shipping-email.test.ts`
- Create: `src/lib/server/jobs/styria-sync.server.ts`
- Create: `src/lib/server/jobs/styria-sync.test.ts`
- Modify: `src/lib/server/jobs/outbox-worker.server.ts`
- Modify: `src/lib/server/jobs/scheduler.server.ts`
- Modify: `src/lib/server/db/outbox.server.ts`

**Interfaces produced:**

```ts
export interface StyriaSyncJob {
  run(now?: Date): Promise<{ checked: number; updated: number; shippingQueued: number }>;
}

export type ShippingEmailInput = {
  recipientEmail: string;
  productSummary: string;
  trackingNumber: string;
  supportEmail: string;
};
```

- [ ] Write email tests for the exact subject `Your Svelte Society order is on the way`, warm developer-aware copy, tracking number, no raw address/phone/VAT data, verified sender, reply-to support, and provider delivery ID capture. Body structure: `Your Svelte Society merch has shipped.`, concise product summary, `Tracking: <number>`, `Thanks for being part of the Svelte community.`, and the support contact.

- [ ] Write sync tests for non-terminal order selection, current Styria status mapping, unavailable provider retaining state, unknown status requiring review, tracking discovery, `shipping:<order-id>:<tracking-number>` idempotency, restart recovery, and tracking with already-completed delivery.

- [ ] When tracking first appears, update local tracking/state and enqueue the shipping job atomically. The outbox handler retrieves current customer email from Stripe immediately before Plunk send; it does not store email in the outbox or `email_deliveries`.

- [ ] Add a one-hour scheduler cadence with a 55-minute lease. Also retry orders that have tracking but no completed matching `email_deliveries` row.

- [ ] Preserve the documented at-least-once tradeoff: a crash after Plunk accepts but before local completion may duplicate an email; do not mark success before Plunk accepts.

- [ ] Run focused tests and `pnpm check`.

Expected: pass.

- [ ] Commit with `git commit -m "feat: sync Styria tracking and email customers"`.

---

## Task 8: Verify MCP from Codex and the fulfillment lifecycle

**Files:**

- Create: `docs/operations/codex-mcp.md`
- Create: `tests/integration/mcp-fulfillment.spec.ts`
- Create: `tests/integration/styria-ambiguity.spec.ts`
- Create: `tests/integration/shipping-email.spec.ts`

- [ ] Document secret generation and rotation without printing the secret:

```bash
openssl rand -hex 32
```

Store the output as Coolify `MCP_BEARER_TOKEN` and local host `SVELTE_SHOP_MCP_TOKEN`.

- [ ] Document the Codex configuration exactly:

```toml
[mcp_servers.svelte_society_shop]
url = "https://shop.sveltesociety.dev/mcp"
bearer_token_env_var = "SVELTE_SHOP_MCP_TOKEN"
default_tools_approval_mode = "writes"
```

- [ ] Add integration tests for the full path: paid order -> list -> inspect -> prepare -> approval -> submit -> manual-payment reminder -> status sync -> tracking -> shipping email. Add a separate timeout path proving create is called once, status becomes `review_required`, ordinary submit cannot retry, and one-match reconciliation repairs state.

- [ ] Connect a local Codex host to a local HTTPS/tunnel test deployment using the environment-backed bearer. Verify initialize, tool list, one read tool, one prepare call, approval prompt for write tools, invalid-token `401`, and token redaction. Record only date, client version, and pass/fail in `docs/operations/codex-mcp.md`.

- [ ] Run the phase gate:

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e && pnpm build
```

Expected: all commands exit `0`.

- [ ] Commit with `git commit -m "test: verify fulfillment MCP lifecycle"`.

## Phase 3 handoff

Confirm the production Styria account's brand name, design URLs/positions, product numbers, courier method, and manual payment process. Leave `MCP_ENABLED` and production checkout disabled until Phase 4 security and recovery gates pass.
