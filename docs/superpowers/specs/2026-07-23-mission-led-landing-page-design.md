# Mission-led landing page design

**Date:** 2026-07-23

**Status:** Approved design, pending written-spec review

## Goal

Present the Society Shop as a direct way to support Svelte Society's continued work across the
Svelte ecosystem while keeping shopping as the page's single primary action.

The support claim is intentionally general. The shop will not claim that all revenue or all profit
is donated or assigned to a particular programme.

## Audience and task

The primary audience is Svelte developers, maintainers, teachers, meetup attendees, and other
people who already identify with the community. A visitor should understand why the shop exists,
then be able to move directly into the product collection.

## Approved landing-page hierarchy

The page tells one story in this order:

1. Buying official merchandise supports Svelte Society.
2. The support helps sustain community events, shared resources, open-source projects, and
   connections between Svelte developers.
3. The visitor can choose a product from the collection.
4. Practical shipping, destination, and support information appears after the products.

The collection and ordering-information sections retain their current behaviour and position.

## Global announcement strip

The global strip reads:

> Every purchase supports Svelte Society.

Because the strip is no longer shipping-specific, `ShippingStrip.svelte` becomes
`AnnouncementStrip.svelte`, and the root layout imports the renamed component.

The free-shipping threshold remains visible where it helps a purchasing decision: product pages,
the cart, and the homepage ordering-information section. It is not repeated in the global strip or
hero.

## Hero

The hero keeps one primary link and uses the following approved copy:

- Eyebrow: **Svelte Society Shop**
- Heading: **Wear Svelte. Support the community.**
- Body: **Every purchase supports Svelte Society's continued work across the
  ecosystem—organizing community events, sharing useful resources, and helping Svelte developers
  connect.**
- Primary link: **Shop the collection**

The existing “2 items ship free” hero card is removed because it duplicates shipping information
elsewhere and competes with the mission-led message.

Its place is taken by a supporting editorial panel:

**Your purchase supports**

- Community events
- Shared resources
- Open-source projects
- Developer connections

The panel is supporting information, not a second call to action.

## Metadata

The page title remains **Svelte Society Shop — Official Community Merch**.

The meta description is revised to mention that purchases support Svelte Society while retaining
the most useful commerce detail. It must remain concise and must not make a profit-allocation or
donation claim.

## Components and data

This is a presentation-only change:

- update the static landing-page copy and hero structure;
- rename the global strip component and update its static message;
- keep the existing product catalog data, dynamic destination pricing, and shipping projection;
- make no changes to server loaders, Stripe, checkout, cart state, or fulfillment.

Catalog loading and catalog-unavailable behaviour remain unchanged. The mission panel renders
independently of catalog availability.

## Responsive and accessible behaviour

- Keep one `h1` and the existing semantic landing-page regions.
- Mark the support items up as a real list with a visible heading.
- Preserve the single primary hero action.
- Keep the announcement readable without wrapping awkwardly at narrow mobile widths.
- Preserve the existing reduced-motion and focus behaviour.
- Adjust the current two-column hero responsively so the support panel follows the hero copy on
  narrow screens.

## Testing

Component tests must prove that:

- the global announcement says “Every purchase supports Svelte Society.”;
- the previous global free-shipping sentence is absent;
- the landing page renders the approved heading, body, primary link, and four support items;
- the removed hero shipping promotion is absent;
- the lower ordering-information section still presents the applicable shipping threshold;
- the page retains one “Shop the collection” link.

After implementation, run formatting, Svelte diagnostics, linting, the complete unit-test suite,
and a production build. Rebuild the production-style local fixture and inspect the desktop and
mobile landing page before deployment.

## Non-goals

- No donation, percentage-of-profit, or earmarked-funds claim.
- No new analytics or conversion experiment.
- No new product, pricing, shipping, tax, cart, checkout, or fulfillment behaviour.
- No deployment until the local preview has been reviewed.
