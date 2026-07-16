import { describe, expect, it } from 'vitest';
import { parsePrivateConfig } from './private.server';
import { parsePublicConfig } from './public';

const validPublicEnv = {
	STOREFRONT_ENABLED: 'true',
	CHECKOUT_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev'
};

const validPrivateEnv = {
	...validPublicEnv,
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
