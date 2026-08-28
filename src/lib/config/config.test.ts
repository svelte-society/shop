import { describe, expect, it } from 'vitest';
import {
	parsePrivateConfig,
	parseSellerPolicyConfig,
	parseWithdrawalConfig
} from './private.server';
import { parsePublicConfig } from './public';
import { SHOP_CONFIG } from './shop';

const withdrawalDataKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString(
	'base64'
);

const validPublicEnv = {
	STOREFRONT_ENABLED: 'true',
	CHECKOUT_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev'
};

const validPrivateEnv = {
	...validPublicEnv,
	WITHDRAWAL_DATA_KEY: withdrawalDataKey,
	STRIPE_SECRET_KEY: 'sk_test_private_value',
	STRIPE_WEBHOOK_SECRET: 'whsec_test_private_value',
	STRIPE_PAID_SHIPPING_RATE_ID: 'shr_paid',
	STRIPE_FREE_SHIPPING_RATE_ID: 'shr_free'
};

const legacyPolicyEnv = {
	SELLER_LEGAL_NAME: 'Untrusted seller override',
	SELLER_REGISTRATION_NUMBER: '',
	SELLER_VAT_NUMBER: 'Untrusted VAT override',
	SELLER_ADDRESS_LINE1: 'Untrusted address override',
	SELLER_POSTAL_CODE: '000 00',
	SELLER_CITY: 'Untrusted city override',
	SELLER_COUNTRY: 'Untrusted country override',
	SELLER_EMAIL: 'not-an-email',
	DELIVERY_ESTIMATE_EU: '',
	DELIVERY_ESTIMATE_ASIA: 'Untrusted delivery override',
	POLICY_EFFECTIVE_DATE: 'not-a-date'
};

const sourceSellerPolicyConfig = {
	sellerLegalName: 'Svelte Summit AB',
	sellerRegistrationNumber: '559490-8336',
	sellerVatNumber: 'SE559490833601',
	sellerAddressLine1: 'Hummelhaga 13',
	sellerPostalCode: '153 95',
	sellerCity: 'Järna',
	sellerCountry: 'Sweden',
	sellerEmail: 'merch@sveltesociety.dev',
	deliveryEstimateEu:
		'Estimated delivery: usually 5–7 business days. Delivery times are estimates and aren’t guaranteed.',
	deliveryEstimateAsia:
		'Production normally takes 1–5 business days, followed by roughly 6–10 business days in transit',
	policyEffectiveDate: '2026-07-19'
};

describe('SHOP_CONFIG', () => {
	it('owns the reviewed shop identity, policy, provider branding, and browser origins', () => {
		expect(SHOP_CONFIG).toEqual({
			contact: {
				supportEmail: 'merch@sveltesociety.dev',
				adminEmail: 'merch@sveltesociety.dev',
				sellerEmail: 'merch@sveltesociety.dev'
			},
			email: {
				fromName: 'Svelte Society Shop',
				fromAddress: 'merch@sveltesociety.dev'
			},
			styria: { brandName: 'Svelte Society' },
			sellerPolicy: {
				legalName: 'Svelte Summit AB',
				registrationNumber: '559490-8336',
				vatNumber: 'SE559490833601',
				addressLine1: 'Hummelhaga 13',
				postalCode: '153 95',
				city: 'Järna',
				country: 'Sweden',
				deliveryEstimateEu:
					'Estimated delivery: usually 5–7 business days. Delivery times are estimates and aren’t guaranteed.',
				deliveryEstimateAsia:
					'Production normally takes 1–5 business days, followed by roughly 6–10 business days in transit',
				effectiveDate: '2026-07-19'
			},
			browser: {
				catalogImageOrigins: ['https://raw.githubusercontent.com', 'https://wsrv.nl'],
				societyAssetOrigins: []
			}
		});
	});

	it('keeps source-owned values syntactically safe for their runtime consumers', () => {
		for (const email of [
			SHOP_CONFIG.contact.supportEmail,
			SHOP_CONFIG.contact.adminEmail,
			SHOP_CONFIG.contact.sellerEmail,
			SHOP_CONFIG.email.fromAddress
		]) {
			expect(email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u);
			expect(email).not.toMatch(/[\r\n]/u);
		}

		const effectiveDate = SHOP_CONFIG.sellerPolicy.effectiveDate;
		expect(effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
		expect(new Date(`${effectiveDate}T00:00:00.000Z`).toISOString().slice(0, 10)).toBe(
			effectiveDate
		);

		for (const origin of [
			...SHOP_CONFIG.browser.catalogImageOrigins,
			...SHOP_CONFIG.browser.societyAssetOrigins
		]) {
			const parsed = new URL(origin);
			expect(parsed.protocol).toBe('https:');
			expect(parsed.origin).toBe(origin);
		}

		for (const value of [
			SHOP_CONFIG.email.fromName,
			SHOP_CONFIG.styria.brandName,
			...Object.values(SHOP_CONFIG.sellerPolicy)
		]) {
			expect(value.trim()).toBe(value);
			expect(value.length).toBeGreaterThan(0);
			expect(value).not.toMatch(/[\r\n]/u);
		}
	});
});

describe('parseWithdrawalConfig', () => {
	it('accepts only the canonical base64 representation of a 32-byte key at key version one', () => {
		expect(parseWithdrawalConfig(validPrivateEnv)).toEqual({
			dataKey: Buffer.from(withdrawalDataKey, 'base64'),
			keyVersion: 1,
			productionOrigin: new URL('https://shop.sveltesociety.dev'),
			supportEmail: 'merch@sveltesociety.dev',
			seller: {
				legalName: 'Svelte Summit AB',
				registrationNumber: '559490-8336',
				addressLine1: 'Hummelhaga 13',
				postalCode: '153 95',
				city: 'Järna',
				country: 'Sweden',
				email: 'merch@sveltesociety.dev'
			}
		});
	});

	it.each([
		undefined,
		'',
		Buffer.alloc(31).toString('base64'),
		Buffer.alloc(33).toString('base64'),
		Buffer.from(withdrawalDataKey, 'base64').toString('base64url'),
		`${withdrawalDataKey}\n`,
		'!'.repeat(44)
	])('rejects a missing, malformed, non-canonical, or wrong-length key %j', (value) => {
		expect(() =>
			parseWithdrawalConfig({ ...validPrivateEnv, WITHDRAWAL_DATA_KEY: value })
		).toThrowError('CONFIG_WITHDRAWAL_INVALID');
	});

	it('uses source-owned seller values without seller or policy environment fields', () => {
		expect(parseSellerPolicyConfig()).toEqual(sourceSellerPolicyConfig);
		expect(parseWithdrawalConfig(validPrivateEnv).seller).toEqual({
			legalName: 'Svelte Summit AB',
			registrationNumber: '559490-8336',
			addressLine1: 'Hummelhaga 13',
			postalCode: '153 95',
			city: 'Järna',
			country: 'Sweden',
			email: 'merch@sveltesociety.dev'
		});
	});

	it('ignores legacy seller and policy environment overrides', () => {
		expect(parseSellerPolicyConfig()).toEqual(sourceSellerPolicyConfig);
		expect(parseWithdrawalConfig({ ...validPrivateEnv, ...legacyPolicyEnv })).toEqual(
			parseWithdrawalConfig(validPrivateEnv)
		);
	});

	it('operates with commerce flags disabled and without Stripe configuration', () => {
		const {
			STRIPE_SECRET_KEY: _secret,
			STRIPE_WEBHOOK_SECRET: _webhook,
			...withoutSecret
		} = validPrivateEnv;
		const {
			STRIPE_PAID_SHIPPING_RATE_ID: _paid,
			STRIPE_FREE_SHIPPING_RATE_ID: _free,
			...withdrawalOnly
		} = withoutSecret;
		void _secret;
		void _webhook;
		void _paid;
		void _free;

		expect(
			parseWithdrawalConfig({
				...withdrawalOnly,
				STOREFRONT_ENABLED: 'false',
				CHECKOUT_ENABLED: 'false'
			})
		).toMatchObject({ keyVersion: 1 });
	});

	it('parses identically when both commerce feature flags are absent', () => {
		const {
			STOREFRONT_ENABLED: _storefront,
			CHECKOUT_ENABLED: _checkout,
			...withoutCommerceFlags
		} = validPrivateEnv;
		void _storefront;
		void _checkout;

		expect(parseWithdrawalConfig(withoutCommerceFlags)).toEqual(
			parseWithdrawalConfig(validPrivateEnv)
		);
	});

	it.each([
		{ STOREFRONT_ENABLED: 'malformed', CHECKOUT_ENABLED: 'false' },
		{ STOREFRONT_ENABLED: 'true', CHECKOUT_ENABLED: 'malformed' },
		{ STOREFRONT_ENABLED: 'malformed', CHECKOUT_ENABLED: 'also-malformed' }
	])('ignores malformed commerce feature flags %#', (commerceFlags) => {
		expect(parseWithdrawalConfig({ ...validPrivateEnv, ...commerceFlags })).toEqual(
			parseWithdrawalConfig(validPrivateEnv)
		);
	});

	it.each([undefined, '', 'not-an-email'])('ignores the legacy support email value %j', (value) => {
		expect(parseWithdrawalConfig({ ...validPrivateEnv, SUPPORT_EMAIL: value })).toEqual(
			parseWithdrawalConfig(validPrivateEnv)
		);
	});
});

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

	it.each([undefined, '', 'not-an-email'])('ignores the legacy support email value %j', (value) => {
		expect(parsePublicConfig({ ...validPublicEnv, SUPPORT_EMAIL: value })).toEqual(
			parsePublicConfig(validPublicEnv)
		);
	});
});

describe('parsePrivateConfig', () => {
	it('ignores legacy seller and policy environment values in checkout-enabled production', () => {
		expect(() =>
			parsePrivateConfig({
				...validPrivateEnv,
				...legacyPolicyEnv,
				NODE_ENV: 'production',
				CHECKOUT_ENABLED: 'true'
			})
		).not.toThrow();
	});

	it('ignores the legacy support address in production checkout', () => {
		expect(() =>
			parsePrivateConfig({
				...validPrivateEnv,
				NODE_ENV: 'production',
				CHECKOUT_ENABLED: 'true',
				SUPPORT_EMAIL: 'support@example.com'
			})
		).not.toThrow();
	});

	it('accepts production checkout without seller or policy environment fields', () => {
		expect(() =>
			parsePrivateConfig({
				...validPrivateEnv,
				NODE_ENV: 'production',
				CHECKOUT_ENABLED: 'true'
			})
		).not.toThrow();
	});

	it('rejects checkout-enabled production startup when the withdrawal key is absent', () => {
		expect(() =>
			parsePrivateConfig({
				...validPrivateEnv,
				NODE_ENV: 'production',
				CHECKOUT_ENABLED: 'true',
				WITHDRAWAL_DATA_KEY: undefined
			})
		).toThrowError('CONFIG_PRIVATE_INVALID');
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
