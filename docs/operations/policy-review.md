# Policy and seller review gate

## Launch status

**PENDING — checkout launch is blocked.** Keep `CHECKOUT_ENABLED=false` in production until every
item in both approval records below is supplied by the qualified reviewer and accountant, the
approved document commit is deployed unchanged, and each recorded operating condition is met.

This file is a review record and handoff template. It does not claim legal or accounting approval,
does not identify a reviewer who has not reviewed the documents, and does not store private
correspondence.

## Qualified legal review

| Field | Status |
| --- | --- |
| Reviewer role and qualification | Pending — not supplied |
| Review date | Pending — not supplied |
| Approved policy document commit SHA | Pending — not supplied |
| Approved jurisdictions and languages | Pending — not supplied |
| Operational conditions | Pending — not supplied |
| Final decision | Not approved |

The legal reviewer must review the rendered Shipping, Returns, Privacy, Terms, and About pages,
the checkout disclosures, the return workflow, and the local-order deletion procedure against the
deployed seller and provider configuration.

### Online withdrawal implementation requiring approval

Sweden's Distance Contracts Act, chapter 2 section 10 a, as amended by SFS 2026:246, requires an
accessible online withdrawal function for eligible contracts concluded through an online
interface. The function must support the required identifying and contract information, an
explicit withdrawal confirmation, and a prompt durable receipt. The provision took effect before
this draft was prepared.

The application now implements an online withdrawal route, explicit review/confirm action, durable
browser receipt, queued email receipt, encrypted case workflow, operator reconciliation, and
90-day post-close PII purge. Implementation is not approval. A qualified Swedish/EU consumer-law
reviewer must review the deployed, rendered behavior and record a decision for each of these
surfaces before checkout is enabled:

- the labels and explanatory copy on `/withdraw`, including the distinction between withdrawal,
  damaged/incorrect-item support, eligibility, returns, and refunds;
- the explicit review and confirmation action and the information shown immediately before it;
- the browser receipt, emailed receipt, eligibility/ineligibility/support messages, and resend
  behavior;
- the Shipping, Returns, Privacy, Terms, About, and withdrawal-route copy as one consistent set;
- the 90-day post-close retention period, purge behavior, backup implications, and data-subject
  handling; and
- route availability when the storefront and checkout are disabled, including accessibility and
  durable-receipt expectations.

Record the reviewed commit SHA, rendered production origin, jurisdictions/languages, required copy
changes, and operational conditions in this file. Until those fields are supplied, the function is
deployed only as an unapproved launch prerequisite and `CHECKOUT_ENABLED` remains `false`.

No merchandise-specific withdrawal exclusion is claimed in the current policy draft. Any future
exclusion must be supported by the reviewed law and explicitly approved before publication.

## Qualified accountant approval

| Field | Status |
| --- | --- |
| Reviewer role and qualification | Pending — not supplied |
| Review date | Pending — not supplied |
| Approved policy document commit SHA | Pending — not supplied |
| Approved seller identity and VAT presentation | Pending — not supplied |
| Approved registrations and tax treatment | Pending — not supplied |
| Approved Styria ship-from treatment | Pending — not supplied |
| Operational conditions | Pending — not supplied |
| Final decision | Not approved |

The application does not assert a tax position in this record. The accountant must verify the real
seller legal fields, registrations, VAT presentation, checkout behavior, destinations, shipping
charge treatment, Stripe receipt and invoice configuration, and Styria ship-from treatment before
checkout is enabled.

The withdrawal workflow intentionally does not issue refunds, cancel fulfillment, create Styria
return labels, or post accounting records. The qualified accountant must approve the manual refund
and record-handling procedure: which reviewed payment/order evidence is required, who issues a
refund outside this application, how fees/shipping/VAT are recorded, how double refunds are
prevented, and which PII-free reconciliation evidence is retained. That approval must not be
inferred from a successful withdrawal case closure.

## Required production values

Before review and launch, replace every placeholder with the real reviewed value and verify that
production checkout refuses to start when any value is missing:

- `SELLER_LEGAL_NAME`
- `SELLER_REGISTRATION_NUMBER`
- `SELLER_VAT_NUMBER`
- `SELLER_ADDRESS_LINE1`
- `SELLER_POSTAL_CODE`
- `SELLER_CITY`
- `SELLER_COUNTRY`
- `SELLER_EMAIL`
- `SUPPORT_EMAIL=merch@sveltesociety.dev`
- `DELIVERY_ESTIMATE_EU`
- `DELIVERY_ESTIMATE_ASIA`
- `POLICY_EFFECTIVE_DATE`

## Official sources consulted for the draft

Source access date: 2026-07-17. These primary official sources informed the conservative draft;
they are not a replacement for the approvals above.

- Sveriges Riksdag, [Lag (2005:59) om distansavtal och avtal utanför affärslokaler](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-200559-om-distansavtal-och-avtal-utanfor_sfs-2005-59/), including chapter 2 sections 10–15 and the 2026 online-withdrawal-function amendment.
- EUR-Lex, [Directive 2011/83/EU on consumer rights](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0083), including Articles 9–14 and Annex I(B)'s model withdrawal form.
- Konsumentverket, [The Distance Contracts Act for consumers](https://www.konsumentverket.se/lagar/lagen-om-distansavtal-och-avtal-utanfor-affarslokaler-konsument/).
- Konsumentverket, [Guidance on complaints about faulty goods](https://www.konsumentverket.se/konsumentratt-process/reklamera-vara/).
- IMY, [GDPR full text](https://www.imy.se/verksamhet/dataskydd/det-har-galler-enligt-gdpr/introduktion-till-gdpr/dataskyddsforordningen-i-fulltext/).
- IMY, [Legal bases for processing](https://www.imy.se/verksamhet/dataskydd/det-har-galler-enligt-gdpr/rattslig-grund/).
- IMY, [Transfers of personal data to third countries](https://www.imy.se/verksamhet/dataskydd/det-har-galler-enligt-gdpr/overforing-till-tredje-land/).
- IMY, [Right to erasure](https://www.imy.se/privatperson/dataskydd/dina-rattigheter/radering/).

## Approval completion checklist

- [ ] Record the legal reviewer role and qualification, review date, approved commit SHA, and
      operating conditions without copying private correspondence.
- [ ] Record the accountant role and qualification, review date, approved commit SHA, and operating
      conditions without copying private correspondence.
- [ ] Record qualified counsel approval for the rendered route labels, review/confirm action,
      receipts/messages, policy copy, retention, and off-storefront route availability.
- [ ] Record qualified accountant approval for manual refund and accounting-record handling.
- [ ] Verify the implemented online withdrawal workflow against those recorded approvals.
- [ ] Verify the deployed seller and policy values exactly match the approved record.
- [ ] Re-run the production configuration, policy-route, checkout, accessibility, and deletion tests
      against the approved commit.
- [ ] Only then consider changing `CHECKOUT_ENABLED` from `false`.
