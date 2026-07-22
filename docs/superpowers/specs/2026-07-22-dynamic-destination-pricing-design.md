# Dynamic Destination Pricing Design

**Date:** 2026-07-22  
**Status:** Approved  
**Scope:** Storefront price presentation, country selection, Stripe catalog and Checkout, paid-order normalization, Styria retail pricing, policy copy, and rollout

## Summary

The shop will use one net EUR catalog price for every destination and add destination tax through Stripe Automatic Tax at Checkout.

- Every Community Tee variant costs **EUR 20.00 excluding tax**.
- Paid shipping costs **EUR 8.00 excluding tax** for a one-unit cart.
- Shipping is free for carts with two or more total units.
- EU storefront prices add the selected destination's standard VAT rate.
- Supported non-EU storefront prices show the export price without EU VAT.
- Stripe Checkout recalculates the authoritative tax and total from the complete delivery address and any accepted tax ID.

The country picker is visible in the global header immediately before the cart. It controls the prices and tax/customs copy shown throughout the storefront. The selected country is also the only country accepted by the Checkout Session created from that storefront state, preventing a customer from choosing one market and checking out to another.

This design replaces the Swedish-reference-price presentation and the fixed EUR 10 tax-inclusive shipping contract.

## Goals

1. Present a useful destination-specific price before Checkout.
2. Keep merchandise economics stable with one EUR 20 net price in every market.
3. Let Stripe Automatic Tax remain authoritative for the actual charge and OSS reporting.
4. Avoid trusting browser-supplied prices, VAT rates, totals, or fulfillment data.
5. Keep the selected market consistent between the storefront and Stripe Checkout.
6. Preserve an auditable paid-order snapshot and send the customer-facing unit price to Styria.
7. Support the existing EU-except-Slovenia and Styria-supported Asia destination policy.
8. Make tax, export charges, and free-shipping behavior understandable without overloading each product card.

## Non-goals

- No localized currencies; the shop remains EUR-only.
- No country-specific net merchandising or margin adjustments.
- No support for destinations outside the reviewed source-controlled Styria destination list.
- No United States support in this phase.
- No Slovenia support in this phase.
- No promotion codes or merchandise discounts in this phase.
- No storefront call to Stripe Tax for every page render or country change.
- No promise that the storefront estimate handles every special tax territory, exemption, or business tax-ID case.
- No change to the current return eligibility policy: EU consumers may use the withdrawal flow; non-EU orders are not eligible for voluntary returns.

## Pricing Contract

### Stripe catalog

Each active purchasable variant has one one-time EUR Price with:

| Field | Required value |
| --- | --- |
| `currency` | `eur` |
| `unit_amount` | `2000` |
| `tax_behavior` | `exclusive` |
| Product tax code | Tangible apparel tax code already approved for the product |

The active variants continue to carry the existing variant, SKU, Styria product number, design, mockup, thread-colour, and size metadata. A Stripe Price ID identifies a net EUR 20 unit, never a VAT-inclusive market price.

Existing EUR 25 exclusive Prices may be archived after the replacement Prices are ready. This is a greenfield cutover: old test Sessions and local orders are not part of the supported contract.

### Stripe shipping rates

The paid Shipping Rate is replaced with:

| Field | Required value |
| --- | --- |
| Type | Fixed amount |
| `currency` | `eur` |
| `fixed_amount.amount` | `800` |
| `tax_behavior` | `exclusive` |
| Tax code | Shipping |

The free Shipping Rate remains EUR 0 with `tax_behavior=exclusive`. The Checkout service selects paid shipping for exactly one total unit and free shipping for two or more total units.

### Display calculation

Storefront calculations use integer cents and VAT basis points:

```text
gross_cents = round_half_up(net_cents * (10_000 + vat_basis_points) / 10_000)
```

The implementation must not use binary floating-point arithmetic for money.

Examples:

| Destination | Standard VAT | Tee | Paid shipping | One-tee total before any adjustment |
| --- | ---: | ---: | ---: | ---: |
| Sweden | 25% | EUR 25.00 | EUR 10.00 | EUR 35.00 |
| Germany | 19% | EUR 23.80 | EUR 9.52 | EUR 33.32 |
| Finland | 25.5% | EUR 25.10 | EUR 10.04 | EUR 35.14 |
| Hungary | 27% | EUR 25.40 | EUR 10.16 | EUR 35.56 |
| Supported Asia destination | 0% EU VAT | EUR 20.00 | EUR 8.00 | EUR 28.00 |

For two or more units, shipping is EUR 0. The merchandise price continues to use the selected destination treatment.

### Storefront VAT table

The storefront uses a server-owned, versioned standard-rate table for its pre-Checkout projection. It is not sourced from Product metadata and cannot be supplied by the browser.

The initial table, reviewed against the European Commission's current standard-rate table on 2026-07-22, is:

| Country | Basis points | Country | Basis points |
| --- | ---: | --- | ---: |
| AT | 2000 | BE | 2100 |
| BG | 2000 | HR | 2500 |
| CY | 1900 | CZ | 2100 |
| DK | 2500 | EE | 2400 |
| FI | 2550 | FR | 2000 |
| DE | 1900 | GR | 2400 |
| HU | 2700 | IE | 2300 |
| IT | 2200 | LV | 2100 |
| LT | 2100 | LU | 1700 |
| MT | 1800 | NL | 2100 |
| PL | 2300 | PT | 2300 |
| RO | 2100 | SK | 2300 |
| ES | 2100 | SE | 2500 |

Slovenia is intentionally absent because it is not a supported destination. Every enabled Asia destination maps to zero EU VAT for display.

The table must include review metadata such as `reviewedAt` and a source URL. A code change and deployment are required to alter a storefront VAT rate. Stripe's current configuration remains authoritative for the charged tax, so a stale display table cannot change the amount Stripe collects.

The European Commission notes that its standard-rate table does not cover special regional rates. Therefore the storefront text must identify this as the standard consumer price for the selected country and say that the exact tax is confirmed from the full address at Checkout.

## Destination Selection UX

### Placement and label

The control appears in the global header immediately before Cart.

- Closed state: `Deliver to: Sweden`
- Accessible name: `Choose delivery country`
- Desktop: compact button opening an anchored searchable dialog.
- Mobile: the same dialog is styled as a full-width sheet with search and comfortable touch targets.
- Country names, not flags alone, communicate the current selection.

The list is grouped into:

1. European Union
2. Asia

Only destinations in the source-controlled `SUPPORTED_DESTINATIONS` list appear. It is the reviewed union of the supported EU and Asia lists. Slovenia, the United States, and all other countries are absent rather than shown as selectable-but-disabled. Changing country support requires a reviewed code change and deployment; there is no Coolify country-list variable.

The country control is a global preference, not an item-level choice. A selection change updates product cards, product detail, cart lines, cart totals, shipping price, and tax/customs copy together.

### Initial country resolution

The server resolves the initial selection in this order:

1. A valid explicit destination cookie.
2. A supported Cloudflare country hint, when present.
3. Sweden.

The Cloudflare hint only supplies an initial suggestion. It never overrides an explicit cookie and never determines the tax charged by Stripe.

### Persistence

The selected ISO 3166-1 alpha-2 country is stored in a first-party cookie:

- Name is `shop_destination_v1`.
- Value is accepted only when it is in `SUPPORTED_DESTINATIONS`.
- `Path=/`.
- `Max-Age` of one year.
- `SameSite=Lax`.
- `Secure` in production.
- `HttpOnly` is enabled because application state is returned from the server; browser code does not need to read the cookie directly.

An enhanced form posts to the same-origin `/preferences/destination` endpoint. The endpoint validates the country, sets the cookie, and returns a `303` redirect to a validated same-origin `returnTo` path. The enhanced client follows the same contract, invalidates destination-dependent page data, and restores focus to the country control. The non-JavaScript form path must also work.

Changing country does not change cart Price IDs because every country uses the same exclusive Stripe Price. It only changes the projection and the country accepted by the next Checkout Session.

### Price and tax copy

For an EU selection:

- Primary product price: the computed gross amount.
- Supporting text: `Includes [rate]% [country] VAT. Exact tax is confirmed from your delivery address at checkout.`
- The cart shows destination-specific merchandise and shipping amounts.

For an Asia selection:

- Primary product price: the net export amount.
- Supporting text: `EU VAT excluded. Import VAT, duties, brokerage, or carrier fees may be charged on arrival.`
- The purchase terms and shipping policy remain the complete source for the recipient-responsibility rule.

For customers entering a tax ID, Stripe may apply a different legal tax treatment. Checkout is authoritative; the storefront projection is the standard consumer price.

## Application Data Flow

### Request-level destination

The root server layout resolves a `PricingDestination` containing:

- validated country code;
- display name;
- region (`eu` or `asia`);
- VAT basis points;
- selection source (`cookie`, `cloudflare_hint`, or `fallback`);
- whether import-charge copy is required.

Only the validated country, region, and VAT rate reach rendering components. Raw Cloudflare headers are not exposed to the client.

### Catalog projection

The catalog domain model keeps `unitAmountCents` as the exclusive Stripe source amount. Remove the Swedish-only `referenceGrossCents` field and replace `swedishReferenceGrossCents` with the destination-neutral `displayPriceForDestination` helper.

Components receive a `DisplayPrice` containing net, VAT, and gross cents. A pure domain function derives it from the net amount and validated `PricingDestination`, allowing catalog, product, and cart tests to share the same rounding rules.

Cart state continues to store only Price IDs and quantities. Display amounts are always resolved from the current Stripe catalog and the validated destination; no amount is persisted in local storage.

### Checkout draft

The selected destination is frozen when the Checkout draft is created.

Add `destination_country` to `checkout_drafts`. The Checkout service reads the validated server destination, stores it in the draft, and supplies a one-element `allowed_countries` list to Stripe Checkout.

The browser still submits only cart identifiers and quantities. The server resolves:

- active Stripe Price IDs and EUR 20 unit amounts;
- shipping mode from total quantity;
- the configured exclusive Shipping Rate ID;
- the selected, validated destination from request state.

The destination is also included in versioned Checkout metadata for operator diagnostics, but the database draft remains the comparison source of truth.

### Stripe Checkout

Each Session keeps:

- `automatic_tax.enabled = true`;
- tax-ID collection;
- invoice creation;
- terms acceptance;
- a single selected-country entry in `shipping_address_collection.allowed_countries`;
- the exclusive paid or free Shipping Rate;
- the draft ID and checkout contract version in Session and PaymentIntent metadata.

If the buyer needs another country, they return to the cart, change `Deliver to`, and create a new Session. A Session is never silently repriced to another selectable country.

Stripe's complete shipping address and tax-ID validation determine the legal tax treatment. Successful Checkout may therefore differ from the standard-rate projection for special territories, valid business exemptions, or configuration changes.

### Paid-order normalization

Increment the checkout contract version because the shipping-tax and line-snapshot rules change.

The paid Checkout adapter validates an all-exclusive contract:

1. Every merchandise Price is EUR, one-time, exclusive, and matches the immutable draft amount.
2. The paid Shipping Rate is fixed EUR, exclusive, and matches the draft's paid/free mode.
3. Every line satisfies `amount_total = amount_subtotal - amount_discount + amount_tax`.
4. Discounts remain zero because this Checkout contract does not enable them.
5. Session merchandise subtotal equals the sum of line subtotals.
6. Session discount equals the sum of line discounts and is zero.
7. Total tax equals merchandise-line tax plus shipping tax.
8. Shipping total equals shipping subtotal plus shipping tax.
9. Session total equals net merchandise plus net shipping plus all tax.
10. PaymentIntent and captured Charge equal the Session total.
11. Stripe's shipping country equals the draft's frozen destination and is still in `SUPPORTED_DESTINATIONS`.

The paid snapshot adds an explicit shipping-tax amount. The persisted top-level order amount meanings are:

| Field | Meaning |
| --- | --- |
| `subtotal_amount` | Net merchandise before discount |
| `discount_amount` | Merchandise discount; zero in this contract |
| `shipping_amount` | Gross shipping charged to the customer |
| `shipping_tax_amount` | Tax contained in `shipping_amount` and also included in `tax_amount` |
| `tax_amount` | Merchandise tax plus shipping tax |
| `total_amount` | Amount captured from the customer |

`PaidCheckoutSnapshot.amounts` and the order domain expose this field as `shippingTax`.

The durable invariant is:

```text
merchandise_tax = tax_amount - shipping_tax_amount
total_amount = subtotal_amount - discount_amount + merchandise_tax + shipping_amount
```

`shipping_amount` keeps its customer-facing gross meaning. The new `shipping_tax_amount` removes any need to infer the tax contained in shipping. Because the application is greenfield, migration 0007 refuses to run when checkout drafts, orders, or order lines already exist. The controlled rollout backs up and resets the disposable pre-launch commerce database, then applies the v2 schema to an empty store. No historical amount backfill or mixed-tax compatibility path is supported.

`hasValidInclusiveShippingAmounts` and equivalent mixed-tax naming are removed in favour of the explicit merchandise/shipping tax invariant.

### Customer-facing retail unit amount

The Styria API defines `retailPrice` as the retail price printed on the invoice sent with the parcel. It must therefore receive the customer-facing gross merchandise unit price, not the EUR 20 net Stripe Price.

The paid Checkout adapter derives an immutable `retailUnitAmount` for each merchandise line:

```text
retail_unit_amount = line.amount_total / line.quantity
```

Because discounts are disabled and the selected EUR 20 net price produces whole-cent gross prices at every supported standard EU rate, the result is expected to be an integer. The adapter rejects a paid snapshot if a line total is not evenly divisible by quantity; it must not guess or round a provider invoice value.

Add a non-null `retail_unit_amount` column to `order_lines`. It is populated from the verified paid Stripe line and remains immutable. There is no historical backfill. Draft lines continue to store the trusted net unit amount.

The Styria payload sends:

```text
retailPrice = retail_unit_amount / 100
```

The line's existing `unit_amount` remains the net Stripe amount used for order reconciliation. MCP order inspection should identify net unit amount and customer-facing retail unit amount distinctly.

## Error and Recovery Behavior

### Invalid or stale destination cookie

Ignore it and resolve from a supported Cloudflare hint or Sweden. Never echo an invalid country code into markup or Stripe parameters.

### Country removed from source-controlled support

If an explicit cookie names a country removed from `SUPPORTED_DESTINATIONS`, fall back as above. A Checkout draft cannot be created for the removed country.

### VAT table missing an enabled EU country

Fail closed for commerce rendering and Checkout creation with a stable catalog/pricing error. Do not silently display the net price to an EU customer.

### Catalog and VAT mismatch

Checkout always uses server-resolved Stripe Price IDs. If a Price is not EUR 20 exclusive, it is excluded from the purchasable catalog and reported through existing catalog diagnostics.

### Storefront projection differs from Checkout

Checkout displays and charges Stripe's authoritative total. The success page and receipt use the paid Stripe snapshot. Operational logging records a stable mismatch code without customer personal data if an unexpected material discrepancy is detected during test instrumentation.

### Stale carts during migration

The shop is still in controlled pre-launch testing, so the migration invalidates carts containing the old EUR 25 Price IDs. The cart removes unresolved old-price lines and shows `A product price changed. Please add the item again.` with a link to the collection. Old Price IDs are never silently remapped during Checkout.

### Previous Checkout Sessions

The cutover is v2-only. Checkout is disabled before deployment, previous test Sessions are expired or abandoned, and webhook normalization accepts only contract version 2. Version 1 Sessions and local orders are deliberately unsupported.

## Policy and Content Changes

Remove copy that states:

- all paid shipping costs EUR 10 regardless of country;
- product prices are Swedish VAT reference prices;
- tax is only added later without showing the selected-country projection.

Replace it with destination-aware copy:

- prices are in EUR and use the country shown in `Deliver to`;
- EU prices include the selected country's standard VAT projection;
- exact tax is confirmed from the full delivery and business details in Checkout;
- paid shipping is EUR 8 excluding tax and is displayed with destination tax where applicable;
- shipping remains free for two or more units;
- supported non-EU orders exclude EU VAT and may incur recipient-paid import charges;
- changing the delivery country can change the displayed price.

Terms and shipping policy prose should describe the pricing rule rather than enumerate every country's current amount. This avoids policy copy becoming stale when a VAT rate changes.

## Accessibility and Interaction Requirements

- The header control is reachable in logical tab order before Cart.
- The current country is included in the control's accessible name.
- The dialog has a visible heading, labelled search field, initial focus, focus containment, Escape handling, and focus restoration.
- Country options use radio semantics with a programmatically exposed selected state.
- Price changes are announced once through a polite live region; every product card must not announce independently.
- No selection relies on colour or a flag alone.
- Touch targets remain at least 44 by 44 CSS pixels.
- The mobile control does not make the header horizontally scroll.
- Enhanced and non-JavaScript form submissions preserve the current path where safe.
- Reduced-motion preferences disable nonessential dialog transitions.

## Security and Privacy

- Browser country input is untrusted and validated against `SUPPORTED_DESTINATIONS`.
- Browser amounts, VAT rates, shipping values, and totals are ignored.
- Checkout Price and Shipping Rate IDs come from server configuration and the validated catalog.
- Country-selection POST requests use the existing same-origin/origin protections.
- The destination cookie contains only a country code and no precise location.
- Raw Cloudflare geolocation headers are never logged as customer data or passed to analytics.
- Analytics may record a coarse region (`eu` or `asia`) but not a Checkout Session ID, order ID, address, VAT ID, or cart contents.
- Paid-order normalization continues to fail closed on inconsistent Stripe totals.

## Stripe and Coolify Migration

Use a controlled checkout maintenance window:

1. Disable creation of new Checkout Sessions.
2. Take the required encrypted SQLite backup, then reset the disposable pre-launch commerce database so migration 0007 starts from an empty commerce store.
3. Create replacement EUR 20 exclusive Stripe Prices for every active variant, preserving required metadata.
4. Create the EUR 8 exclusive paid Shipping Rate and verify the EUR 0 rate contract.
5. Configure product and shipping tax codes in the Stripe sandbox.
6. Deploy the destination-pricing code and v2-only database migration with checkout still disabled.
7. Update Coolify to the replacement paid/free Shipping Rate IDs as required.
8. Activate the new Prices and archive the old EUR 25 Prices and superseded Shipping Rates.
9. Restart the app to clear the catalog cache and verify catalog readiness.
10. Test Sweden, Germany, Finland, Hungary, and at least one supported Asia destination in Stripe sandbox.
11. Inspect the resulting local order and Styria preview payload, including `retailPrice`.
12. Enable Checkout only after the test matrix passes.

## Testing Strategy

### Unit tests

- Integer calculation at 0%, 17%, 19%, 20%, 25%, 25.5%, and 27%.
- Half-up rounding behavior even though the initial EUR 20/EUR 8 amounts yield whole cents.
- Every enabled EU destination has one valid VAT entry.
- Every Asia destination produces the export projection and import-charge copy.
- Slovenia, US, duplicate entries, lowercase codes, and unknown countries are rejected.
- Cookie, Cloudflare hint, and Sweden fallback precedence.
- EUR 20 exclusive catalog validation.
- EUR 8 exclusive and EUR 0 shipping validation.
- Destination-specific merchandise, cart, and shipping projections.
- Styria `retailPrice` uses `retailUnitAmount`, not net `unitAmount`.

### Integration tests

- Country POST validates, sets the cookie, and returns the specified `303` redirect.
- SSR uses the cookie without a Swedish-price hydration flash.
- Checkout draft freezes the selected destination.
- Checkout Session allows exactly the selected country.
- Checkout Session enables Automatic Tax and exclusive shipping.
- Paid normalization for Sweden 25%, Germany 19%, Finland 25.5%, Hungary 27%, and Asia 0%.
- Paid and free shipping tax reconciliation.
- Destination mismatch between draft and Stripe is rejected.
- Reverse-charge or exempt Stripe outcomes remain internally consistent and do not use the storefront estimate as an accounting input.
- Database migration rejects non-empty pre-launch commerce data and stores explicit shipping tax and non-null retail unit amounts for every v2 order.
- Version 1 Sessions are rejected; version 2 is the only supported Checkout contract.

### Browser tests

- Desktop and mobile country control interaction.
- Keyboard-only selection, Escape, focus restoration, and live-region behavior.
- Country choice persists across collection, product, cart, cancel, and return navigation.
- Selecting Sweden, Germany, Hungary, and an Asia destination updates all visible prices.
- One-unit shipping and two-unit free shipping update correctly.
- Unsupported destinations never appear.
- Checkout launch uses the selected country and preserved cart.
- Changing country before checkout changes the projection without replacing cart lines.
- Invalidated old-price cart has a clear recovery action.

### Manual sandbox acceptance

For a one-tee cart, confirm:

| Destination | Merchandise | Shipping | Tax included/added by Stripe | Expected total |
| --- | ---: | ---: | ---: | ---: |
| SE | EUR 20.00 net | EUR 8.00 net | EUR 7.00 | EUR 35.00 |
| DE | EUR 20.00 net | EUR 8.00 net | EUR 5.32 | EUR 33.32 |
| FI | EUR 20.00 net | EUR 8.00 net | EUR 7.14 | EUR 35.14 |
| HU | EUR 20.00 net | EUR 8.00 net | EUR 7.56 | EUR 35.56 |
| Supported Asia destination | EUR 20.00 | EUR 8.00 | EUR 0.00 in current registration setup | EUR 28.00 |

Also confirm that a two-tee order has free shipping, that Stripe's receipt shows the correct tax breakdown, and that Styria receives the paid line's gross customer-facing unit amount.

## Acceptance Criteria

- The header visibly identifies the selected delivery country on every commerce page.
- A customer can change to any source-controlled Styria-supported EU or Asia destination.
- All product and cart prices update coherently from that selection.
- EU display prices use current standard destination VAT; Asia prices exclude EU VAT and show the import-charge warning.
- Stripe uses one EUR 20 exclusive Price per variant and an EUR 8 exclusive paid Shipping Rate.
- Checkout accepts exactly the selected country and uses Automatic Tax.
- Checkout's paid totals reconcile as net merchandise plus net shipping plus tax.
- New orders persist a separate customer-facing retail unit amount.
- Styria receives that retail unit amount on the parcel invoice payload.
- Hard-coded Swedish-reference and fixed EUR 10 shipping copy is removed.
- Pre-launch test order history is intentionally discarded after backup; the launched schema is v2-only.
- Required unit, integration, browser, and sandbox tests pass before checkout is re-enabled.

## Superseded Decisions

This document supersedes only the conflicting pricing and shipping-tax sections of:

- `docs/superpowers/specs/2026-07-15-standalone-svelte-society-merch-store-design.md`
- `docs/superpowers/plans/2026-07-15-merch-store-phase-4-production-launch.md`

Specifically superseded:

- Swedish 25% VAT as the sole storefront reference display.
- EUR 10 tax-inclusive paid shipping for every destination.
- Mixed exclusive-merchandise/inclusive-shipping order invariants.

The destination scope, Styria workflow, Stripe Automatic Tax, OSS operation, free-shipping threshold, policy obligations, admin/MCP model, and all other non-conflicting decisions remain in force.

## References

- European Commission, VAT rules and current standard rates: <https://europa.eu/youreurope/business/finance-and-tax/vat/vat-rules-rates/index_en.htm>
- European Commission, consumer pricing and payments: <https://europa.eu/youreurope/citizens/consumers/shopping/pricing-payments/index_en.htm>
- Stripe, tax behavior for products and prices: <https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior>
- Shopify, dynamic tax-inclusive pricing as an industry pattern: <https://help.shopify.com/en/manual/international/pricing/dynamic-tax-inclusive-pricing>
- Styria API documentation supplied by the operator on 2026-07-22; `retailPrice` is the retail price printed on the invoice sent with the order.
