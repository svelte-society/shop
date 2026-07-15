import * as v from 'valibot';
import { parsePublicConfig, type PublicConfig } from './public';

export type PrivateConfig = PublicConfig & {
	stripeSecretKey: string;
	stripePaidShippingRateId: string;
	stripeFreeShippingRateId: string;
};

const requiredValueSchema = v.pipe(
	v.string(),
	v.check((value) => value.trim().length > 0)
);

const stripeEnvSchema = v.object({
	STRIPE_SECRET_KEY: requiredValueSchema,
	STRIPE_PAID_SHIPPING_RATE_ID: requiredValueSchema,
	STRIPE_FREE_SHIPPING_RATE_ID: requiredValueSchema
});

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

	return {
		...publicConfig,
		stripeSecretKey: result.output.STRIPE_SECRET_KEY,
		stripePaidShippingRateId: result.output.STRIPE_PAID_SHIPPING_RATE_ID,
		stripeFreeShippingRateId: result.output.STRIPE_FREE_SHIPPING_RATE_ID
	};
}
