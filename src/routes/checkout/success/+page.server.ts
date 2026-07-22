import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';
import { parsePrivateConfig } from '$lib/config/private.server';
import { applicationLifecycle } from '$lib/server/app.server';
import {
	SqliteCheckoutDraftRepository,
	type CheckoutDraftRepository
} from '$lib/server/db/checkout-drafts.server';
import type { StripeOrderGateway } from '$lib/server/stripe/gateway';
import { comparePaidCheckout, createStripeOrderGateway } from '$lib/server/stripe/paid-checkout';
import { createStripeClient } from '$lib/server/stripe/client.server';
import type { PageServerLoad } from './$types';

type RuntimeEnvironment = Record<string, string | undefined>;
type StripeOrderGatewayFactory = (stripeSecretKey: string) => StripeOrderGateway;
type DraftReaderFactory = () => Pick<CheckoutDraftRepository, 'findById'>;
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

function defaultDraftReaderFactory(): Pick<CheckoutDraftRepository, 'findById'> {
	const database = applicationLifecycle.current()?.database;
	if (!database?.open) throw new Error('APPLICATION_NOT_READY');
	return new SqliteCheckoutDraftRepository(database);
}

export function _createSuccessPageServerLoad(
	runtimeEnv: RuntimeEnvironment,
	createGateway: StripeOrderGatewayFactory = defaultStripeOrderGatewayFactory,
	createDraftReader: DraftReaderFactory = defaultDraftReaderFactory
): PageServerLoad {
	let gateway: StripeOrderGateway | undefined;
	let draftReader: Pick<CheckoutDraftRepository, 'findById'> | undefined;

	return async ({ url, setHeaders }) => {
		setHeaders({ 'cache-control': 'no-store' });
		const sessionId = verifiedSessionId(url);
		try {
			const config = parsePrivateConfig(runtimeEnv);
			gateway ??= createGateway(config.stripeSecretKey);
			const paid = await gateway.retrievePaidCheckout(sessionId);
			draftReader ??= createDraftReader();
			const draft = draftReader.findById(paid.draftId);
			if (!draft) throw new Error('PAID_CHECKOUT_DRAFT_NOT_FOUND');
			comparePaidCheckout(draft, paid);
		} catch {
			error(404, 'Not found');
		}

		return { verified: true };
	};
}

export const load: PageServerLoad = _createSuccessPageServerLoad(env);
