# Online Withdrawal Workflow Design

**Date:** 2026-07-17  
**Status:** Approved product design; qualified legal review still required before public checkout  
**Scope:** Statutory online withdrawal notice intake, durable receipt, manual reconciliation, and case handling

## Context

The shop sells physical merchandise through an online interface. Its existing Returns page explains
the EU 14-day withdrawal right and asks customers to contact support before returning goods. That
email-first process is not the online withdrawal function now required by chapter 2 section 10 a of
Sweden's Distance Contracts Act for eligible contracts concluded online.

The shop needs a continuously available function that accepts a withdrawal notice without requiring
an account or successful provider lookup, records the time of receipt, and sends a durable electronic
receipt without delay. Eligibility, return instructions, parcel receipt, and Stripe refund handling
remain manual administrator work.

Qualified counsel must review the rendered workflow, exact labels, eligibility rules, receipt, and
retention period before checkout is enabled. This design does not claim legal approval.

## Binding Product Decisions

- Add a public `/withdraw` route.
- Link it from the global footer, Returns page, and the existing Plunk shipping email.
- Keep it available when storefront or checkout is disabled.
- Require no customer account and no Stripe lookup before accepting a notice.
- Accept both whole-order and selected-item withdrawal notices.
- Accept the notice before determining eligibility; reconcile the order manually afterward.
- Treat eligible EU change-of-mind withdrawals as the intended scope.
- Do not offer voluntary change-of-mind returns for non-EU orders.
- Keep damaged or incorrect-item support available regardless of the change-of-mind decision.
- Store the active case's customer fields as a narrowly scoped AES-256-GCM encrypted payload in
  SQLite.
- Purge encrypted customer fields 90 days after case closure.
- Retain only non-identifying audit metadata after that purge.
- Never automatically cancel Styria work, approve a return, or issue a Stripe refund.

## Legal Boundary

The function records a customer's withdrawal notice. Submission is not return approval and is not a
refund decision. The immediate receipt must not imply either.

The function allows the customer to provide or confirm:

- their name;
- details identifying the purchase they wish to withdraw from;
- whether the notice covers the whole order or selected items;
- the email address to which the durable receipt will be sent; and
- an explicit confirmation that they want to withdraw from the purchase.

Manual reconciliation may conclude that a notice is not eligible for the shop's EU change-of-mind
flow. That later decision does not erase or backdate the submitted notice. Non-EU ineligibility copy
must direct damaged or incorrect-item cases to support rather than implying that those cases have no
remedy.

Primary sources for qualified review:

- [Swedish Distance Contracts Act, chapter 2 sections 10 and 10 a](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-200559-om-distansavtal-och-avtal-utanfor_sfs-2005-59/)
- [Konsumentverket: 2026 online withdrawal-function change](https://www.konsumentverket.se/nyhet/lagandring-gor-det-enklare-att-angra-kop-pa-natet/)
- [Directive 2011/83/EU and its model withdrawal form](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0083)

## Customer Experience

### Entry points

- Footer link: **Withdraw from purchase**
- Returns page link: **Submit a withdrawal notice**
- Shipping email link: **Withdraw from this purchase**

The footer and Returns links are sufficient to discover the function without possessing an email.
The shipping-email link is an additional convenience, not the only access path.

### Form

The page uses one progressive-enhancement form with a review step. It works without client-side
JavaScript.

Fields:

1. **Full name** — required, trimmed Unicode text, 1–200 characters.
2. **Email for your receipt** — required, normalized email, maximum 320 characters.
3. **Order ID or receipt reference** — required, trimmed text, 1–200 characters.
4. **What are you withdrawing?** — required choice:
   - **Entire order**
   - **Specific items**
5. When **Specific items** is selected, require between 1 and 20 item rows. Each row contains:
   - item description, 1–300 characters;
   - quantity, integer 1–99.
6. Receipt statement: **Email my withdrawal receipt to [entered email].**
7. Explicit confirmation: **I confirm that I want to withdraw from this purchase.**

The review step shows every submitted value and requires the final action:

**Confirm withdrawal from purchase**

No eligibility claim appears before or during submission. The page may explain that the intended
change-of-mind flow is for eligible EU orders and that order and eligibility checks happen afterward.

### Immediate success state

Heading:

**Withdrawal notice received.**

Body:

> We received your withdrawal notice on [date and time]. This receipt confirms submission only.
> We'll reconcile your order and eligibility, then email return instructions or an eligibility
> decision.

The page shows:

- public case reference in `WDR-…` format;
- server-recorded UTC timestamp rendered in the customer's locale;
- email delivery state: accepted, queued for retry, or delivered if provider confirmation is already
  available;
- entered order reference and whole/partial scope; and
- a downloadable UTF-8 text receipt generated from the committed case record.

The success page never says **approved**, **return accepted**, **refund started**, or equivalent.

### Eligibility outcomes

Eligible EU outcome:

> Your withdrawal is eligible for the EU change-of-mind process. Follow the return instructions
> below. Do not send the parcel to the seller's registered address unless the instructions say so.

Non-EU change-of-mind outcome:

> This order is not eligible for a change-of-mind return. Damaged or incorrect-item support remains
> available at merch@sveltesociety.dev.

Damage/incorrect-item outcome moves the case into support handling and does not characterize the
request as a voluntary return.

## Architecture

### Modules

1. **Public withdrawal route** — renders the form, review, confirmation, and receipt download.
2. **Submission service** — validates input, enforces origin/rate/idempotency controls, encrypts the
   payload, commits the case and customer-receipt job, and emits a PII-free administrator alert.
3. **Withdrawal repository** — owns case persistence, state transitions, due-message claiming,
   receipt delivery state, and retention purge.
4. **Withdrawal message worker** — decrypts a claimed case only while composing the required Plunk
   message; records only provider delivery ID, attempt count, and stable error code.
5. **MCP withdrawal tools** — expose PII-free listing plus authorized inspection and explicit manual
   actions to the single existing administrator.
6. **Retention job** — removes encrypted payload, encryption metadata, dedupe fingerprint, and any
   order linkage 90 days after closure.

### Submission transaction

1. Validate Host, Origin, CSRF token, rate limit, payload size, and field values.
2. Build a canonical normalized payload.
3. Derive a short-lived HMAC fingerprint for duplicate detection.
4. Return the existing case for an exact retry inside the dedupe window.
5. Generate an unguessable internal UUID and public `WDR-` reference.
6. Encrypt the canonical payload.
7. In one `BEGIN IMMEDIATE` transaction:
   - insert the case;
   - insert the durable customer-receipt message job;
   - insert the PII-free operational alert job; and
   - append the initial case event.
8. Commit before any provider call.
9. Attempt the customer receipt through Plunk immediately with the normal request timeout.
10. Mark delivery complete after Plunk accepts it, or leave the message due for immediate retry.
11. Return the committed case reference, timestamp, delivery state, and downloadable receipt.

Database or encryption failure occurs before a case exists and returns a generic unavailable state.
A provider failure after commit never loses or retracts the notice.

## Data Model

### `withdrawal_cases`

Non-encrypted operational fields:

- internal UUID primary key;
- unguessable public reference, unique;
- status;
- scope: `entire_order` or `specific_items`;
- eligibility: `pending`, `eligible_eu`, `ineligible_non_eu`, or `support_handling`;
- stable outcome code;
- encryption key version;
- encrypted payload, nonce, and authentication tag while retained;
- short-lived HMAC dedupe fingerprint while retained;
- created, updated, reconciled, closed, purge-due, and purged timestamps.

Encrypted payload:

- full name;
- receipt email;
- entered order/receipt reference;
- selected-item descriptions and quantities;
- administrator reconciliation notes restricted to structured identifiers and safe operational text;
- reconciled internal order reference while the case remains active.

### `withdrawal_case_events`

Append-only non-PII audit events:

- case ID;
- actor: `customer`, `codex-admin`, or `system`;
- action;
- prior and next status;
- stable result/error code;
- created timestamp.

Events never contain free text, email, name, entered order reference, provider payload, return address,
or decrypted values.

### `withdrawal_messages`

Dedicated case-message outbox/delivery table:

- case ID;
- kind: receipt, eligible instructions, ineligible decision, support handoff, or resend;
- unique idempotency key;
- attempt count and next-attempt timestamp;
- provider delivery ID;
- completed timestamp;
- stable last error code.

The table stores no recipient email or rendered message. The worker obtains those values by decrypting
the active case at send time.

## Encryption and Key Handling

- AES-256-GCM with a random 12-byte nonce and 16-byte authentication tag.
- `WITHDRAWAL_DATA_KEY` is an exact base64-encoded 32-byte Coolify secret.
- AAD is `withdrawal-case:<schema-version>:<internal-case-id>`.
- Persist a key version so future controlled rotation can decrypt earlier active cases.
- Derive a distinct HMAC dedupe key from the data key using HKDF and a fixed withdrawal-dedupe context.
- Never include the data key in SQLite, logs, Docker image layers, backup objects, reports, or MCP
  output.
- Missing or malformed key blocks checkout-enabled production startup.
- Decryption/authentication failure produces a stable error, an operational alert, and no partial
  case mutation.

Encrypted SQLite backups contain ciphertext only. The withdrawal data key remains separate from the
existing backup encryption key.

## State Machine

Allowed states:

```text
submitted -> reviewing
reviewing -> awaiting_return | ineligible | support_handling
awaiting_return -> closed
ineligible -> closed
support_handling -> closed
```

Only explicit MCP administrator actions can advance manual states. Every transition uses optimistic
state validation and appends one non-PII event in the same transaction.

Closure records a final stable outcome and schedules PII purge for exactly 90 days later. Reopening a
closed case is excluded from the MVP; an administrator creates a linked new case if qualified review
requires further handling.

## MCP Administrator Surface

All tools use the existing static bearer and single administrator role.

- `list_withdrawal_cases` — PII-free reference, status, scope, eligibility, and timestamps.
- `inspect_withdrawal_case` — decrypts and returns one active case for explicit operator review.
- `begin_withdrawal_review` — moves `submitted` to `reviewing`.
- `record_withdrawal_eligibility` — records eligible EU, non-EU ineligible, or support-handling
  outcome and queues the corresponding customer message.
- `record_withdrawal_return` — records safe parcel/outcome metadata without customer free text.
- `close_withdrawal_case` — closes the case and schedules purge.
- `resend_withdrawal_message` — queues an explicit idempotent resend after showing destination and
  content preview to the administrator.

Tool annotations mark all mutation and email actions accurately. List output never decrypts cases.
Inspection and email previews must pass through existing redacted MCP logging.

## Email Behavior

### Customer receipt

Subject:

**Withdrawal notice received — WDR-…**

Body includes the exact committed notice, public reference, receipt timestamp, seller identity, and
the statement that receipt is not eligibility approval or a refund decision.

### Administrator alert

Use a stable `WITHDRAWAL_NOTICE_RECEIVED` operational alert containing only the public case reference
and timestamp. Administrator retrieves details through MCP.

### Retries

- Attempt receipt delivery immediately after case commit.
- Retry transient Plunk errors through the scheduler with bounded backoff.
- Never retry permanent validation/rejection errors indefinitely.
- Emit a PII-free operational alert at the configured failure threshold.
- Plunk acceptance marks delivery, but does not change case eligibility or status.

## Retention

- Active case ciphertext remains available until closure.
- Closure sets `pii_purge_due_at = closed_at + 90 days`.
- Daily scheduler claims due purges under the existing durable lease pattern.
- Purge clears ciphertext, nonce, tag, key version, dedupe fingerprint, and reconciled order linkage in
  one transaction.
- Purge retains public reference, created/closed/purged timestamps, scope, final eligibility, stable
  outcome, event codes, and non-identifying message delivery status.
- Backup copies containing pre-purge ciphertext disappear through the existing 30-day encrypted backup
  retention policy.
- Policy and legal review must approve the 90-day post-closure period before checkout is enabled.

## Security and Abuse Controls

- Reuse existing Host/Origin validation, CSRF protection, client-address normalization, structured
  logging, and response security headers.
- Limit submissions to 5 per normalized client address per 15 minutes.
- Limit request body and field counts before parsing large content.
- Reject control characters, HTML, URLs in item descriptions where not needed, and malformed email.
- Escape all receipt, page, and email values as text; no user-provided HTML.
- Use constant-shape public responses that do not reveal whether an order exists.
- Generate public references with at least 128 bits of randomness; never expose sequential IDs.
- Dedupe exact normalized submissions for 24 hours without disclosing whether another person created a
  case.
- Never log request bodies, names, emails, entered order IDs, decrypted payloads, receipt bodies, or
  Plunk error bodies.
- Receipt download requires the unguessable public reference plus a short-lived signed receipt-session
  cookie set only for the submitting browser. The cookie is `HttpOnly`, `Secure` in production, and
  `SameSite=Strict`; no receipt token appears in a URL, query string, analytics event, or log. Public
  reference alone cannot retrieve PII.
- MCP inspection is the only remote interface that returns decrypted case data.

## Accessibility and UX

- Match the existing Svelte Society palette, typography, spacing, and policy-page shell.
- Use persistent labels, fieldsets, legends, native radios, and quantity inputs.
- Place errors next to the affected field and provide a top-level error summary linked to fields.
- Move focus to the error summary or success heading after submission.
- Use `aria-live="polite"` for delivery-state changes.
- Preserve entered values on validation failure.
- Keep final confirmation visually distinct and describe its consequence immediately before the action.
- Maintain 44px minimum practical pointer targets and visible keyboard focus.
- Respect reduced motion and avoid modal-only confirmation.
- Verify at 320, 768, 1024, and 1440 pixel widths across Chromium, Firefox, and WebKit.

## Configuration and Deployment

New production configuration:

- `WITHDRAWAL_DATA_KEY`

Existing Plunk, SQLite, scheduler, support-email, security, Docker, and backup configuration is reused.
Checkout-enabled production configuration must reject a missing/malformed withdrawal key or incomplete
Plunk/support setup.

The withdrawal route and submission service remain active when `STOREFRONT_ENABLED=false` or
`CHECKOUT_ENABLED=false`. Turning off new sales must not remove an existing customer's withdrawal
path. Maintenance procedures must preserve withdrawal intake or present an approved alternate intake
route; a generic opening-soon page is insufficient.

## Failure Handling

- Validation failure: return field errors; create no case.
- Rate limit: return generic retry response; create no case; log no submitted data.
- SQLite/encryption failure: return service-unavailable state; create no false receipt.
- Plunk failure after commit: show committed case and downloadable receipt; keep email due for retry.
- Duplicate retry: return the same case and do not enqueue duplicate receipt/admin jobs.
- Decryption failure: stop case mutation, emit PII-free alert, require operator recovery.
- MCP transition conflict: return current safe status and require refreshed inspection.
- Scheduler shutdown: abort provider calls cleanly and leave messages claimable after lease expiry.
- Purge failure: retain ciphertext, alert, and retry; never partially clear cryptographic fields.

## Testing Strategy

### Unit

- Exact field validation and normalization.
- Whole-order and selected-item canonical payloads.
- AES-GCM round-trip, AAD binding, tamper rejection, invalid keys, and key versions.
- Public reference randomness/format and signed receipt-token verification.
- State-machine transitions and receipt/ineligibility copy.
- 90-day purge calculations.

### Integration

- Atomic case, message, alert, and event creation.
- Exact retry idempotency and concurrent duplicate submissions.
- No case on validation, database, or encryption failure.
- Case remains committed when Plunk fails.
- Receipt retry, failure alert, and completion semantics.
- Authorized manual EU/non-EU/support reconciliation.
- Whole and partial flows.
- Close and purge transaction, including rollback injection.
- SQLite plaintext scan proving entered name, email, order reference, and item text are absent outside the
  encrypted blob.
- Encrypted backup/restore with active and purged cases.

### MCP

- Static bearer rejection/acceptance.
- PII-free list output.
- Decrypted inspection only for authorized calls.
- Exact schemas, annotations, status conflicts, message previews, and idempotent actions.
- Redacted logs and errors.

### Browser

- Footer, Returns, and shipping-email links.
- Availability with storefront and checkout disabled.
- No-JavaScript submit/review/confirm flow.
- Whole-order and dynamic selected-item paths.
- Keyboard-only and error-summary navigation.
- Success receipt, signed download, provider-queued state, and no approval/refund claim.
- Responsive and reduced-motion profiles across configured browsers.

### Production smoke

- Submit a synthetic notice.
- Receive Plunk customer receipt and PII-free admin alert.
- Inspect and reconcile through Codex MCP.
- Send eligible instructions and non-EU decision in test cases.
- Close a case and verify scheduled purge in a time-controlled drill.
- Confirm persisted data survives Coolify redeploy and restored backup decrypts only with the separate
  withdrawal key.

## Rollout

1. Ship migration and route with checkout still disabled.
2. Configure withdrawal key and verify backup/key recovery runbook.
3. Run legal/privacy review on rendered copy, receipt, eligibility handling, and retention.
4. Run accountant review on refund and record-handling implications.
5. Connect Codex MCP and complete test notices for whole, partial, EU, non-EU, and provider-failure
   flows.
6. Add the link to the shipping email and verify delivery.
7. Keep the function active through preview, monitored real-order gate, and all later checkout states.
8. Enable public checkout only after approvals and production evidence are recorded.

## Non-Goals

- Customer accounts or order history.
- Automatic Stripe lookup before notice acceptance.
- Automatic eligibility decisions.
- Automatic Styria cancellation.
- Automatic return-label generation.
- Automatic Stripe refunds.
- Voluntary non-EU change-of-mind returns.
- File/photo uploads; damaged-item evidence remains a support workflow.

## Acceptance Criteria

- Customer can submit whole or partial withdrawal notice without account or provider lookup.
- Submission records server timestamp and returns an unguessable case reference.
- Customer receives or can download durable receipt that makes no approval/refund claim.
- Plunk failures do not lose committed notices and retry without plaintext PII in outbox rows.
- Administrator can reconcile and manage case through bearer-protected MCP tools.
- Non-EU change-of-mind outcome preserves separate damage/incorrect-item support.
- No automatic refund, vendor cancellation, or fulfillment mutation occurs.
- Active customer fields are encrypted with authenticated encryption and never logged.
- Encrypted PII and linkable order data purge 90 days after closure.
- Route remains available when storefront or checkout is disabled.
- Automated and production-shaped verification passes.
- Qualified legal and accountant approvals are recorded before public checkout.
