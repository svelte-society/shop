import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { track, type FunnelEvent } from './events';

const funnelEvents = [
	'product_viewed',
	'variant_selected',
	'added_to_cart',
	'cart_viewed',
	'checkout_started',
	'checkout_returned_successfully',
	'checkout_cancelled'
] as const satisfies readonly FunnelEvent[];

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('privacy-safe funnel analytics', () => {
	it('allows exactly the seven fixed funnel event names through the public type', () => {
		expectTypeOf<(typeof funnelEvents)[number]>().toEqualTypeOf<FunnelEvent>();
		expectTypeOf(track).parameters.toEqualTypeOf<[event: FunnelEvent]>();
		expect(funnelEvents).toHaveLength(7);
	});

	it.each(funnelEvents)('forwards only the fixed event name %s', (event) => {
		const umamiTrack = vi.fn();
		vi.stubGlobal('window', { umami: { track: umamiTrack } });

		track(event);

		expect(umamiTrack.mock.calls).toEqual([[event]]);
	});

	it('does not forward unknown names or any supplied event properties', () => {
		const umamiTrack = vi.fn();
		vi.stubGlobal('window', { umami: { track: umamiTrack } });

		(track as unknown as (...args: unknown[]) => void)('added_to_cart', {
			orderId: 'must-not-send'
		});
		track('not_a_funnel_event' as FunnelEvent);

		expect(umamiTrack.mock.calls).toEqual([['added_to_cart']]);
	});

	it('is a non-blocking no-op without a browser tracker or when the tracker throws', () => {
		expect(() => track('cart_viewed')).not.toThrow();

		vi.stubGlobal('window', {
			umami: {
				track() {
					throw new Error('TRACKER_FAILED');
				}
			}
		});

		expect(() => track('checkout_started')).not.toThrow();
	});
});
