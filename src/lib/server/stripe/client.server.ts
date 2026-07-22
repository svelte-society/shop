import Stripe from 'stripe';
import { isSupportedDestination } from '$lib/domain/destinations';
import type { StripeCheckoutClient } from './checkout.server';
import type { FulfillmentDetails, StripeFulfillmentGateway } from './gateway';
import type { StripeOrderClient } from './paid-checkout';

const STRIPE_TIMEOUT_MS = 10_000;
export const STRIPE_SCHEDULER_TIMEOUT_MS = 5_000;
const CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/;

type UnknownRecord = Record<string, unknown>;

export type StripeFulfillmentClient = {
	checkout: {
		sessions: {
			retrieve(
				checkoutSessionId: string,
				params?: Stripe.Checkout.SessionRetrieveParams,
				options?: Stripe.RequestOptions
			): Promise<unknown>;
		};
	};
};

export type StripeClient = StripeCheckoutClient & StripeOrderClient & StripeFulfillmentClient;

export class StripeFulfillmentError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'StripeFulfillmentError';
	}
}

function fail(code: string): never {
	throw new StripeFulfillmentError(code);
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maxLength &&
		value === value.trim() &&
		!/[\r\n]/.test(value)
	);
}

function optionalString(value: unknown, maxLength: number): string {
	if (value === null || value === undefined || value === '') return '';
	if (!isExactString(value, maxLength)) fail('STRIPE_FULFILLMENT_DETAILS_INVALID');
	return value;
}

function optionalPhone(value: unknown): string {
	if (value === null || value === undefined || value === '') return '';
	if (!isExactString(value, 100)) fail('STRIPE_FULFILLMENT_DETAILS_INVALID');
	return value;
}

function splitName(value: unknown): { firstName: string; lastName: string } {
	if (!isExactString(value, 400)) fail('STRIPE_FULFILLMENT_DETAILS_INVALID');
	const match = /^(\S+)\s+(\S(?:.*\S)?)$/.exec(value);
	if (!match || !isExactString(match[1], 200) || !isExactString(match[2], 200)) {
		fail('STRIPE_FULFILLMENT_DETAILS_INVALID');
	}
	return { firstName: match[1], lastName: match[2] };
}

function normalizeFulfillmentDetails(
	requestedSessionId: string,
	value: unknown
): FulfillmentDetails {
	if (
		!isRecord(value) ||
		value.object !== 'checkout.session' ||
		value.id !== requestedSessionId ||
		!isRecord(value.customer) ||
		value.customer.object !== 'customer' ||
		value.customer.deleted === true ||
		!isExactString(value.customer.email, 500) ||
		!isRecord(value.customer.shipping) ||
		!isRecord(value.customer.shipping.address)
	) {
		fail('STRIPE_FULFILLMENT_DETAILS_INVALID');
	}

	const { firstName, lastName } = splitName(value.customer.shipping.name);
	const customerPhone = optionalPhone(value.customer.phone);
	const shippingPhone = optionalPhone(value.customer.shipping.phone);
	if (customerPhone !== '' && shippingPhone !== '' && shippingPhone !== customerPhone) {
		fail('STRIPE_FULFILLMENT_DETAILS_INVALID');
	}
	const phone = customerPhone || shippingPhone;
	if (phone === '') fail('STRIPE_FULFILLMENT_DETAILS_INVALID');
	const address = value.customer.shipping.address;
	if (
		!isExactString(address.line1, 500) ||
		!isExactString(address.city, 200) ||
		!isExactString(address.postal_code, 100) ||
		!isExactString(address.country, 2)
	) {
		fail('STRIPE_FULFILLMENT_DETAILS_INVALID');
	}
	const line2 = optionalString(address.line2, 500);
	const state = optionalString(address.state, 200);
	if (address.country === 'US' && state === '') {
		fail('STRIPE_FULFILLMENT_DETAILS_INVALID');
	}
	if (!isSupportedDestination(address.country)) {
		fail('STRIPE_FULFILLMENT_DESTINATION_UNSUPPORTED');
	}

	const customerDetails = value.customer_details;
	if (!isRecord(customerDetails)) fail('STRIPE_FULFILLMENT_DETAILS_INVALID');
	const company = optionalString(value.customer.business_name, 200);

	return {
		recipient: {
			firstName,
			lastName,
			company,
			phone
		},
		address: {
			line1: address.line1,
			line2,
			city: address.city,
			state,
			postalCode: address.postal_code,
			countryCode: address.country
		},
		email: value.customer.email
	};
}

export function createStripeFulfillmentGateway(
	client: StripeFulfillmentClient
): StripeFulfillmentGateway {
	return {
		async retrieveFulfillmentDetails(
			checkoutSessionId: string,
			signal?: AbortSignal
		): Promise<FulfillmentDetails> {
			if (
				!isExactString(checkoutSessionId, 200) ||
				!CHECKOUT_SESSION_ID_PATTERN.test(checkoutSessionId)
			) {
				fail('STRIPE_FULFILLMENT_SESSION_INVALID');
			}
			if (signal?.aborted) fail('STRIPE_FULFILLMENT_RETRIEVAL_FAILED');
			let session: unknown;
			try {
				session = await client.checkout.sessions.retrieve(
					checkoutSessionId,
					{ expand: ['customer'] },
					signal ? { maxNetworkRetries: 0, timeout: STRIPE_SCHEDULER_TIMEOUT_MS } : undefined
				);
			} catch {
				fail('STRIPE_FULFILLMENT_RETRIEVAL_FAILED');
			}
			if (signal?.aborted) fail('STRIPE_FULFILLMENT_RETRIEVAL_FAILED');
			return normalizeFulfillmentDetails(checkoutSessionId, session);
		}
	};
}

export function createStripeClient(stripeSecretKey: string): StripeClient {
	return new Stripe(stripeSecretKey, {
		maxNetworkRetries: 2,
		timeout: STRIPE_TIMEOUT_MS
	});
}
