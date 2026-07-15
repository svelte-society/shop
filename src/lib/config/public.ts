import * as v from 'valibot';

export type PublicConfig = {
	storefrontEnabled: boolean;
	checkoutEnabled: boolean;
	productionOrigin: URL;
	supportEmail: string;
};

const booleanSchema = v.pipe(
	v.picklist(['true', 'false']),
	v.transform((value) => value === 'true')
);

const httpsUrlSchema = v.pipe(
	v.string(),
	v.url(),
	v.transform((value) => new URL(value)),
	v.check((value) => value.protocol === 'https:')
);

const publicEnvSchema = v.object({
	STOREFRONT_ENABLED: booleanSchema,
	CHECKOUT_ENABLED: booleanSchema,
	PRODUCTION_ORIGIN: httpsUrlSchema,
	SUPPORT_EMAIL: v.pipe(v.string(), v.email())
});

export function parsePublicConfig(env: Record<string, string | undefined>): PublicConfig {
	const result = v.safeParse(publicEnvSchema, env);

	if (!result.success) {
		throw new Error('CONFIG_PUBLIC_INVALID');
	}

	return {
		storefrontEnabled: result.output.STOREFRONT_ENABLED,
		checkoutEnabled: result.output.CHECKOUT_ENABLED,
		productionOrigin: result.output.PRODUCTION_ORIGIN,
		supportEmail: result.output.SUPPORT_EMAIL
	};
}
