# Online withdrawal operations

This runbook covers the `/withdraw` notice and operator case workflow. It is deliberately separate
from cancellation, fulfillment, return-label, and refund systems. A case transition never cancels
an order, contacts Styria, creates a label, changes fulfillment, issues money, or posts an
accounting record. Perform any approved refund and accounting work manually under the separately
reviewed procedure in [policy-review.md](policy-review.md).

Checkout remains off until the complete launch gate is approved. The withdrawal route is designed
to remain reachable with `STOREFRONT_ENABLED=false` and `CHECKOUT_ENABLED=false`.

## What the system guarantees

- A valid confirmation atomically commits one encrypted case, one receipt message, one PII-free
  `WITHDRAWAL_NOTICE_RECEIVED` alert, and one audit event before attempting Plunk delivery.
- The submitting browser receives a 15-minute, reference-bound receipt cookie. Its UTF-8 receipt is
  available only with that cookie; a public `WDR-…` reference alone is insufficient.
- A retryable Plunk failure leaves the message queued and the accepted case/receipt intact.
- PII and reconciliation fields exist only in the version-1 encrypted payload. Lists, events,
  alerts, and structured logs contain the public reference and operational metadata only.
- Closing a case schedules encrypted-payload and deduplication-data purge exactly 90 days later.
  PII-free case, message, and event history remains.

## Monitoring and first response

Monitor readiness, scheduler health, Plunk delivery health, encrypted backup completion, and these
stable alerts:

| Alert | Meaning | Operator response |
| --- | --- | --- |
| `WITHDRAWAL_NOTICE_RECEIVED` | A notice was durably accepted | Open Codex, list and inspect the case, then reconcile it |
| `WITHDRAWAL_MESSAGE_UNSENT` | A message permanently failed, or exhausted five transient attempts | Inspect message history, resolve Plunk/configuration, then use preview/confirm resend |
| `WITHDRAWAL_DATA_UNREADABLE` | An active payload failed authenticated decryption | Stop case mutation, preserve files, verify the exact key, and follow the decrypt incident procedure |
| `SCHEDULER_FAILED` with subject `withdrawal-retention` | A purge batch failed | Keep scheduler state observable, investigate SQLite/guard failure, and rerun only after correction |

Never paste a receipt, customer payload, message preview, provider response, bearer token, cookie,
or encryption key into logs, tickets, or chat. Use the public reference for coordination.

## Inspect and reconcile in Codex

Use authenticated MCP only from the reviewed Codex operator connection. Start with
`list_withdrawal_cases`, optionally filtered by status, then call `inspect_withdrawal_case` for the
selected public reference. The inspection contains PII; keep it within the authorized session.

Every mutation requires the exact current `expected_status` and `expected_revision`. Re-inspect on
`WITHDRAWAL_CASE_CONFLICT`; never guess or mechanically retry a stale decision.

1. Call `begin_withdrawal_review` for a `submitted` case.
2. Reconcile the entered reference to the actual internal order using the authorized order system.
   Record that internal reference and reviewed two-letter country with
   `record_withdrawal_eligibility`.
3. Choose exactly one reviewed path:
   - `eligible_eu`: requires customer-safe return instructions; the case moves to
     `awaiting_return`.
   - `ineligible_non_eu`: sends the reviewed non-EU decision while explicitly preserving
     damaged/incorrect-item support; the case moves to `ineligible`.
   - `support_handling`: for damaged or incorrect-item support. It preserves the submitted notice
     and reconciliation while moving to `support_handling`; it is not a withdrawal denial or an
     automated fulfillment action.
4. For `awaiting_return`, record one reviewed outcome with `record_withdrawal_return`:
   `parcel_received`, `return_waived`, or `return_not_received`. A parcel reference is optional and
   must be a minimal carrier-safe identifier, never an address, free-form case note, payment data,
   or provider response.
5. Close only when the outcome matches the path: `eligible_return_received`,
   `eligible_return_waived`, `eligible_return_not_received`, `ineligible_non_eu`, or
   `support_handling_completed`.

### Safe return instructions

For an eligible case, use only counsel-approved customer instructions. State the actual reviewed
return destination or approved logistics steps and make clear that the seller's registered address
is not automatically a return address. Do not copy internal notes, credentials, provider payloads,
unreviewed Styria instructions, or another customer's address. This field is emailed and retained
inside the encrypted payload until purge.

## Queued receipt or Plunk outage

An on-screen/browser receipt marked queued still proves the notice was accepted. Do not ask the
customer to resubmit: the 24-hour encrypted deduplication guard returns the original case and avoids
duplicate receipt/alert/event rows.

1. Confirm `/health/ready` and SQLite remain healthy; do not delete or recreate the case.
2. Inspect its message attempt count, next attempt time, completion, provider delivery ID, and
   stable error code. Do not query or log a provider request body.
3. Validate the runtime Plunk endpoint, sender identity, secret availability, network, and provider
   status outside application logs. Retryable failures are scheduled at bounded backoff intervals.
4. A provider rejection is terminal; transient failures raise `WITHDRAWAL_MESSAGE_UNSENT` on the
   fifth failed attempt. After correcting the cause, use the resend procedure below.

The browser receipt remains available to the original browser until its cookie expires even when
email is queued or fails. Do not weaken receipt authorization or send a receipt as a ticket
attachment.

## Resend preview and confirmation

Never enqueue a resend directly. In the same authorized review session:

1. Inspect the case and select the exact source message ID.
2. Call `resend_withdrawal_message` with `mode=preview`. Review destination, subject, and full text
   for the correct customer, case, legal status, and return instructions. Treat the preview and its
   token as PII/secrets.
3. If correct and still required, call it again with `mode=confirm`, supplying the unexpired
   `preview_token` and a fresh UUID `idempotency_key`.
4. Re-inspect to verify one resend row and monitor delivery. Reusing the same idempotency key must
   not create another message.

If any field is wrong, do not confirm. Correct the underlying reviewed case/configuration and
generate a new preview.

## Decrypt failure or key loss

`WITHDRAWAL_DECRYPT_FAILED` plus `WITHDRAWAL_DATA_UNREADABLE` is an integrity incident, not a cue to
try random keys.

1. Stop mutations and resends for the case. Keep checkout disabled and preserve the database,
   WAL/SHM, immutable image digest, alert reference, and timestamps without exporting PII.
2. Verify that the running container received the exact historical version-1
   `WITHDRAWAL_DATA_KEY`, its canonical base64 decodes to 32 bytes, and no unreviewed secret
   replacement occurred. Never print the value.
3. If configuration is wrong, use stop-first deployment to restore the correct secret and re-run a
   read-only inspection. If ciphertext/tag corruption is suspected, keep the app stopped and use
   the reviewed backup restore procedure.
4. If the key is permanently lost, active encrypted payloads cannot be recovered from live data or
   backups. Escalate to the incident owner and qualified privacy/legal reviewer; do not generate a
   replacement and claim recovery.

## Retention and 90-day purge drill

The scheduler purges closed cases at `pii_purge_due_at`, exactly 90 days after close, in batches of
100. Delivery and purge use the same scheduler guard, so a case cannot be purged while its message
delivery is active. Purge nulls ciphertext, nonce, tag, schema/key version, and dedupe fingerprint;
it settles any remaining queued message without sending and adds a PII-free purge event.

Run a non-production drill with synthetic canaries before launch and after retention changes:

1. Create and close one active synthetic case and preserve one already-purged synthetic case in an
   encrypted backup fixture. Record only their public references.
2. Run retention one instant before the first due time; expect zero purges and successful active
   decryption. Run at the exact due time; expect one purge.
3. Confirm the purged case remains listable with status/history, cannot be inspected/decrypted, has
   no encrypted or dedupe columns, and emits no queued delivery after purge.
4. Hold a synthetic delivery in progress and run retention; expect the due case to remain active.
   Release delivery, rerun retention, and expect purge.
5. Restore the encrypted backup offline with the original backup and withdrawal keys. Confirm the
   active fixture decrypts and the purged fixture remains non-recoverable. Record aggregate results,
   image digest, and timestamps only.

## Data-subject requests

Route access, erasure, restriction, or correction requests to the authorized privacy process and
qualified reviewer. Verify identity outside this system before inspecting a case. Search by public
reference first; do not broaden MCP into an order-lookup service or export database rows.

For an active case, provide or correct data only through a reviewed, purpose-limited procedure; the
current MCP workflow has no arbitrary edit or early-purge action. For a purged case, explain that
customer/reconciliation payload data is no longer recoverable while PII-free operational history
remains. Legal holds, early erasure, backup exceptions, and response wording require an explicit
reviewed decision—do not change timestamps or SQL rows manually.

## Restore and recovery

Follow [backup-restore.md](backup-restore.md) with the application stopped and exactly one `/data`
attachment. An active withdrawal case requires both the independently stored backup key and the
exact historical withdrawal key. After restore, prove one synthetic active case decrypts and one
purged synthetic case remains non-recoverable before reopening traffic. A restored database never
authorizes checkout, refunds, Styria automation, or case transitions by itself.
