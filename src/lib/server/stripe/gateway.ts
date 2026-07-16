import type { PaymentStatus } from '$lib/domain/orders';

export const CHECKOUT_CONTRACT_VERSION = 1;

export type CreateCheckoutInput = {
	draftId: string;
	lines: Array<{ priceId: string; quantity: number }>;
	shippingRateId: string;
	allowedCountries: readonly string[];
	successUrl: string;
	cancelUrl: string;
};

export interface StripeCheckoutGateway {
	createSession(input: CreateCheckoutInput): Promise<{ id: string; url: string }>;
	expireSession(sessionId: string): Promise<void>;
}

export type PaidCheckoutSnapshot = {
	checkoutSessionId: string;
	paymentIntentId: string;
	customerId: string;
	draftId: string;
	currency: 'eur';
	paymentStatus: 'paid';
	destinationCountry: string;
	amounts: {
		subtotal: number;
		discount: number;
		shipping: number;
		tax: number;
		total: number;
	};
	lines: Array<{ priceId: string; quantity: number; unitAmount: number }>;
};

export interface StripeOrderGateway {
	retrievePaidCheckout(sessionId: string): Promise<PaidCheckoutSnapshot>;
	retrieveRefundStatus(paymentIntentId: string): Promise<PaymentStatus>;
}
