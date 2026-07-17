# Online Withdrawal Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every behavior change follows superpowers:test-driven-development: write one failing test, run it and observe the expected failure, write the minimum implementation, rerun to green, then refactor.

**Goal:** Add a continuously available online withdrawal-notice flow with encrypted SQLite case storage, an immediate durable receipt, manual Codex MCP reconciliation, Plunk retries, and automatic PII purge 90 days after closure.

**Architecture:** Extend the existing single-process SvelteKit modular monolith. A dedicated withdrawal repository owns one atomic case/message/alert/event transaction and optimistic state changes. AES-256-GCM protects all customer and order-linkage fields. A focused message worker decrypts only while composing Plunk mail, the public route uses progressive-enhancement page actions and signed cookies, existing bearer-protected MCP exposes the sole admin surface, and the existing durable scheduler drains messages and purges closed cases.

**Tech Stack:** Node 24, pnpm 10.28.1, SvelteKit 2/Svelte 5, TypeScript 6, SQLite/better-sqlite3, Valibot, tmcp, Plunk, Vitest, Playwright, Docker/Coolify.

## Global Constraints

- The approved source of truth is `docs/superpowers/specs/2026-07-17-online-withdrawal-workflow-design.md`. Qualified legal and accountant approval remain launch blockers; engineering must not claim legal approval.
- Use Node and pnpm only. Every documented shell command starts with `rtk`. Do not introduce Bun or npm commands.
- Keep the existing Svelte Society palette, typography, policy shell, keyboard focus language, and responsive spacing. Do not reference the excluded legacy merchandising system anywhere.
- `/withdraw` remains available when `STOREFRONT_ENABLED=false` or `CHECKOUT_ENABLED=false`. It requires no account, Stripe lookup, successful order match, or eligibility decision before acceptance.
- Accept both `entire_order` and `specific_items`. Validate name at 1–200 characters, normalized email at most 320, entered order reference at 1–200, 1–20 selected-item rows, each description at 1–300, and each quantity as integer 1–99.
- Accept first, reconcile later. Intended voluntary change-of-mind scope is eligible EU orders only. Non-EU ineligibility must preserve damaged/incorrect-item support at `merch@sveltesociety.dev`.
- `record_withdrawal_eligibility` may set `eligible_eu` only with an ISO-3166 alpha-2 code in the current EU-27 set and may set `ineligible_non_eu` only with a code outside that set. `support_handling` remains available for every country. This is an administrator-recorded reconciliation result, never a public pre-submission decision.
- Never automatically approve a return, cancel or mutate Styria fulfillment, retrieve or mutate Stripe state, or issue a refund.
- Use AES-256-GCM with a random 12-byte nonce, 16-byte tag, exact base64 32-byte `WITHDRAWAL_DATA_KEY`, integer key version `1`, and AAD `withdrawal-case:1:<internal-case-id>`. Derive separate HMAC keys with HKDF-SHA256 contexts `svelte-society-withdrawal-dedupe-v1`, `svelte-society-withdrawal-receipt-v1`, and `svelte-society-withdrawal-mcp-preview-v1`.
- Public references are `WDR-` plus 22 unpadded base64url characters from 16 random bytes. They provide at least 128 random bits and are never sequential.
- Dedupe exact canonical normalized submissions for 24 hours. Limit final confirmations to 5 per normalized client address per 15 minutes. Public responses never reveal whether an order exists.
- The atomic submission transaction inserts the case, one receipt message, one PII-free `WITHDRAWAL_NOTICE_RECEIVED` operational alert, and one initial event. Commit before Plunk. A duplicate inserts none of them.
- Store no plaintext name, email, entered order reference, item description, reconciliation identifier, rendered receipt, or Plunk body in SQLite outside the authenticated ciphertext. Never log those values or provider error bodies.
- Receipt download requires the unguessable public reference and a 15-minute signed `HttpOnly`, production-`Secure`, `SameSite=Strict` receipt-session cookie. Put no receipt credential in a URL, query, analytics event, or log.
- Withdrawal state transitions are exactly `submitted -> reviewing`, `reviewing -> awaiting_return | ineligible | support_handling`, and each terminal-manual state to `closed`. All transitions use expected-state checks and append one non-PII event in the same transaction.
- Closing sets `pii_purge_due_at` to exactly 90 days after `closed_at`. Purge all ciphertext, nonce, tag, key version, dedupe fingerprint, and encrypted order linkage in one transaction while retaining only the approved non-identifying audit fields.
- Continue one Coolify replica and one persisted `/data/shop.sqlite` volume. Keep the withdrawal data key separate from the backup encryption key and outside SQLite, images, backups, logs, reports, and MCP error output.
- Each task ends with focused tests, `rtk pnpm check`, a self-review, and one scoped commit. No placeholders, skipped tests, TODOs, or production code written before a failing test.

---

## Task 1: Add the encrypted withdrawal persistence foundation

**Files:**

- Create: `migrations/0005_withdrawal_cases.sql`
- Create: `src/lib/domain/withdrawals.ts`
- Create: `src/lib/domain/withdrawals.test.ts`
- Create: `src/lib/server/withdrawals/crypto.server.ts`
- Create: `src/lib/server/withdrawals/crypto.test.ts`
- Create: `src/lib/server/withdrawals/repository.server.ts`
- Create: `src/lib/server/withdrawals/repository.test.ts`
- Modify: `src/lib/server/db/schema.test.ts`
- Modify: `src/lib/server/db/migrate.test.ts`
- Modify: `src/lib/server/monitoring/alerts.server.ts`
- Modify: `src/lib/server/monitoring/alerts.test.ts`

**Interfaces produced:**

```ts
export type WithdrawalScope = 'entire_order' | 'specific_items';
export type WithdrawalStatus =
  | 'submitted'
  | 'reviewing'
  | 'awaiting_return'
  | 'ineligible'
  | 'support_handling'
  | 'closed';
export type WithdrawalEligibility =
  | 'pending'
  | 'eligible_eu'
  | 'ineligible_non_eu'
  | 'support_handling';
export type WithdrawalItem = { description: string; quantity: number };
export type WithdrawalPayloadV1 = {
  fullName: string;
  receiptEmail: string;
  enteredOrderReference: string;
  items: WithdrawalItem[];
  reconciliation: null | {
    internalOrderReference: string;
    countryCode: string;
    customerInstructions: string | null;
    returnOutcome: null | 'parcel_received' | 'return_waived' | 'return_not_received';
    parcelReference: string | null;
  };
};

export function normalizeWithdrawalInput(input: unknown): CanonicalWithdrawalInput;
export function generateWithdrawalReference(randomBytes?: (size: number) => Buffer): string;

export type EncryptedWithdrawalPayload = {
  schemaVersion: 1;
  keyVersion: 1;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
};
export function parseWithdrawalDataKey(value: string | undefined): Buffer;
export function encryptWithdrawalPayload(input: WithdrawalPayloadV1, caseId: string, key: Buffer): EncryptedWithdrawalPayload;
export function decryptWithdrawalPayload(input: EncryptedWithdrawalPayload, caseId: string, key: Buffer): WithdrawalPayloadV1;
export function withdrawalDedupeFingerprint(input: CanonicalWithdrawalInput, key: Buffer): string;

export class SqliteWithdrawalRepository {
  createSubmission(input: CreateWithdrawalSubmission): CreateSubmissionResult;
  getByReference(reference: string): WithdrawalCaseRecord | null;
  loadEncryptedByReference(reference: string): EncryptedWithdrawalCaseRecord | null;
  list(input: WithdrawalListInput): WithdrawalCaseSummary[];
  claimDueMessages(now: Date, limit: number): WithdrawalMessage[];
  claimMessage(id: number, now: Date): WithdrawalMessage | null;
  completeMessage(id: number, expectedAttemptCount: number, providerDeliveryId: string, now: Date): void;
  rescheduleMessage(id: number, expectedAttemptCount: number, nextAttemptAt: Date, errorCode: string): void;
  failMessagePermanently(id: number, expectedAttemptCount: number, errorCode: string, now: Date): void;
}
```

The migration creates these exact tables and indexes:

```sql
CREATE TABLE withdrawal_cases (
  id TEXT PRIMARY KEY,
  public_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('submitted','reviewing','awaiting_return','ineligible','support_handling','closed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  scope TEXT NOT NULL CHECK (scope IN ('entire_order','specific_items')),
  eligibility TEXT NOT NULL CHECK (eligibility IN ('pending','eligible_eu','ineligible_non_eu','support_handling')),
  outcome_code TEXT,
  schema_version INTEGER,
  encryption_key_version INTEGER,
  encrypted_payload BLOB,
  payload_nonce BLOB,
  payload_tag BLOB,
  dedupe_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reconciled_at TEXT,
  closed_at TEXT,
  pii_purge_due_at TEXT,
  purged_at TEXT,
  CHECK ((purged_at IS NULL AND schema_version = 1 AND encryption_key_version = 1 AND encrypted_payload IS NOT NULL AND payload_nonce IS NOT NULL AND payload_tag IS NOT NULL AND dedupe_fingerprint IS NOT NULL)
      OR (purged_at IS NOT NULL AND schema_version IS NULL AND encryption_key_version IS NULL AND encrypted_payload IS NULL AND payload_nonce IS NULL AND payload_tag IS NULL AND dedupe_fingerprint IS NULL))
);
CREATE INDEX withdrawal_cases_dedupe_idx ON withdrawal_cases(dedupe_fingerprint, created_at);
CREATE INDEX withdrawal_cases_status_idx ON withdrawal_cases(status, created_at);
CREATE INDEX withdrawal_cases_purge_idx ON withdrawal_cases(pii_purge_due_at) WHERE purged_at IS NULL;

CREATE TABLE withdrawal_case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES withdrawal_cases(id),
  actor TEXT NOT NULL CHECK (actor IN ('customer','codex-admin','system')),
  action TEXT NOT NULL,
  prior_status TEXT,
  next_status TEXT NOT NULL,
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX withdrawal_case_events_case_idx ON withdrawal_case_events(case_id, id);

CREATE TABLE withdrawal_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES withdrawal_cases(id),
  kind TEXT NOT NULL CHECK (kind IN ('receipt','eligible_instructions','ineligible_decision','support_handoff','resend')),
  resend_of_message_id INTEGER REFERENCES withdrawal_messages(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  provider_delivery_id TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  CHECK ((kind = 'resend' AND resend_of_message_id IS NOT NULL) OR (kind <> 'resend' AND resend_of_message_id IS NULL))
);
CREATE INDEX withdrawal_messages_due_idx ON withdrawal_messages(completed_at, next_attempt_at, id);
```

- [ ] RED: add domain tests for whitespace normalization, Unicode names, lowercase email domain without changing local-part, whole-order canonical empty items, 1–20 specific items, all exact maxima, control characters, HTML/URL-like item descriptions, malformed email, quantities, canonical object property order, and `WDR-` format/randomness. Run `rtk pnpm vitest run src/lib/domain/withdrawals.test.ts`; observe missing-module failure.

- [ ] GREEN: implement only the tested types, validators, canonicalizer, stable JSON serializer, and reference generator. Error codes are stable and contain no submitted values: `WITHDRAWAL_INPUT_INVALID`, `WITHDRAWAL_ITEMS_INVALID`, and `WITHDRAWAL_REFERENCE_INVALID`.

- [ ] RED: add crypto tests for exact key decoding, wrong length, AES-GCM round-trip, unique 12-byte nonces, 16-byte tags, AAD case-ID/schema binding, tampered ciphertext/nonce/tag, key version, deterministic 64-character lowercase-hex dedupe HMAC, and different HKDF contexts. Run the focused test and observe the expected failures.

- [ ] GREEN: implement `createCipheriv`/`createDecipheriv`, `hkdfSync('sha256', key, Buffer.alloc(0), context, 32)`, constant-shape `WITHDRAWAL_KEY_INVALID`, `WITHDRAWAL_ENCRYPT_FAILED`, and `WITHDRAWAL_DECRYPT_FAILED` errors. Never stringify or attach submitted data to an error.

- [ ] RED: add migration and repository tests for fresh migration, upgrade from migration 0004, required CHECK constraints, atomic new submission, 24-hour lookup, exact duplicate reuse, public lookup, PII-free listing, message claim lease by moving `next_attempt_at` five minutes forward, expected-attempt compare-and-set completion, transient reschedule, permanent failure completion without a provider ID, stale settlement rejection, and corrupt-row rejection. Prove concurrent dedupe with two independent SQLite connections and service instances against one WAL database, synchronized immediately before `BEGIN IMMEDIATE`; assert exactly one case, one receipt row, one alert row, and one initial event. Add a raw SQLite byte/text scan proving sample name, email, order reference, and item text occur nowhere in the database file, WAL, or SHM after checkpoint.

- [ ] GREEN: implement strict row mappers and an immediate transaction. `createSubmission` first queries the fingerprint with `created_at >= now - 24h`; on a hit, return `{ created:false, case, receiptMessageId }`; otherwise insert the case, receipt message key `withdrawal:receipt:<case-id>`, alert outbox row keyed with existing alert conventions, and event `customer/submitted/null/submitted/NOTICE_RECEIVED` before commit. Add `WITHDRAWAL_NOTICE_RECEIVED` to the existing alert union/message map in this task so the atomically inserted row is immediately valid to the current outbox worker.

- [ ] Run `rtk pnpm vitest run src/lib/domain/withdrawals.test.ts src/lib/server/withdrawals/crypto.test.ts src/lib/server/withdrawals/repository.test.ts src/lib/server/db/schema.test.ts src/lib/server/db/migrate.test.ts src/lib/server/monitoring/alerts.test.ts && rtk pnpm check`.

Expected: all pass; the test database contains only ciphertext for submitted PII.

- [ ] Self-review the diff for plaintext persistence, implicit state transitions, non-UTC timestamps, and unchecked rows. Commit with `rtk git add migrations/0005_withdrawal_cases.sql src/lib/domain/withdrawals.ts src/lib/domain/withdrawals.test.ts src/lib/server/withdrawals/crypto.server.ts src/lib/server/withdrawals/crypto.test.ts src/lib/server/withdrawals/repository.server.ts src/lib/server/withdrawals/repository.test.ts src/lib/server/db/schema.test.ts src/lib/server/db/migrate.test.ts src/lib/server/monitoring/alerts.server.ts src/lib/server/monitoring/alerts.test.ts && rtk git commit -m "feat: add encrypted withdrawal case storage"`.

---

## Task 2: Build configuration, submission, receipt, and session services

**Files:**

- Modify: `src/lib/config/private.server.ts`
- Modify: `src/lib/config/config.test.ts`
- Create: `src/lib/server/withdrawals/receipt.server.ts`
- Create: `src/lib/server/withdrawals/receipt.test.ts`
- Create: `src/lib/server/withdrawals/submission.server.ts`
- Create: `src/lib/server/withdrawals/submission.test.ts`
- Modify: `tests/fixtures/private-env.ts`

**Interfaces produced:**

```ts
export type WithdrawalConfig = {
  dataKey: Buffer;
  keyVersion: 1;
  productionOrigin: URL;
  supportEmail: string;
  seller: WithdrawalSellerIdentity;
};
export function parseWithdrawalConfig(env: Record<string, string | undefined>): WithdrawalConfig;

export interface WithdrawalReceiptDispatcher {
  attemptReceipt(messageId: number, now: Date, signal?: AbortSignal): Promise<'delivered' | 'queued' | 'failed'>;
}
export class WithdrawalSubmissionService {
  submit(input: CanonicalWithdrawalInput, now?: Date, signal?: AbortSignal): Promise<WithdrawalSubmissionResult>;
}

export type WithdrawalSellerIdentity = {
  legalName: string;
  registrationNumber: string;
  addressLine1: string;
  postalCode: string;
  city: string;
  country: string;
  email: string;
};
export function renderWithdrawalReceiptText(inspection: WithdrawalInspection, seller: WithdrawalSellerIdentity): string;
export function createReceiptSession(reference: string, now: Date, key: Buffer): string;
export function verifyReceiptSession(reference: string, token: string, now: Date, key: Buffer): boolean;
export const WITHDRAWAL_RECEIPT_COOKIE = 'withdrawal_receipt_session';
export const WITHDRAWAL_RECEIPT_MAX_AGE_SECONDS = 900;
```

- [ ] RED: extend config tests for exact canonical 32-byte base64 key acceptance, non-canonical/missing/invalid base64/wrong-length rejection, key version `1`, complete seller identity, and production checkout startup rejection when the key is absent. Assert `parseWithdrawalConfig` is independent of Stripe and feature flags so the route can operate while sales are disabled.

- [ ] GREEN: add `parseWithdrawalConfig`, reusing `parsePublicConfig` and `parseSellerPolicyConfig`, then map only the exact `WithdrawalSellerIdentity` fields. Make `parsePrivateConfig` call it when `NODE_ENV=production && checkoutEnabled`; keep its public error `CONFIG_PRIVATE_INVALID`. `parseWithdrawalConfig` itself throws only `CONFIG_WITHDRAWAL_INVALID`.

- [ ] RED: add receipt tests for exact title `Withdrawal notice received — <reference>`, seller identity, UTC receipt timestamp, committed name/order/items, explicit `submission only`/not approval/not refund language, UTF-8, HTML-looking values remaining literal text, and no return-address instruction. Add signed-session tests for correct reference, wrong reference/key, modified signature, invalid encoding, expired/future tokens, exact 15-minute boundary, and constant-time verification behavior.

- [ ] GREEN: render a deterministic text receipt from the committed decrypted record and explicit validated seller identity (legal name, registration number, full postal address, and merchant email). Sign compact `v1.<unix-expiry>.<base64url-mac>` tokens with the receipt HKDF key and `HMAC-SHA256(reference + '\n' + expiry)`. Accept no expiry more than 900 seconds in the future.

- [ ] RED: add submission-service tests for canonicalization before encryption, commit before dispatch, delivery states `delivered`, `queued`, and `failed`, retryable dispatcher failure returning the committed queued case, terminal dispatcher rejection returning the committed failed-email case, duplicate returning the same reference and persisted message state without redispatch, encryption/repository failure creating no case, and server UTC timestamp. Verify result contains only reference, created timestamp, scope, entered order reference, and delivery state; the route creates its cookie separately with the receipt-session service.

- [ ] GREEN: implement submission orchestration. Generate UUID/reference, encrypt, derive fingerprint, call the repository transaction, then attempt only a newly created receipt. Catch delivery failure after commit and return `queued`; never catch pre-commit encryption/repository failure as success. Do not call Stripe, Styria, or fulfillment repositories.

- [ ] Run `rtk pnpm vitest run src/lib/config/config.test.ts src/lib/server/withdrawals/receipt.test.ts src/lib/server/withdrawals/submission.test.ts && rtk pnpm check`.

Expected: pass; a provider exception still returns the committed case as queued.

- [ ] Commit with `rtk git add src/lib/config/private.server.ts src/lib/config/config.test.ts src/lib/server/withdrawals/receipt.server.ts src/lib/server/withdrawals/receipt.test.ts src/lib/server/withdrawals/submission.server.ts src/lib/server/withdrawals/submission.test.ts tests/fixtures/private-env.ts && rtk git commit -m "feat: accept durable withdrawal submissions"`.

---

## Task 3: Deliver withdrawal messages and wire the runtime scheduler

**Files:**

- Create: `src/lib/server/withdrawals/messages.server.ts`
- Create: `src/lib/server/withdrawals/messages.test.ts`
- Create: `src/lib/server/withdrawals/case-reader.server.ts`
- Create: `src/lib/server/withdrawals/case-reader.test.ts`
- Create: `src/lib/server/jobs/withdrawal-worker.server.ts`
- Create: `src/lib/server/jobs/withdrawal-worker.test.ts`
- Modify: `src/lib/server/monitoring/alerts.server.ts`
- Modify: `src/lib/server/monitoring/alerts.test.ts`
- Modify: `src/lib/server/jobs/scheduler.server.ts`
- Modify: `src/lib/server/jobs/scheduler.test.ts`
- Modify: `src/lib/server/app.server.ts`
- Modify: `src/lib/server/app.test.ts`
- Modify: `tests/integration/backup-restore-drill.test.ts`

**Interfaces produced:**

```ts
export type WithdrawalMessagePreview = {
  to: string;
  subject: string;
  text: string;
  html: string;
};
export function withdrawalMessage(input: WithdrawalMessageContentInput): WithdrawalMessagePreview;

export class WithdrawalMessageWorker implements WithdrawalReceiptDispatcher {
  attemptReceipt(messageId: number, now: Date, signal?: AbortSignal): Promise<'delivered' | 'queued' | 'failed'>;
  drain(now: Date, limit: number, signal?: AbortSignal): Promise<void>;
}

export class WithdrawalCaseReader {
  inspectActive(reference: string, now?: Date): WithdrawalInspection;
  decryptLoaded(record: EncryptedWithdrawalCaseRecord): WithdrawalPayloadV1;
  withDecryptAlert<T>(reference: string, now: Date, operation: () => T): T;
}

export type WithdrawalRuntime = {
  submission: WithdrawalSubmissionService;
  repository: SqliteWithdrawalRepository;
  worker: WithdrawalMessageWorker;
  dataKey: Buffer;
};
```

- [ ] RED: write message-copy tests for receipt, eligible instructions, ineligible non-EU decision, support handoff, and resend-of-original-kind. Assert the approved non-EU sentence and support address exactly, eligible instructions warn against the registered seller address, receipt makes no approval/refund claim, all customer strings are escaped, and the message object alone contains the destination/rendered body.

- [ ] GREEN: build text-first templates and escaped paragraph HTML. Use subject `Withdrawal notice received — <WDR-reference>` for receipt. Keep fixed legal-status copy in one exported map used by email and MCP preview.

- [ ] RED: test the worker with real repository rows and fake Plunk for decryption only after claim, Plunk acceptance, transient backoff of 1, 5, 15, and 60 minutes capped at 60, permanent `PLUNK_REQUEST_REJECTED` settlement without a delivery ID, expected-attempt stale-settlement rejection, stable error only, abort leaving the message claimable after its five-minute claim lease, and no recipient/body persisted in message rows. Repeat terminal and fifth-transient-attempt assertions for receipt, eligible instructions, ineligible decision, support handoff, and resend kinds.

- [ ] GREEN: implement `attemptReceipt` and `drain`. `claimMessage`/`claimDueMessages` increment attempts atomically and every settlement supplies that returned attempt count. Treat timeout/rate-limit/unavailable/invalid-response as transient and request-rejected as permanent through `failMessagePermanently`. Return `failed` for a permanently rejected first receipt email while preserving the committed notice/download, `queued` only for a retryable failure, and `delivered` only with Plunk acceptance. Add generic alert code `WITHDRAWAL_MESSAGE_UNSENT`: emit it immediately on every terminal failure and at attempt 5 for transient failures, for every message kind. Retain `WITHDRAWAL_NOTICE_RECEIVED` from Task 1. Test that a generated `WDR-` reference is accepted as a subject ID.

- [ ] RED: test a centralized `WithdrawalCaseReader` with valid active ciphertext plus wrong key, tampered tag/ciphertext, purged case, and alert persistence failure. On authenticated-decryption failure it must enqueue exactly one `WITHDRAWAL_DATA_UNREADABLE` alert containing only public WDR reference/timestamp, return stable `WITHDRAWAL_DECRYPT_FAILED`, and mutate no case/event/message fields. Add wiring assertions showing the worker uses this reader.

- [ ] GREEN: implement the reader over repository encrypted-row loading, crypto, and `AlertService`. `withDecryptAlert` executes the supplied synchronous operation; if and only if its final thrown stable code is `WITHDRAWAL_DECRYPT_FAILED`, it emits the WDR-only alert after the operation's transaction has unwound, then rethrows. `inspectActive` uses that wrapper. All later remote decrypt callers (receipt download, MCP inspect, workflow actions, resend preview/confirm) receive this same runtime reader rather than calling crypto directly.

- [ ] RED: extend scheduler tests so one `outbox` lease/run drains the existing paid-order worker and then the withdrawal worker, propagates an abort signal to both, records one failed run on either worker failure, and waits for both during shutdown. Existing worker behavior must remain unchanged when no withdrawal worker is configured.

- [ ] GREEN: add optional `withdrawalWorker: Pick<WithdrawalMessageWorker,'drain'>` to `OutboxSchedulerOptions`; call it after the existing worker with limit `3` under the same heartbeat/lease/run.

- [ ] RED: extend application tests for a `WithdrawalRuntime` constructed from SQLite, `WITHDRAWAL_DATA_KEY`, Plunk sender config, production origin, support email, seller identity, and the existing singleton lifecycle. Verify it exists even when storefront/checkout are false and scheduler is false, while a configured scheduler receives the same worker/repository.

- [ ] GREEN: create the withdrawal runtime independently of commerce feature flags. Add it to `ApplicationRuntime`. Reuse one Plunk gateway and the configured shop sender. Do not require Stripe or Styria for the withdrawal runtime; do not put the data key into runtime logs/readiness JSON.

- [ ] Run `rtk pnpm vitest run src/lib/server/withdrawals/messages.test.ts src/lib/server/withdrawals/case-reader.test.ts src/lib/server/jobs/withdrawal-worker.test.ts src/lib/server/monitoring/alerts.test.ts src/lib/server/jobs/scheduler.test.ts src/lib/server/app.test.ts && rtk pnpm check`.

Expected: pass; delivery failure is durable and scheduler shutdown is clean.

- [ ] Commit with `rtk git add src/lib/server/withdrawals/messages.server.ts src/lib/server/withdrawals/messages.test.ts src/lib/server/withdrawals/case-reader.server.ts src/lib/server/withdrawals/case-reader.test.ts src/lib/server/jobs/withdrawal-worker.server.ts src/lib/server/jobs/withdrawal-worker.test.ts src/lib/server/monitoring/alerts.server.ts src/lib/server/monitoring/alerts.test.ts src/lib/server/jobs/scheduler.server.ts src/lib/server/jobs/scheduler.test.ts src/lib/server/app.server.ts src/lib/server/app.test.ts && rtk git commit -m "feat: deliver withdrawal messages"`.

---

## Task 4: Add the public progressive-enhancement withdrawal flow

**Files:**

- Create: `src/routes/withdraw/+page.server.ts`
- Create: `src/routes/withdraw/+page.server.test.ts`
- Create: `src/routes/withdraw/+page.svelte`
- Create: `src/routes/withdraw/+page.svelte.test.ts`
- Create: `src/routes/withdraw/receipt/[reference]/+server.ts`
- Create: `src/routes/withdraw/receipt/[reference]/receipt.test.ts`
- Create: `src/lib/server/security/bounded-form.server.ts`
- Create: `src/lib/server/security/bounded-form.test.ts`
- Modify: `src/hooks.server.ts`
- Modify: `src/hooks.server.test.ts`
- Modify: `src/lib/components/SiteFooter.svelte`
- Modify: `src/lib/components/SiteFooter.test.ts`
- Modify: `src/lib/components/PolicyPage.svelte`
- Modify: `src/lib/content/policies.ts`
- Modify: `src/lib/content/policies.test.ts`
- Modify: `src/lib/server/plunk/shipping-email.ts`
- Modify: `src/lib/server/plunk/shipping-email.test.ts`
- Create: `tests/e2e/withdrawal.spec.ts`

**Page contract:**

```ts
export const load: PageServerLoad = async ({ cookies, url }) => ({
  csrfToken: issueOrReuseWithdrawalCsrf(cookies, url.protocol === 'https:'),
  itemRowCount: 1
});

export const actions = {
  addItem,
  removeItem,
  review,
  confirm
} satisfies Actions;
```

`review` validates and returns a canonical, non-persisted review model. `confirm` repeats every validation from raw form fields, validates CSRF/host/origin/body/field count, applies the final rate limit, then calls the runtime submission service. Never trust hidden review values without revalidation.

- [ ] RED: add server tests for load CSRF cookie, missing/mismatched CSRF, wrong host/origin, content length over 64 KiB, absent/chunked/understated content length whose stream exceeds 64 KiB, more than 20 item rows, 5-per-15-minute limit keyed by `getClientAddress()`, validation with no case, add/remove row preservation, review with no case, confirm with one case, exact duplicate, provider-delivered, retry-queued, and terminal-email-failed success, database/encryption 503, and operation with both sales flags false. Assert no submitted field appears in error/log output.

- [ ] GREEN: use the existing host/origin validator and fixed-window limiter. Add `readBoundedFormData(request, 65_536)`: reject an oversized declared length before reading, then consume the request stream with a byte counter and abort before buffering byte 65,537 even when length is absent, chunked, or understated; only then create/parse `FormData`. Use it for every POST `/withdraw` action. Use a random 32-byte `withdrawal_csrf` cookie (`HttpOnly`, `SameSite=Strict`, production `Secure`, path `/withdraw`, 30-minute max age) and a hidden exact token. Rate-limit only final `confirm`, not GET/review/add/remove. Return generic `429`/`503` form states.

- [ ] RED: add component tests for persistent labels, fieldset/legend/native radios, first specific-item row, server/client add/remove through 20, adjacent errors plus linked error summary, preserved values, review of every value, receipt statement, explicit confirmation text, final button text `Confirm withdrawal from purchase`, success heading `Withdrawal notice received.`, WDR reference, entered order reference and whole/partial scope, localizable UTC `<time datetime>`, failed/queued/delivered email states, and forbidden approval/refund language. `failed` states plainly that email could not be sent, confirms the notice itself is safely recorded, and directs the customer to download the receipt; this exact copy remains part of the qualified legal review gate.

- [ ] GREEN: implement the page in the existing Svelte Society design system. Use one non-modal form flow. Enhance row add/remove and focus movement with Svelte only after the no-JS actions work. Move focus to `#withdrawal-errors` or `#withdrawal-success`, provide 44px targets/visible focus, and respect reduced motion.

- [ ] RED: add hook/route tests proving every `/withdraw` GET, validation failure, review response, success response, and receipt response carries `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`. Add download tests for missing cookie, public reference alone, wrong-reference token, expired token, valid UTF-8 attachment, `text/plain; charset=utf-8`, safe filename `<reference>-withdrawal-receipt.txt`, and purged/missing cases returning a constant-shape 404. Assert URL/query contain no token. Tampered-ciphertext download must use `WithdrawalCaseReader`, emit only a WDR-scoped `WITHDRAWAL_DATA_UNREADABLE` alert, mutate nothing, and return a constant-shape unavailable response.

- [ ] GREEN: make the global hook add the no-store/no-referrer headers after handling every path under `/withdraw`, including actions and errors. On successful confirm, set the 15-minute signed receipt cookie scoped to `/withdraw/receipt/<reference>` and render a link containing only the public reference path. The endpoint verifies cookie and reference, inspects through the centralized `WithdrawalCaseReader`, renders the committed receipt with the validated seller identity, and never logs its body.

- [ ] RED: update footer/policy/shipping-email tests for labels `Withdraw from purchase`, `Submit a withdrawal notice`, and `Withdraw from this purchase`. The shipping link is absolute from configured `PRODUCTION_ORIGIN`; it is convenience only. Privacy copy must state encrypted active-case fields and 90-day post-closure purge, replacing the claim that local records have no automatic deletion schedule.

- [ ] GREEN: add the three links. Preserve separate damaged/incorrect-item support. Keep the model notice, but make `/withdraw` the primary online function. Pass production origin into shipping message creation without adding query order identifiers.

- [ ] RED/GREEN browser pass: cover JS-disabled whole and one-item partial review/confirm, enhanced multi-item flow, validation/error-summary keyboard focus, signed download, queued state, flags-off availability, footer/Returns discovery, reduced motion, and viewport widths 320/768/1024/1440 in Chromium, Firefox, and WebKit.

- [ ] Run `rtk pnpm vitest run src/routes/withdraw src/lib/components/SiteFooter.test.ts src/lib/content/policies.test.ts src/lib/server/plunk/shipping-email.test.ts && rtk pnpm playwright test tests/e2e/withdrawal.spec.ts && rtk pnpm check && rtk pnpm lint`.

Expected: pass across configured browsers with and without JavaScript.

- [ ] Commit with `rtk git add src/routes/withdraw src/lib/server/security/bounded-form.server.ts src/lib/server/security/bounded-form.test.ts src/hooks.server.ts src/hooks.server.test.ts src/lib/components/SiteFooter.svelte src/lib/components/SiteFooter.test.ts src/lib/components/PolicyPage.svelte src/lib/content/policies.ts src/lib/content/policies.test.ts src/lib/server/plunk/shipping-email.ts src/lib/server/plunk/shipping-email.test.ts tests/e2e/withdrawal.spec.ts && rtk git commit -m "feat: add online withdrawal customer flow"`.

---

## Task 5: Add PII-safe MCP withdrawal discovery and inspection

**Files:**

- Create: `src/lib/server/mcp/tools/list-withdrawals.ts`
- Create: `src/lib/server/mcp/tools/inspect-withdrawal.ts`
- Modify: `src/lib/server/mcp/server.ts`
- Modify: `src/lib/server/mcp/runtime.server.ts`
- Modify: `src/lib/server/mcp/tools/tools.test.ts`
- Modify: `src/lib/server/mcp/runtime.test.ts`
- Modify: `src/lib/server/security/redact.ts`
- Modify: `src/lib/server/security/redact.test.ts`

**Tool contracts:**

```text
list_withdrawal_cases({ status?, limit?: 1..100 })
  -> { cases: [{ reference,status,scope,eligibility,outcome_code,created_at,updated_at,closed_at,purged_at }] }

inspect_withdrawal_case({ reference })
  -> active case customer payload + PII-free events and message delivery metadata
  -> WITHDRAWAL_PII_PURGED for purged cases
```

- [ ] RED: add tool tests for exact strict schemas, unknown-key rejection, limit default 50, all status filters, newest-first order, no list decryption call, no PII keys/values in list JSON, active decrypted inspection, missing/purged/corrupt cases, and annotations. Tampered ciphertext must flow through `WithdrawalCaseReader`, emit exactly one WDR-scoped `WITHDRAWAL_DATA_UNREADABLE` alert, return a stable error, and perform zero case/event/message mutation. Both tools have `readOnlyHint:true`, `destructiveHint:false`, `idempotentHint:true`, `openWorldHint:false`.

- [ ] GREEN: register both tools against a narrow `withdrawals` service in `McpServices`. Return ISO timestamps and stable caught errors only. Inspection uses the centralized reader and can return decrypted data because bearer authentication already gates the MCP transport; list cannot.

- [ ] RED: extend runtime tests proving the service is assembled with the configured data key, the existing static bearer accepts/rejects as before, and route logging/redaction removes `fullName`, `receiptEmail`, `enteredOrderReference`, `items`, message previews, cookies, and request bodies while retaining public reference/status/error codes.

- [ ] GREEN: wire the repository into MCP runtime. Update server instructions to mention withdrawal administration without changing the single-admin/static-bearer model. Do not add OAuth, roles, accounts, or a second MCP endpoint.

- [ ] Run `rtk pnpm vitest run src/lib/server/mcp/tools/tools.test.ts src/lib/server/mcp/runtime.test.ts src/lib/server/security/redact.test.ts && rtk pnpm check`.

Expected: pass; list output and all logs are PII-free.

- [ ] Commit with `rtk git add src/lib/server/mcp/tools/list-withdrawals.ts src/lib/server/mcp/tools/inspect-withdrawal.ts src/lib/server/mcp/server.ts src/lib/server/mcp/runtime.server.ts src/lib/server/mcp/tools/tools.test.ts src/lib/server/mcp/runtime.test.ts src/lib/server/security/redact.ts src/lib/server/security/redact.test.ts && rtk git commit -m "feat: inspect withdrawal cases in codex"`.

---

## Task 6: Add explicit MCP case actions and reviewed message resends

**Files:**

- Create: `src/lib/server/withdrawals/workflow.server.ts`
- Create: `src/lib/server/withdrawals/workflow.test.ts`
- Create: `src/lib/server/mcp/tools/manage-withdrawal.ts`
- Modify: `src/lib/server/mcp/server.ts`
- Modify: `src/lib/server/mcp/runtime.server.ts`
- Modify: `src/lib/server/mcp/tools/tools.test.ts`

**Tool contracts:**

```text
begin_withdrawal_review({ reference, expected_status:'submitted', expected_revision })
record_withdrawal_eligibility({
  reference, expected_status:'reviewing', expected_revision,
  decision:'eligible_eu'|'ineligible_non_eu'|'support_handling',
  internal_order_reference, country_code,
  customer_instructions? // required only for eligible_eu, text only, 1..1000
})
record_withdrawal_return({
  reference, expected_status:'awaiting_return', expected_revision,
  outcome:'parcel_received'|'return_waived'|'return_not_received',
  parcel_reference? // trimmed safe text, at most 120
})
close_withdrawal_case({
  reference,
  expected_status:'awaiting_return'|'ineligible'|'support_handling',
  expected_revision,
  outcome_code:'eligible_return_received'|'eligible_return_waived'|'eligible_return_not_received'|'ineligible_non_eu'|'support_handling_completed'
})
resend_withdrawal_message({
  reference, source_message_id,
  mode:'preview'|'confirm',
  preview_token?, idempotency_key?
})
```

`resend_withdrawal_message` is two-step. Preview decrypts and returns destination, subject, text body, and a 10-minute HMAC token bound to reference, source message ID, exact message SHA-256, and expiry. Confirm requires that token plus an admin-supplied UUID idempotency key, recomposes the message, verifies the digest, and queues one `resend` row. It does not send inline.

- [ ] RED: write workflow tests for every allowed transition, every forbidden transition, stale expected-state/revision conflict returning current safe status/revision, revision increment on every successful case mutation, one event per action, encrypted reconciliation updates, eligible/ineligible/support message enqueue in the same transaction, repeated and concurrent `record_withdrawal_return` calls with one winning revision and no overwrite/duplicate event, and rollback injection. Validate country codes against a fixed complete current ISO-3166 alpha-2 set: reject `ZZ` and other invented codes, require EU-27 membership for `eligible_eu`, require valid non-membership for `ineligible_non_eu`, and let `support_handling` proceed for any valid country without an EU gate. Assert no Styria/Stripe/fulfillment dependency or write occurs.

- [ ] GREEN: implement repository-backed workflow transactions with integer `revision` compare-and-set. Wrap each action in `WithdrawalCaseReader.withDecryptAlert`; inside it, start `BEGIN IMMEDIATE`, reload the encrypted row in that transaction, verify expected status and revision, decrypt that exact row through `decryptLoaded`, apply the state/payload mutation, and update with `WHERE id=? AND revision=?`, incrementing revision once. The transaction unwinds before the wrapper persists any decrypt alert, so corrupt ciphertext causes zero partial mutation but a durable WDR-only alert. `begin` appends `ADMIN_REVIEW_STARTED`. Eligibility stores structured reconciliation inside re-encrypted payload, sets `reconciled_at`, validates a normalized code against immutable complete ISO-3166 and EU-27 sets, advances to the exact state, and queues one corresponding message. `recordReturn` updates encrypted metadata and appends an event without changing `awaiting_return`. `close` requires a return outcome for `awaiting_return`, enforces the outcome-code/state/return-outcome combination, sets closed/outcome/purge due exactly +90 days, and appends one event.

- [ ] RED: add strict MCP tests for all five tool names, inputs, outputs, required positive `expected_revision`, current-status/revision conflicts, inspection returning the current revision, country code normalization, conditional eligible instructions, no voluntary non-EU approval path, support handoff copy, mutation annotations, and stable errors. Mutations use `readOnlyHint:false`, `destructiveHint:true`, correct idempotency hints, and `openWorldHint:false`.

- [ ] GREEN: register tools using the workflow service. Fixed ineligible copy is exactly: `This order is not eligible for a change-of-mind return. Damaged or incorrect-item support remains available at merch@sveltesociety.dev.` Eligible copy includes the approved return-address warning. Never describe a state change as approval or refund processing.

- [ ] RED: add resend tests for preview-only no write, destination/body redaction from logs, 10-minute expiry, changed-case digest rejection, wrong message/case/token rejection, completed and failed source kinds, duplicate confirm reusing one row, and confirm without preview rejection. Tampered ciphertext in preview or confirm must emit one WDR-scoped decrypt alert and perform zero mutation.

- [ ] GREEN: derive the preview key using the specified HKDF context and bind the preview token to the case revision. Compose both preview and confirm through `WithdrawalCaseReader`; at confirm, the enqueue transaction rechecks revision, `purged_at IS NULL`, active encryption metadata, source-message ownership, and exact preview digest before inserting `resend_of_message_id`. Never persist destination, preview, digest, token, or rendered body. The next scheduler pass sends it. Mark preview mode read-like in output but keep the combined tool's mutation annotations conservative.

- [ ] Run `rtk pnpm vitest run src/lib/server/withdrawals/workflow.test.ts src/lib/server/mcp/tools/tools.test.ts src/lib/server/mcp/runtime.test.ts && rtk pnpm check`.

Expected: pass; every state mutation is atomic, explicit, and auditable.

- [ ] Commit with `rtk git add src/lib/server/withdrawals/workflow.server.ts src/lib/server/withdrawals/workflow.test.ts src/lib/server/mcp/tools/manage-withdrawal.ts src/lib/server/mcp/server.ts src/lib/server/mcp/runtime.server.ts src/lib/server/mcp/tools/tools.test.ts && rtk git commit -m "feat: manage withdrawal cases in codex"`.

---

## Task 7: Purge closed-case PII on the durable scheduler

**Files:**

- Create: `src/lib/server/jobs/withdrawal-retention.server.ts`
- Create: `src/lib/server/jobs/withdrawal-retention.test.ts`
- Modify: `src/lib/server/withdrawals/repository.server.ts`
- Modify: `src/lib/server/withdrawals/repository.test.ts`
- Modify: `src/lib/server/jobs/scheduler.server.ts`
- Modify: `src/lib/server/jobs/scheduler.test.ts`
- Modify: `src/lib/server/app.server.ts`
- Modify: `src/lib/server/app.test.ts`

**Interfaces produced:**

```ts
export interface WithdrawalRetentionJob {
  run(now: Date, signal?: AbortSignal): Promise<{ purged: number }>;
}

export class SqliteWithdrawalRetentionJob implements WithdrawalRetentionJob {
  run(now: Date, signal?: AbortSignal): Promise<{ purged: number }>;
}
```

- [ ] RED: add repository purge tests for due closed cases, not-yet-due cases, active cases, already-purged idempotency, batch limit 100, exact clearing of schema/key/ciphertext/nonce/tag/fingerprint, retained approved metadata/events/message delivery fields, one `system/PII_PURGED` event, and injected failure rolling back every field and event. A purge atomically settles every incomplete receipt/instructions/decision/support/resend row with `completed_at=purged_at`, null provider ID, and stable `WITHDRAWAL_CASE_PURGED`; no due/claimed row may remain.

- [ ] GREEN: add `purgeDue(now, limit)` as one immediate transaction per batch. Select only `status='closed' AND purged_at IS NULL AND pii_purge_due_at <= now`; terminal-settle incomplete messages first, then atomically null protected columns, increment revision, and set `purged_at/updated_at`. Do not delete cases, events, or message delivery metadata.

- [ ] RED: test job abort between batches, repeated batches until fewer than 100, purge failure alert without partial clearing, and no decrypted read. Add scheduler tests for job name `withdrawal-retention`, daily cadence 03:15 UTC, 30-minute lease, `job_runs` complete/failed records, catch-up once after missed cadence, concurrent lease refusal, shutdown abort/wait, and safe retry after failure. Add a shared durable lease `withdrawal-delivery-guard`: the outbox run holds and heartbeats it across withdrawal provider calls, retention holds it across every purge batch, either run skips safely if it cannot acquire it, and no test permits a send and purge to overlap.

- [ ] GREEN: add optional `withdrawalRetention` to the scheduler and `runWithdrawalRetentionOnce`. Use the existing lease/job-run pattern and stable codes `WITHDRAWAL_RETENTION_FAILED` and `SCHEDULER_FAILED`. Acquire `withdrawal-delivery-guard` only after the run's primary lease, release both in reverse order, and renew the guard with the same heartbeat/TTL discipline as the primary run. Expected-attempt settlement prevents a stale provider completion even if a guard lease is lost. Add a PII-free operational alert code with the job name as subject. Wire the job from the application runtime whenever the scheduler is enabled.

- [ ] RED/GREEN: extend `tests/integration/backup-restore-drill.test.ts`: restore a backup containing one active and one purged case, prove active decrypts only with `WITHDRAWAL_DATA_KEY`, purged does not decrypt, and neither key is present in the backup object or database.

- [ ] Run `rtk pnpm vitest run src/lib/server/withdrawals/repository.test.ts src/lib/server/jobs/withdrawal-retention.test.ts src/lib/server/jobs/scheduler.test.ts src/lib/server/app.test.ts && rtk pnpm check`.

Expected: pass; injected failures preserve the full decryptable payload for retry.

- [ ] Commit with `rtk git add src/lib/server/jobs/withdrawal-retention.server.ts src/lib/server/jobs/withdrawal-retention.test.ts src/lib/server/withdrawals/repository.server.ts src/lib/server/withdrawals/repository.test.ts src/lib/server/jobs/scheduler.server.ts src/lib/server/jobs/scheduler.test.ts src/lib/server/app.server.ts src/lib/server/app.test.ts tests/integration/backup-restore-drill.test.ts && rtk git commit -m "feat: purge closed withdrawal data"`.

---

## Task 8: Complete security, operations, and production-shaped verification

**Files:**

- Create: `tests/integration/withdrawal-flow.test.ts`
- Create: `tests/integration/withdrawal-security.test.ts`
- Create: `docs/operations/withdrawals.md`
- Modify: `docs/operations/coolify.md`
- Modify: `docs/operations/backup-restore.md`
- Modify: `docs/operations/policy-review.md`
- Modify: `.env.example`
- Modify: `tests/integration/docker-health.sh`
- Modify: `playwright.config.ts`
- Modify: `README.md`

**Evidence required:** one automated gate plus a documented checklist for the external Plunk/Codex/Coolify/legal/accountant steps that cannot be fabricated locally.

- [ ] RED: write end-to-end integration tests for atomic case/message/alert/event creation, whole/partial inputs, no case on every pre-commit failure, retained case on Plunk failure, due retry/completion/failure alert for every message kind, all authorized MCP transitions, non-EU support preservation, close/purge/rollback, delivery-versus-purge exclusion, and active/purged backup restore. The exact-duplicate race uses independent connections/process-capable service instances against the same WAL file with a synchronization barrier before transaction entry and asserts exactly one case, receipt, alert, and initial event.

- [ ] RED: add a security suite that checkpoints SQLite and scans DB/WAL/SHM plus structured captured logs for canary name, email, entered order reference, item text, reconciliation order ID, receipt body, Plunk body, authorization, cookies, tokens, and keys. Verify only the encrypted payload contains recoverable customer fields and all public/list/error responses have constant shape.

- [ ] GREEN: fix only gaps exposed by those tests. Do not broaden scope into automatic order lookup, return approval, labels, cancellation, or refunds.

- [ ] Update `.env.example` and Coolify docs with `WITHDRAWAL_DATA_KEY` generation using Node crypto, secret handling, one replica, persistent `/data`, separate backup key, rollout with checkout off, route health test while storefront is off, rotation/recovery limitations for key version 1, and a warning that losing the key loses active-case PII.

- [ ] Write `docs/operations/withdrawals.md` with intake monitoring, queued receipt investigation, Codex inspection/reconciliation, EU/non-EU/support decisions, safe return metadata, resend preview/confirm, close, 90-day purge drill, decrypt failure response, Plunk outage behavior, data-subject handling, backup restore, and no-refund/no-Styria automation boundaries.

- [ ] Update policy review evidence to require qualified Swedish/EU counsel approval of rendered labels, review/confirm action, receipt, EU/non-EU copy, 90-day retention, and always-available route; require accountant approval of manual refund/record handling. Keep checkout false until evidence is recorded.

- [ ] Extend the Docker gate to start with a generated withdrawal key, submit a synthetic notice with commerce flags false, restart on the same volume, verify the WDR case persists, verify receipt download only in the submitting cookie jar, run the MCP list through bearer auth, and confirm the container remains UID 10001 with `/data` persistence.

- [ ] Run the complete gate:

```bash
rtk pnpm test:unit
rtk pnpm test:integration
rtk pnpm playwright test
rtk pnpm check
rtk pnpm lint
rtk pnpm build
rtk bash tests/integration/docker-health.sh
```

Expected: all local automated gates pass. Record exact counts, Docker image digest, and any unavailable external credentials in the task report.

- [ ] Run placeholder and secret scans:

```bash
rtk rg -n "TODO|FIXME|IMPLEMENT_ME|skip\(|\.skip\(|WITHDRAWAL_DATA_KEY=.*[A-Za-z0-9+/]{40}" src tests migrations docs Dockerfile .env.example
rtk git diff --check
rtk git status --short
```

Expected: no implementation placeholders, embedded key, whitespace errors, or unexplained worktree changes.

- [ ] Complete only authorized production-shaped checks: synthetic local receipt, PII-free admin alert fixture, bearer MCP list/inspect/actions, close/time-controlled purge, persistence, and restore-with-separate-key. Document live Plunk delivery, public HTTPS, and legal/accountant approvals as pending unless real credentials/evidence are present.

- [ ] Commit with `rtk git add tests/integration/withdrawal-flow.test.ts tests/integration/withdrawal-security.test.ts docs/operations/withdrawals.md docs/operations/coolify.md docs/operations/backup-restore.md docs/operations/policy-review.md .env.example tests/integration/docker-health.sh playwright.config.ts README.md && rtk git commit -m "docs: add withdrawal operations and launch gate"`.

---

## Final Review and Branch Gate

- [ ] Generate one review package from the pre-withdrawal base commit through `HEAD` and dispatch the broad whole-branch reviewer using `superpowers:requesting-code-review` on the most capable available model.
- [ ] Fix every Critical and Important finding in one fix wave; rerun each covering focused test and the full gate; re-review until clean. Record Minor findings in the durable SDD ledger for final triage.
- [ ] Use `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`.
- [ ] Do not enable public checkout or claim launch readiness until live Plunk/Codex/Coolify smoke evidence and qualified legal/accountant approvals are recorded.
