import type Stripe from 'stripe';
import {
	CHECKOUT_CONTRACT_VERSION,
	type CreateCheckoutInput,
	type StripeCheckoutGateway
} from './gateway';

type CreatedCheckoutSession = Pick<Stripe.Checkout.Session, 'id' | 'url'>;
type ExpiredCheckoutSession = Pick<Stripe.Checkout.Session, 'id'>;

export type StripeCheckoutClient = {
	checkout: {
		sessions: {
			create(
				params: Stripe.Checkout.SessionCreateParams,
				options?: Stripe.RequestOptions
			): Promise<CreatedCheckoutSession>;
			expire(sessionId: string): Promise<ExpiredCheckoutSession>;
		};
	};
};

function checkoutMetadata(draftId: string): Record<string, string> {
	return {
		product_type: 'merch',
		checkout_contract_version: String(CHECKOUT_CONTRACT_VERSION),
		checkout_draft_id: draftId
	};
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== 'string') return false;

	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

export function createStripeCheckoutGateway(client: StripeCheckoutClient): StripeCheckoutGateway {
	return {
		async createSession(input: CreateCheckoutInput) {
			const metadata = checkoutMetadata(input.draftId);
			const session = await client.checkout.sessions.create(
				{
					mode: 'payment',
					line_items: input.lines.map((line) => ({
						price: line.priceId,
						quantity: line.quantity
					})),
					customer_creation: 'always',
					automatic_tax: { enabled: true },
					tax_id_collection: { enabled: true },
					phone_number_collection: { enabled: true },
					invoice_creation: { enabled: true },
					consent_collection: { terms_of_service: 'required' },
					locale: 'auto',
					shipping_options: [{ shipping_rate: input.shippingRateId }],
					shipping_address_collection: {
						allowed_countries: [
							...input.allowedCountries
						] as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[]
					},
					success_url: input.successUrl,
					cancel_url: input.cancelUrl,
					client_reference_id: input.draftId,
					metadata,
					payment_intent_data: {
						description: 'Svelte Society merch',
						metadata: { ...metadata }
					}
				},
				{ idempotencyKey: `checkout-draft:${input.draftId}` }
			);

			if (typeof session.id !== 'string' || session.id.length === 0 || !isHttpsUrl(session.url)) {
				throw new Error('STRIPE_CHECKOUT_SESSION_INVALID');
			}

			return { id: session.id, url: session.url };
		},

		async expireSession(sessionId: string): Promise<void> {
			await client.checkout.sessions.expire(sessionId);
		}
	};
}
