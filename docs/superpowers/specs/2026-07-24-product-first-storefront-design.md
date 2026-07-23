# Product-first storefront design

**Date:** 2026-07-24  
**Status:** Approved for implementation planning

## Goal

Let visitors see and buy products immediately. Product discovery and purchase actions must appear above the fold; Svelte Society mission copy becomes supporting content below the collection.

## User feedback

The current mission hero creates too much distance between arrival and purchase. Product cards also force an unnecessary product-page visit before adding an item to the cart.

## Homepage hierarchy

Keep the existing announcement strip and sticky site header. Replace the large opening hero with the collection as the first main-content section.

The first section contains:

- eyebrow: `Svelte Society Shop`;
- H1: `Shop the collection.`;
- product cards immediately after the heading.

Product thumbnails must be visible above the fold at supported desktop and mobile viewports. The collection remains the page's primary visual and interaction target.

Move the existing mission content below the complete product collection:

- `Wear Svelte. Support the community.`;
- the explanation of how purchases support Svelte Society;
- `Your purchase supports` and its four-item list.

Keep shipping, regions, and support information after the mission section.

## Product cards

Each card keeps its product image, category, name, and destination-specific price. The image, name, and price continue to link to the product detail page.

Add an `Add to cart` button inside the visual thumbnail area. The button must be a semantic sibling of the product link, not a button nested inside an anchor. CSS visually overlays both controls inside the same thumbnail frame.

### Multi-variant apparel

Pressing `Add to cart` reveals compact size choices inside the card. Focus moves to the first available size. Selecting a size immediately adds that exact Stripe price ID to the cart; no second confirmation is required.

The disclosure button exposes its state with `aria-expanded`. Size choices are native buttons inside a labelled group, each with at least a 44px touch target. Escape and a dedicated close button both collapse the choices without changing the cart.

After a successful selection, collapse the choices and announce the result in the card, for example: `Community Tee, M added to cart.`

### Single-variant products

Pressing `Add to cart` adds the sole variant immediately. No redundant option chooser appears.

## Component boundaries

`src/routes/+page.svelte` owns homepage section order and supporting mission content.

`src/lib/components/ProductCard.svelte` owns card composition, product-detail navigation, and placement of the quick-add control. It must keep product navigation and cart actions as separate interactive elements.

Create `src/lib/components/ProductQuickAdd.svelte` to own:

- closed, size-selection, success, and error states;
- variant-to-price-ID selection;
- focus movement when size choices open;
- cart insertion and accessible status messages;
- cart-limit recovery messages.

The component accepts the priced product and an optional cart controller for deterministic tests. Production uses the existing shared cart controller.

## Data flow

Products are already priced for the selected destination before reaching the card. Quick-add uses the existing variant label and Stripe price ID; it does not calculate prices or create new checkout data.

Successful addition calls `cart.add(priceId)`. Existing cart persistence, cart-count reactivity, quantity limits, and `added_to_cart` analytics remain authoritative.

No server, Stripe catalog, pricing, tax, checkout, or database changes are in scope.

## Error handling

Cart capacity failures appear next to the quick-add control and explain the recovery action:

- maximum total units: remove an item before adding another;
- maximum distinct options: remove one option before adding another.

Unexpected errors continue to surface rather than being converted into false success. Closing the chooser clears transient validation without changing the cart.

## Responsive behavior

Preserve the existing one-column mobile and multi-column desktop collection layouts. Quick-add controls stay within each card's thumbnail and must not create horizontal overflow.

The product collection must remain above the mission section at 320px, 768px, 1024px, and 1440px. Product thumbnails must be visible in the initial viewport after the global announcement and header.

## Accessibility

- Preserve meaningful product-link names and visible focus styles.
- Use real buttons for cart and size actions.
- Maintain at least 44px targets for primary touch actions.
- Move focus into the size chooser when it opens.
- Announce success through a polite live region and validation failures through an alert.
- Support keyboard dismissal without losing page position.
- Avoid nested interactive elements and focus traps.

## Testing

Use test-driven implementation.

Component coverage must prove:

- multi-variant `Add to cart` reveals sizes instead of navigating;
- focus moves to the first size;
- selecting a size adds the correct price ID and announces success;
- single-variant products add immediately;
- product links still navigate and retain analytics;
- cart-limit errors remain local and actionable;
- controls have correct expanded, status, and alert semantics.

End-to-end coverage must prove:

- product thumbnails appear before mission content;
- a visitor can add apparel from the homepage without visiting its product page;
- a visitor can add a single-variant product from the homepage;
- cart persistence and header count update correctly;
- the layout has no horizontal overflow at all configured browser viewports;
- existing product-page purchase and checkout flows remain functional.

## Out of scope

- Removing product detail pages.
- Changing product metadata, prices, tax, shipping, or country availability.
- Adding a modal or bottom sheet.
- Adding default apparel sizes.
- Reworking the cart or checkout.
