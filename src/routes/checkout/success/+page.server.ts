import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';
import { parsePrivateConfig } from '$lib/config/private.server';
import type { StripeOrderGateway } from '$lib/server/stripe/gateway';
import { createStripeOrderGateway } from '$lib/server/stripe/paid-checkout';
import { createStripeClient } from '$lib/server/stripe/client.server';
import type { PageServerLoad } from './$types';

type RuntimeEnvironment = Record<string, string | undefined>;
type StripeOrderGatewayFactory = (stripeSecretKey: string) => StripeOrderGateway;
const CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/;

function verifiedSessionId(url: URL): string {
	const parameters = [...url.searchParams.entries()];
	if (
		parameters.length !== 1 ||
		parameters[0][0] !== 'session_id' ||
		!CHECKOUT_SESSION_ID_PATTERN.test(parameters[0][1])
	) {
		error(404, 'Not found');
	}
	return parameters[0][1];
}

function defaultStripeOrderGatewayFactory(stripeSecretKey: string): StripeOrderGateway {
	return createStripeOrderGateway(createStripeClient(stripeSecretKey));
}

export function _createSuccessPageServerLoad(
	runtimeEnv: RuntimeEnvironment,
	createGateway: StripeOrderGatewayFactory = defaultStripeOrderGatewayFactory
): PageServerLoad {
	let gateway: StripeOrderGateway | undefined;

	return async ({ url, setHeaders }) => {
		setHeaders({ 'cache-control': 'no-store' });
		const sessionId = verifiedSessionId(url);
		try {
			const config = parsePrivateConfig(runtimeEnv);
			gateway ??= createGateway(config.stripeSecretKey);
			await gateway.retrievePaidCheckout(sessionId);
		} catch {
			error(404, 'Not found');
		}

		return { verified: true };
	};
}

export const load: PageServerLoad = _createSuccessPageServerLoad(env);
