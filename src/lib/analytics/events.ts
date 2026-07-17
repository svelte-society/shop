export type FunnelEvent =
	| 'product_viewed'
	| 'variant_selected'
	| 'added_to_cart'
	| 'cart_viewed'
	| 'checkout_started'
	| 'checkout_returned_successfully'
	| 'checkout_cancelled';

const funnelEvents = new Set<FunnelEvent>([
	'product_viewed',
	'variant_selected',
	'added_to_cart',
	'cart_viewed',
	'checkout_started',
	'checkout_returned_successfully',
	'checkout_cancelled'
]);

declare global {
	interface Window {
		umami?: {
			track(event: FunnelEvent): void;
		};
	}
}

export function track(event: FunnelEvent): void {
	if (!funnelEvents.has(event) || typeof window === 'undefined') return;

	try {
		window.umami?.track(event);
	} catch {
		// Analytics must never interfere with the storefront action being measured.
	}
}
