import type Stripe from 'stripe';
import {
	CHECKOUT_CONTRACT_VERSION,
	type CreateCheckoutInput,
	type StripeCheckoutGateway
} from './gateway';

type CreatedCheckoutSession = Pick<Stripe.Checkout.Session, 'id' | 'url'>;
type ExpiredCheckoutSession = Pick<Stripe.Checkout.Session, 'id'>;

const CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/;
const STRIPE_CHECKOUT_HOSTNAME = 'checkout.stripe.com';

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

function isCheckoutSessionId(value: unknown): value is string {
	return typeof value === 'string' && CHECKOUT_SESSION_ID_PATTERN.test(value);
}

function isStripeCheckoutUrl(value: unknown): value is string {
	if (typeof value !== 'string' || value.trim() !== value) return false;

	try {
		const url = new URL(value);
		return (
			url.protocol === 'https:' &&
			url.hostname === STRIPE_CHECKOUT_HOSTNAME &&
			url.username === '' &&
			url.password === ''
		);
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

			if (!isCheckoutSessionId(session.id) || !isStripeCheckoutUrl(session.url)) {
				throw new Error('STRIPE_CHECKOUT_SESSION_INVALID');
			}

			return { id: session.id, url: session.url };
		},

		async expireSession(sessionId: string): Promise<void> {
			await client.checkout.sessions.expire(sessionId);
		}
	};
}
