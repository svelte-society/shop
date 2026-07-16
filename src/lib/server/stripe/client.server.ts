import Stripe from 'stripe';
import type { StripeCheckoutClient } from './checkout.server';

const STRIPE_TIMEOUT_MS = 10_000;

export function createStripeClient(stripeSecretKey: string): StripeCheckoutClient {
	return new Stripe(stripeSecretKey, {
		maxNetworkRetries: 2,
		timeout: STRIPE_TIMEOUT_MS
	});
}
