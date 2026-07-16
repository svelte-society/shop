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
