import * as v from 'valibot';
import { Buffer } from 'node:buffer';
import { parseWithdrawalDataKey } from '$lib/server/withdrawals/crypto.server';
import { parsePublicConfig, type PublicConfig } from './public';
import { SHOP_CONFIG } from './shop';

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
	)
});

export function parseSellerPolicyConfig(): SellerPolicyConfig {
	return {
		sellerLegalName: SHOP_CONFIG.sellerPolicy.legalName,
		sellerRegistrationNumber: SHOP_CONFIG.sellerPolicy.registrationNumber,
		sellerVatNumber: SHOP_CONFIG.sellerPolicy.vatNumber,
		sellerAddressLine1: SHOP_CONFIG.sellerPolicy.addressLine1,
		sellerPostalCode: SHOP_CONFIG.sellerPolicy.postalCode,
		sellerCity: SHOP_CONFIG.sellerPolicy.city,
		sellerCountry: SHOP_CONFIG.sellerPolicy.country,
		sellerEmail: SHOP_CONFIG.contact.sellerEmail,
		deliveryEstimateEu: SHOP_CONFIG.sellerPolicy.deliveryEstimateEu,
		deliveryEstimateAsia: SHOP_CONFIG.sellerPolicy.deliveryEstimateAsia,
		policyEffectiveDate: SHOP_CONFIG.sellerPolicy.effectiveDate
	};
}

export function parseWithdrawalConfig(env: Record<string, string | undefined>): WithdrawalConfig {
	try {
		const publicResult = v.safeParse(withdrawalPublicEnvSchema, env);
		if (!publicResult.success) throw new Error('CONFIG_WITHDRAWAL_INVALID');
		const policyConfig = parseSellerPolicyConfig();
		return {
			dataKey: parseWithdrawalDataKey(env.WITHDRAWAL_DATA_KEY),
			keyVersion: 1,
			productionOrigin: publicResult.output.PRODUCTION_ORIGIN,
			supportEmail: SHOP_CONFIG.contact.supportEmail,
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
