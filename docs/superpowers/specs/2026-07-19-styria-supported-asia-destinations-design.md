# Styria-Supported Asia Destinations Design

**Date:** 2026-07-19  
**Status:** Approved for implementation planning

## Goal

Expand the Svelte Society Shop from the EU to Asian destinations without accepting an order that the current fulfillment provider cannot ship. Styria availability is the operational source of truth. Stripe remains the checkout, payment, and tax calculator, but Stripe address support alone never makes a destination saleable.

The shop continues to sell in EUR with the existing shipping offer: EUR 10 for one total unit and free shipping for two or more total units.

## Scope

The intended sales-market ceiling is:

- the European Union, excluding Slovenia;
- Asian countries and territories represented by supported Stripe Checkout delivery codes; and
- the United States only when Styria has explicitly restored service.

The effective checkout list is always the intersection of that sales-market ceiling and the current Styria-supported allowlist. No country outside the effective list reaches Stripe Checkout.

Styria currently states that it uses Asendia for worldwide delivery and publishes a rest-of-world service, but it does not publish a country-discovery API or a definitive machine-readable country list. Its order API accepts a free-form country name. Styria also currently marks the United States as unavailable. Therefore, the shop must use a reviewed, explicit allowlist rather than infer support from Stripe or scrape Styria's website.

Sources:

- Styria delivery information: <https://styriashirts.eu/delivery>
- Styria order API: <https://styriashirts.eu/api-documentation>
- UN M49 geographic regions used to define Asia consistently: <https://unstats.un.org/unsd/methodology/m49/overview/>

## Initial Destination Configuration

The deployed `STYRIA_SUPPORTED_COUNTRIES` value is an uppercase, comma-separated list of ISO alpha-2 delivery codes reviewed against current Styria availability.

Based on Styria's current worldwide/rest-of-world statement, the initial reviewed list is the union of these exact groups:

- EU except Slovenia: `AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,ES,SE`.
- Asia intersected with Stripe Checkout delivery codes, including Stripe's operational `TW` code: `AE,AF,AM,AZ,BD,BH,BN,BT,CN,CY,GE,HK,ID,IL,IN,IQ,JP,JO,KG,KH,KR,KW,KZ,LA,LB,LK,MM,MN,MO,MV,MY,NP,OM,PH,PK,PS,QA,SA,SG,TH,TJ,TL,TM,TR,TW,UZ,VN,YE`.

`CY` appears in both source groups but occurs once in the effective set. The initial list must exclude:

- Slovenia, because fulfillment starts there and domestic Slovenian VAT handling is outside this MVP;
- the United States while Styria marks it unavailable;
- any destination missing from Stripe Checkout's delivery-country type;
- any destination Styria or its carrier explicitly suspends; and
- any destination the operator cannot lawfully or reliably serve.

Iran, North Korea, and Syria are not part of the initial list because Stripe Checkout does not expose them as allowed delivery-country codes. Taiwan is treated as an operational delivery code (`TW`) without making a political or territorial statement.

This allowlist is configuration, not an automatically discovered fact. A country is added only after current Styria support is confirmed. A country is removed as soon as Styria suspends it.

## Configuration and Architecture

### Market ceiling

A repo-owned constant defines the maximum markets the shop intends to serve. It prevents a configuration typo from enabling an unrelated destination. It contains:

- EU-27 except Slovenia;
- UN M49 Asia delivery codes supported by Stripe Checkout, plus Stripe's `TW` delivery code; and
- the United States as a disabled-by-default optional market.

### Provider allowlist

`STYRIA_SUPPORTED_COUNTRIES` is parsed once during server startup. Parsing must:

- trim values;
- require uppercase two-letter codes;
- reject duplicates;
- reject unknown Stripe delivery codes;
- reject values outside the market ceiling;
- reject Slovenia;
- fail closed if the result is empty; and
- expose no secret or unnecessary environment data in logs or readiness responses.

The effective destination list is the validated provider allowlist. The same immutable runtime value is injected into every commerce boundary rather than being read independently in multiple modules.

### Enforcement points

The effective destination list is used by:

1. Stripe Checkout `shipping_address_collection.allowed_countries`.
2. Paid Checkout Session validation before an order is accepted locally.
3. Fulfillment preparation before administrator approval.
4. Styria payload construction and submission validation.
5. Public destination and policy content.

Browser input never supplies or expands the allowlist. A destination omitted from the runtime configuration is rejected even if Stripe or Styria would otherwise accept its spelling.

### Availability changes

Styria has no documented availability endpoint, so the shop does not scrape its website or attempt speculative validation by creating vendor orders.

When availability changes, the operator must:

1. disable storefront checkout;
2. expire or allow existing Stripe Checkout Sessions to close;
3. update `STYRIA_SUPPORTED_COUNTRIES` in Coolify;
4. redeploy using the stop-first SQLite procedure;
5. verify the resulting Stripe Checkout country selector; and
6. re-enable checkout.

This avoids taking payment under an old destination policy. A paid order that becomes unfulfillable after payment remains an administrator-review case and must be resolved manually; it is never silently discarded.

## Tax and Customs

Stripe automatic tax remains enabled for every Checkout Session.

For EU destinations, the existing Swedish Union OSS configuration calculates destination-country VAT. Slovenia remains excluded.

For destinations outside the EU, Stripe applies the tax treatment supported by the shop's registrations and transaction evidence. The shop does not promise that checkout includes import VAT, customs duty, brokerage, carrier fees, or other border charges. The recipient is responsible for charges assessed after checkout and should check local import rules before ordering.

The shop must not claim that every non-EU order is tax-free. Stripe Tax reporting and registration-threshold monitoring remain operational responsibilities.

## Shipping and Tracking

The customer-facing estimate for supported Asian destinations is:

> Production normally takes 1–5 business days, followed by roughly 6–10 business days in transit. These are estimates, not guaranteed delivery dates.

This yields a rough total of 7–15 business days without presenting a guarantee. Tracking is shared when the carrier provides it. Some destinations may receive an untracked service, and the policy must say so plainly.

The existing EUR 10 single-unit and free two-or-more-unit shipping offer applies. The business accepts the margin risk when Styria's actual rest-of-world shipping cost exceeds the amount collected from the customer.

## Returns, Complaints, and Mandatory Rights

The shop offers no voluntary change-of-mind returns or exchanges outside the EU.

The policy must not say “no returns” without qualification. It must preserve mandatory rights that apply to faulty, damaged, incorrect, or misdescribed goods, and any non-waivable consumer rights in the customer's jurisdiction. These cases continue through support and manual review; the shop does not automatically refund Stripe or cancel Styria work.

The existing withdrawal workflow already classifies a valid non-EU country as ineligible for the EU withdrawal process. Asian destinations reuse that behavior and direct the customer to support where mandatory complaint rights may apply.

## Customer-Facing Copy

### Storefront and cart

> Shipping across the EU (except Slovenia) and to Styria-supported destinations in Asia.

Avoid listing “worldwide shipping.” Availability is intentionally narrower and can change with provider support.

### Shipping policy: destinations

> We ship only to destinations currently supported by our fulfillment partner: the EU except Slovenia, and selected destinations across Asia. Availability is enforced at checkout and may change if a fulfillment or carrier route is suspended.

### Shipping policy: non-EU charges

> Deliveries outside the EU may be charged import VAT, customs duties, brokerage fees, or carrier charges after checkout. These charges are not collected by this shop and are the recipient's responsibility. Check your local import rules before ordering.

### Shipping policy: delivery

> For supported Asian destinations, production normally takes 1–5 business days, followed by roughly 6–10 business days in transit. These are estimates, not guaranteed delivery dates. We share tracking when the carrier provides it; tracking may not be available for every destination.

### Returns policy: non-EU orders

> We do not offer voluntary returns or exchanges for change of mind outside the EU. This does not limit mandatory rights that may apply to faulty, damaged, incorrect, or misdescribed goods. Contact support before sending anything back.

### Terms

The Terms of Sale must identify the effective regions, link to the Shipping and Returns policies, state that availability is enforced at checkout, and preserve mandatory local consumer rights.

## Error Handling

- Invalid destination configuration prevents commerce readiness and keeps checkout disabled.
- An unsupported browser-supplied country cannot alter the server allowlist.
- A paid session with a destination outside the effective list is not submitted to Styria and requires administrator review.
- A Styria destination rejection is recorded using the existing stable provider error handling; it is never retried blindly.
- A removed country never disappears from historical order records or audit events.

## Testing

Unit and integration coverage must prove:

- exact configuration parsing and immutable output;
- rejection of lowercase, malformed, duplicate, unknown, out-of-market, Slovenian, and empty lists;
- Stripe Checkout receives exactly the effective destination list;
- paid-session and fulfillment validation reject destinations outside it;
- no client input can expand it;
- EU withdrawal eligibility remains unchanged;
- supported Asian destinations are classified as non-EU and ineligible for voluntary withdrawal;
- damaged or incorrect item copy preserves mandatory rights;
- shipping, storefront, cart, returns, and terms copy agree;
- the US is absent while Styria marks it unavailable;
- application readiness fails closed for invalid destination configuration; and
- the production build and serialized integration suite pass.

Deployment verification must create a new sandbox Checkout Session and confirm:

- an enabled Asian destination appears in Stripe Checkout;
- Slovenia and the United States do not appear;
- Stripe automatic tax completes without an application error;
- the success page resolves after sandbox payment; and
- the paid order remains available for administrator fulfillment review.

## Out of Scope

- Scraping Styria's website for availability.
- Creating test vendor orders to probe country support.
- Promising tracked delivery for every destination.
- Collecting import charges outside Stripe's supported tax configuration.
- Automatic refunds, returns, replacements, or Styria cancellations.
- Expanding to Africa, Oceania, Canada, Latin America, the United Kingdom, or Switzerland solely because Styria describes worldwide service.

## Launch Gate

Before enabling the expanded list, the operator must review the exact codes in Coolify against current Styria availability and obtain qualified tax/legal confirmation for the non-EU sales model and the Styria dropshipping supply chain. Implementation can enforce the configured list, but it cannot establish carrier availability or legal obligations by itself.
