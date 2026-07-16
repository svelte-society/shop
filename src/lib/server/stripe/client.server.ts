import Stripe from 'stripe';
import type { StripeCheckoutClient } from './checkout.server';
import type { StripeOrderClient } from './paid-checkout';

const STRIPE_TIMEOUT_MS = 10_000;

export type StripeClient = StripeCheckoutClient & StripeOrderClient;

export function createStripeClient(stripeSecretKey: string): StripeClient {
	return new Stripe(stripeSecretKey, {
		maxNetworkRetries: 2,
		timeout: STRIPE_TIMEOUT_MS
	});
}
