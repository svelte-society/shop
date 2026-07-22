# Mobile Country Picker Design

**Date:** 2026-07-22  
**Status:** Approved

## Scope

Improve the existing destination picker without changing its pricing or persistence contract, and remove the external “Svelte Society” link from the primary header navigation.

## Picker layout

- The picker remains a modal dialog on desktop and a full-width bottom sheet on mobile.
- The dialog is capped by the available viewport height and never relies on the page behind it for scrolling.
- Its heading, country search, error message, and Cancel/Update actions remain visible.
- Only the grouped country list scrolls. The action buttons must not move as the list grows or the search result count changes.
- Mobile spacing respects safe-area insets, controls remain at least 44px high, and the sheet uses the full available width.

## Initial destination

Keep the existing server-side resolution order:

1. A valid country previously selected by the user.
2. A supported `CF-IPCountry` request header supplied by Cloudflare.
3. Sweden.

Cloudflare inference is only a default. It is not persisted automatically and never overrides an explicit user choice. Unsupported countries and Cloudflare’s special unknown/Tor values fall back to Sweden.

## Header

Primary navigation contains Collection, the destination picker, and Cart. The external “Svelte Society” text link is removed; the branded shop home link remains.

## Verification

- Browser component tests verify the dialog shell, independent scroll region, persistent action region, touch target sizes, and header navigation.
- Existing destination resolver tests continue to verify cookie precedence, Cloudflare inference, and fallback behavior.
- Svelte diagnostics and project checks must pass.
