import * as v from 'valibot';
import { Buffer } from 'node:buffer';
import { parseWithdrawalDataKey } from '$lib/server/withdrawals/crypto.server';
import { parsePublicConfig, type PublicConfig } from './public';

export type PrivateConfig = PublicConfig & {
	stripeSecretKey: string;
	stripeWebhookSecret: string;
	stripePaidShippingRateId: string;
	stripeFreeShippingRateId: string;
};

export type SellerPolicyConfig = {
	sellerLegalName: string;
	sellerRegistrationNumber: string;
	sellerVatNumber: string;
	sellerAddressLine1: string;
	sellerPostalCode: string;
	sellerCity: string;
	sellerCountry: string;
	sellerEmail: string;
	deliveryEstimateEu: string;
	deliveryEstimateAsia: string;
	policyEffectiveDate: string;
};

export type WithdrawalSellerIdentity = {
	legalName: string;
	registrationNumber: string;
	addressLine1: string;
	postalCode: string;
	city: string;
	country: string;
	email: string;
};

export type WithdrawalConfig = {
	dataKey: Buffer;
	keyVersion: 1;
	productionOrigin: URL;
	supportEmail: string;
	seller: WithdrawalSellerIdentity;
};

const requiredValueSchema = v.pipe(
	v.string(),
	v.check((value) => value.trim().length > 0 && value === value.trim() && !/[\r\n]/u.test(value))
);

const policyDateSchema = v.pipe(
	requiredValueSchema,
	v.regex(/^\d{4}-\d{2}-\d{2}$/u),
	v.check((value) => {
		const parsed = new Date(`${value}T00:00:00.000Z`);
		return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
	})
);

const sellerPolicyEnvSchema = v.object({
	SELLER_LEGAL_NAME: requiredValueSchema,
	SELLER_REGISTRATION_NUMBER: requiredValueSchema,
	SELLER_VAT_NUMBER: requiredValueSchema,
	SELLER_ADDRESS_LINE1: requiredValueSchema,
	SELLER_POSTAL_CODE: requiredValueSchema,
	SELLER_CITY: requiredValueSchema,
	SELLER_COUNTRY: requiredValueSchema,
	SELLER_EMAIL: v.pipe(requiredValueSchema, v.email()),
	DELIVERY_ESTIMATE_EU: requiredValueSchema,
	DELIVERY_ESTIMATE_ASIA: requiredValueSchema,
	POLICY_EFFECTIVE_DATE: policyDateSchema
});

const stripeEnvSchema = v.object({
	STRIPE_SECRET_KEY: requiredValueSchema,
	STRIPE_WEBHOOK_SECRET: requiredValueSchema,
	STRIPE_PAID_SHIPPING_RATE_ID: requiredValueSchema,
	STRIPE_FREE_SHIPPING_RATE_ID: requiredValueSchema
});

const withdrawalPublicEnvSchema = v.object({
	PRODUCTION_ORIGIN: v.pipe(
		v.string(),
		v.url(),
		v.transform((value) => new URL(value)),
		v.check((value) => value.protocol === 'https:')
	),
	SUPPORT_EMAIL: v.pipe(v.string(), v.email())
});

export function parseSellerPolicyConfig(
	env: Record<string, string | undefined>
): SellerPolicyConfig {
	const result = v.safeParse(sellerPolicyEnvSchema, env);
	if (!result.success) throw new Error('CONFIG_POLICY_INVALID');

	return {
		sellerLegalName: result.output.SELLER_LEGAL_NAME,
		sellerRegistrationNumber: result.output.SELLER_REGISTRATION_NUMBER,
		sellerVatNumber: result.output.SELLER_VAT_NUMBER,
		sellerAddressLine1: result.output.SELLER_ADDRESS_LINE1,
		sellerPostalCode: result.output.SELLER_POSTAL_CODE,
		sellerCity: result.output.SELLER_CITY,
		sellerCountry: result.output.SELLER_COUNTRY,
		sellerEmail: result.output.SELLER_EMAIL,
		deliveryEstimateEu: result.output.DELIVERY_ESTIMATE_EU,
		deliveryEstimateAsia: result.output.DELIVERY_ESTIMATE_ASIA,
		policyEffectiveDate: result.output.POLICY_EFFECTIVE_DATE
	};
}

export function parseWithdrawalConfig(env: Record<string, string | undefined>): WithdrawalConfig {
	try {
		const publicResult = v.safeParse(withdrawalPublicEnvSchema, env);
		if (!publicResult.success) throw new Error('CONFIG_WITHDRAWAL_INVALID');
		const policyConfig = parseSellerPolicyConfig(env);
		return {
			dataKey: parseWithdrawalDataKey(env.WITHDRAWAL_DATA_KEY),
			keyVersion: 1,
			productionOrigin: publicResult.output.PRODUCTION_ORIGIN,
			supportEmail: publicResult.output.SUPPORT_EMAIL,
			seller: {
				legalName: policyConfig.sellerLegalName,
				registrationNumber: policyConfig.sellerRegistrationNumber,
				addressLine1: policyConfig.sellerAddressLine1,
				postalCode: policyConfig.sellerPostalCode,
				city: policyConfig.sellerCity,
				country: policyConfig.sellerCountry,
				email: policyConfig.sellerEmail
			}
		};
	} catch {
		throw new Error('CONFIG_WITHDRAWAL_INVALID');
	}
}

export function parsePrivateConfig(env: Record<string, string | undefined>): PrivateConfig {
	let publicConfig: PublicConfig;

	try {
		publicConfig = parsePublicConfig(env);
	} catch {
		throw new Error('CONFIG_PRIVATE_INVALID');
	}

	const result = v.safeParse(stripeEnvSchema, env);

	if (!result.success) {
		throw new Error('CONFIG_PRIVATE_INVALID');
	}
	if (env.NODE_ENV === 'production' && publicConfig.checkoutEnabled) {
		if (publicConfig.supportEmail !== 'merch@sveltesociety.dev') {
			throw new Error('CONFIG_PRIVATE_INVALID');
		}
		try {
			parseWithdrawalConfig(env);
		} catch {
			throw new Error('CONFIG_PRIVATE_INVALID');
		}
	}

	return {
		...publicConfig,
		stripeSecretKey: result.output.STRIPE_SECRET_KEY,
		stripeWebhookSecret: result.output.STRIPE_WEBHOOK_SECRET,
		stripePaidShippingRateId: result.output.STRIPE_PAID_SHIPPING_RATE_ID,
		stripeFreeShippingRateId: result.output.STRIPE_FREE_SHIPPING_RATE_ID
	};
}
