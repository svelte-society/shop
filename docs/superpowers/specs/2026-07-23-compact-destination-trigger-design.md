# Compact Destination Trigger Design

**Date:** 2026-07-23  
**Status:** Approved

## Scope

Make the delivery-country control materially narrower in the sticky header and remove the redundant Tax card from the homepage. Do not change country selection, destination persistence, VAT calculations, displayed prices, cart tax amounts, Stripe checkout, policy copy, or the country-picker dialog.

## Header trigger

- Replace the visible “Deliver to: {country}” text with the selected country’s flag and a small downward chevron.
- Derive the flag locally from the existing two-letter ISO country code. Add no image service, asset set, or runtime dependency.
- Keep the flag and chevron hidden from assistive technology. Preserve the accessible button name “Choose delivery country, currently {country}”.
- Provide the visible button with the tooltip “Deliver to {country}”.
- Keep the control at least 44px square with the existing keyboard focus, hover, and dialog behavior.
- Keep the no-JavaScript country form unchanged.

## Homepage

- Remove the homepage Tax highlight card and its destination-specific disclosure.
- Keep Shipping, Regions, and Support.
- Retain tax disclosures where they are needed for purchase decisions, including product pricing, the cart breakdown, checkout, and policy pages.

## Verification

- Component tests verify the flag-and-chevron trigger, accessible name, tooltip, and 44px target.
- Homepage tests verify the Tax card is absent while the remaining highlights stay visible.
- Existing destination selection, focus restoration, responsive dialog, pricing, cart, and checkout tests continue to pass.
- Test at 320px to confirm the compact trigger does not cause horizontal overflow.
