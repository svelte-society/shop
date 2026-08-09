# Fixed Gross Shipping Design

**Status:** Approved business change on 2026-08-09. This document supersedes the paid-shipping tax behavior in the 2026-07-22 dynamic destination pricing design. Merchandise pricing remains unchanged.

## Customer contract

- A one-item order costs exactly **EUR 10.00 shipping** in every supported destination.
- Shipping is free for two or more total items.
- For EU destinations the EUR 10.00 includes destination VAT; the seller absorbs the difference in net proceeds.
- For supported destinations outside the EU, the EUR 10.00 excludes EU VAT and recipient import charges may still apply.

## Stripe contract

- Merchandise remains positive one-time EUR Prices with `tax_behavior=exclusive`.
- Paid shipping is a native fixed EUR 10.00 Shipping Rate with `tax_behavior=inclusive` and Stripe's Shipping tax code.
- Free shipping remains a native fixed EUR 0.00 Shipping Rate with `tax_behavior=exclusive` and the same tax code.
- Stripe Automatic Tax and the complete delivery address remain authoritative for the final tax breakdown.

The storefront backs estimated included shipping VAT out of the fixed gross amount. It never adds VAT on top of EUR 10.00. Checkout uses only the validated configured Shipping Rate ID.

## Checkout reconciliation

Checkout contract version 4 freezes the selected Shipping Rate ID and gross amount. Provider reconciliation requires paid shipping to be inclusive and EUR 10.00, requires free shipping to be exclusive and zero, and proves:

- merchandise line totals equal exclusive subtotal plus merchandise tax;
- shipping gross equals the selected rate's fixed amount and contains `shippingTax`;
- total tax equals merchandise tax plus shipping tax;
- Session total equals merchandise subtotal less discounts plus merchandise tax plus shipping gross.

Migration `0008_inclusive_shipping.sql` renames the checkout draft snapshot column from `shipping_net_amount` to `shipping_gross_amount`. Version 3 drafts cannot satisfy the version 4 comparison and therefore fail closed.

## Deployment

Create or select the matching EUR 10.00 inclusive paid Shipping Rate in Stripe, then set `STRIPE_PAID_SHIPPING_RATE_ID` to its ID before enabling checkout. Existing exclusive paid rates are rejected. The EUR 0 exclusive free rate can be retained.
