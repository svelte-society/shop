import { describe, expect, it } from 'vitest';
import { parsePrivateConfig } from './private.server';
import { parsePublicConfig } from './public';

const validPublicEnv = {
	STOREFRONT_ENABLED: 'true',
	CHECKOUT_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev'
};

const validPolicyEnv = {
	SELLER_LEGAL_NAME: 'Svelte School AB',
	SELLER_REGISTRATION_NUMBER: 'reviewed-registration',
	SELLER_VAT_NUMBER: 'reviewed-vat-number',
	SELLER_ADDRESS_LINE1: 'Reviewed street 1',
	SELLER_POSTAL_CODE: '123 45',
	SELLER_CITY: 'Reviewed city',
	SELLER_COUNTRY: 'Sweden',
	SELLER_EMAIL: 'merchant@example.com',
	DELIVERY_ESTIMATE_EU: 'Reviewed EU estimate',
	DELIVERY_ESTIMATE_US: 'Reviewed US estimate',
	POLICY_EFFECTIVE_DATE: '2026-07-17'
};

const validPrivateEnv = {
	...validPublicEnv,
	...validPolicyEnv,
	STRIPE_SECRET_KEY: 'sk_test_private_value',
	STRIPE_WEBHOOK_SECRET: 'whsec_test_private_value',
	STRIPE_PAID_SHIPPING_RATE_ID: 'shr_paid',
	STRIPE_FREE_SHIPPING_RATE_ID: 'shr_free'
};

describe('parsePublicConfig', () => {
	it('parses explicit feature booleans without treating false as truthy', () => {
		const config = parsePublicConfig(validPublicEnv);

		expect(config).toEqual({
			storefrontEnabled: true,
			checkoutEnabled: false,
			productionOrigin: new URL('https://shop.sveltesociety.dev'),
			supportEmail: 'merch@sveltesociety.dev'
		});
	});

	it.each(['TRUE', 'False', '1', 'yes', ''])('rejects the non-literal boolean %j', (value) => {
		expect(() => parsePublicConfig({ ...validPublicEnv, STOREFRONT_ENABLED: value })).toThrowError(
			'CONFIG_PUBLIC_INVALID'
		);
	});

	it.each(['http://shop.sveltesociety.dev', 'not-a-url'])(
		'rejects a non-HTTPS production origin %j',
		(productionOrigin) => {
			expect(() =>
				parsePublicConfig({ ...validPublicEnv, PRODUCTION_ORIGIN: productionOrigin })
			).toThrowError('CONFIG_PUBLIC_INVALID');
		}
	);

	it('rejects an invalid support email', () => {
		expect(() =>
			parsePublicConfig({ ...validPublicEnv, SUPPORT_EMAIL: 'not-an-email' })
		).toThrowError('CONFIG_PUBLIC_INVALID');
	});
});

describe('parsePrivateConfig', () => {
	it.each([
		'SELLER_LEGAL_NAME',
		'SELLER_REGISTRATION_NUMBER',
		'SELLER_VAT_NUMBER',
		'SELLER_ADDRESS_LINE1',
		'SELLER_POSTAL_CODE',
		'SELLER_CITY',
		'SELLER_COUNTRY',
		'SELLER_EMAIL',
		'DELIVERY_ESTIMATE_EU',
		'DELIVERY_ESTIMATE_US',
		'POLICY_EFFECTIVE_DATE'
	])('rejects checkout-enabled production without complete %s policy configuration', (name) => {
		expect(() =>
			parsePrivateConfig({
				...validPrivateEnv,
				NODE_ENV: 'production',
				CHECKOUT_ENABLED: 'true',
				[name]: undefined
			})
		).toThrowError('CONFIG_PRIVATE_INVALID');
	});

	it('requires the reviewed support address before production checkout can start', () => {
		expect(() =>
			parsePrivateConfig({
				...validPrivateEnv,
				NODE_ENV: 'production',
				CHECKOUT_ENABLED: 'true',
				SUPPORT_EMAIL: 'support@example.com'
			})
		).toThrowError('CONFIG_PRIVATE_INVALID');
	});

	it('accepts complete reviewed seller and policy fields for production checkout', () => {
		expect(() =>
			parsePrivateConfig({
				...validPrivateEnv,
				NODE_ENV: 'production',
				CHECKOUT_ENABLED: 'true'
			})
		).not.toThrow();
	});

	it('parses required Stripe configuration', () => {
		expect(parsePrivateConfig(validPrivateEnv)).toEqual({
			storefrontEnabled: true,
			checkoutEnabled: false,
			productionOrigin: new URL('https://shop.sveltesociety.dev'),
			supportEmail: 'merch@sveltesociety.dev',
			stripeSecretKey: 'sk_test_private_value',
			stripeWebhookSecret: 'whsec_test_private_value',
			stripePaidShippingRateId: 'shr_paid',
			stripeFreeShippingRateId: 'shr_free'
		});
	});

	it.each([
		'STRIPE_SECRET_KEY',
		'STRIPE_WEBHOOK_SECRET',
		'STRIPE_PAID_SHIPPING_RATE_ID',
		'STRIPE_FREE_SHIPPING_RATE_ID'
	])('rejects a missing %s', (name) => {
		expect(() => parsePrivateConfig({ ...validPrivateEnv, [name]: undefined })).toThrowError(
			'CONFIG_PRIVATE_INVALID'
		);
	});

	it.each([
		'STRIPE_SECRET_KEY',
		'STRIPE_WEBHOOK_SECRET',
		'STRIPE_PAID_SHIPPING_RATE_ID',
		'STRIPE_FREE_SHIPPING_RATE_ID'
	])('rejects an empty %s', (name) => {
		expect(() => parsePrivateConfig({ ...validPrivateEnv, [name]: '' })).toThrowError(
			'CONFIG_PRIVATE_INVALID'
		);
	});

	it('does not include secret values in configuration errors', () => {
		const secret = 'sk_live_must_not_leak';

		try {
			parsePrivateConfig({
				...validPrivateEnv,
				STRIPE_SECRET_KEY: secret,
				STRIPE_PAID_SHIPPING_RATE_ID: ''
			});
			expect.unreachable('Expected invalid private configuration to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe('CONFIG_PRIVATE_INVALID');
			expect((error as Error).message).not.toContain(secret);
		}
	});
});
