import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import { parsePrivateConfig, type PrivateConfig } from '$lib/config/private.server';
import { createCatalogGateway } from '$lib/server/catalog/runtime-gateway.server';
import { createCatalogService } from '$lib/server/catalog/service.server';
import {
	CheckoutError,
	createCheckoutService,
	type CheckoutService
} from '$lib/server/checkout/service.server';
import { openDatabase } from '$lib/server/db/connection.server';
import { SqliteCheckoutDraftRepository } from '$lib/server/db/checkout-drafts.server';
import { checkReadiness } from '$lib/server/health/readiness.server';
import { requireStorefront } from '$lib/server/storefront/guard.server';
import { createStripeCheckoutGateway } from '$lib/server/stripe/checkout.server';
import { createStripeClient } from '$lib/server/stripe/client.server';
import type { RequestHandler } from './$types';

type RuntimeEnvironment = Record<string, string | undefined>;
type CheckoutServiceFactory = (
	config: PrivateConfig,
	runtimeEnv: RuntimeEnvironment
) => CheckoutService;
type ReadinessCheck = () => Promise<{ ready: boolean }>;

type Problem = {
	type: 'about:blank';
	title: string;
	status: number;
	code: string;
};

function problem(status: number, title: string, code: string): Response {
	const body: Problem = { type: 'about:blank', title, status, code };
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'application/problem+json'
		}
	});
}

function isJsonRequest(request: Request): boolean {
	return (
		request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ===
		'application/json'
	);
}

function defaultCheckoutServiceFactory(
	config: PrivateConfig,
	runtimeEnv: RuntimeEnvironment
): CheckoutService {
	const databasePath = runtimeEnv.DATABASE_PATH;
	if (typeof databasePath !== 'string' || databasePath.trim().length === 0) {
		throw new Error('CONFIG_PRIVATE_INVALID');
	}

	const database = openDatabase(databasePath);
	const catalog = createCatalogService(createCatalogGateway(config.stripeSecretKey));
	const drafts = new SqliteCheckoutDraftRepository(database);
	const stripe = createStripeCheckoutGateway(createStripeClient(config.stripeSecretKey));

	return createCheckoutService({
		catalog,
		drafts,
		stripe,
		paidShippingRateId: config.stripePaidShippingRateId,
		freeShippingRateId: config.stripeFreeShippingRateId,
		productionOrigin: config.productionOrigin
	});
}

function checkoutProblem(error: CheckoutError): Response {
	if (error.code === 'CHECKOUT_REQUEST_INVALID') {
		return problem(400, 'Invalid checkout request', error.code);
	}
	if (error.code === 'CHECKOUT_VARIANT_UNAVAILABLE') {
		return problem(409, 'Checkout unavailable', error.code);
	}
	return problem(503, 'Checkout unavailable', error.code);
}

export function _createCheckoutPost(
	runtimeEnv: RuntimeEnvironment,
	createService: CheckoutServiceFactory = defaultCheckoutServiceFactory,
	readiness: ReadinessCheck = checkReadiness
): RequestHandler {
	let service: CheckoutService | undefined;

	return async ({ request }) => {
		try {
			const publicConfig = requireStorefront(runtimeEnv, { whenDisabled: 'opening-soon' });

			if (!publicConfig.storefrontEnabled) {
				return problem(404, 'Not found', 'STOREFRONT_DISABLED');
			}
			if (!publicConfig.checkoutEnabled) {
				return problem(503, 'Checkout unavailable', 'CHECKOUT_DISABLED');
			}

			try {
				if (!(await readiness()).ready) {
					return problem(503, 'Checkout unavailable', 'SERVICE_NOT_READY');
				}
			} catch {
				return problem(503, 'Checkout unavailable', 'SERVICE_NOT_READY');
			}
			if (!isJsonRequest(request)) {
				return problem(415, 'JSON request required', 'CHECKOUT_JSON_REQUIRED');
			}

			const requestOrigin = request.headers.get('origin');
			if (requestOrigin !== null && requestOrigin !== publicConfig.productionOrigin.origin) {
				return problem(403, 'Forbidden', 'CHECKOUT_ORIGIN_INVALID');
			}

			let input: unknown;
			try {
				input = await request.json();
			} catch {
				return problem(400, 'Invalid checkout request', 'CHECKOUT_REQUEST_INVALID');
			}

			const privateConfig = parsePrivateConfig(runtimeEnv);
			service ??= createService(privateConfig, runtimeEnv);
			const result = await service.start(input);
			return json(result, { headers: { 'cache-control': 'no-store' } });
		} catch (error) {
			if (error instanceof CheckoutError) return checkoutProblem(error);
			return problem(500, 'Checkout unavailable', 'CHECKOUT_INTERNAL_ERROR');
		}
	};
}

export const POST: RequestHandler = _createCheckoutPost(env);
