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
import { SqliteCheckoutDraftRepository } from '$lib/server/db/checkout-drafts.server';
import { checkReadiness } from '$lib/server/health/readiness.server';
import { applicationLifecycle } from '$lib/server/app.server';
import { requireStorefront } from '$lib/server/storefront/guard.server';
import {
	DESTINATION_COOKIE,
	resolvePricingDestination
} from '$lib/server/storefront/destination.server';
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

function defaultCheckoutServiceFactory(config: PrivateConfig): CheckoutService {
	const database = applicationLifecycle.current()?.database;
	if (!database?.open) throw new Error('APPLICATION_NOT_READY');
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

	return async ({ request, cookies }) => {
		try {
			try {
				if (!(await readiness()).ready) {
					return problem(503, 'Checkout unavailable', 'SERVICE_NOT_READY');
				}
			} catch {
				return problem(503, 'Checkout unavailable', 'SERVICE_NOT_READY');
			}

			let publicConfig;
			try {
				publicConfig = requireStorefront(runtimeEnv, { whenDisabled: 'opening-soon' });
			} catch {
				return problem(503, 'Checkout unavailable', 'SERVICE_NOT_READY');
			}

			if (!publicConfig.storefrontEnabled) {
				return problem(404, 'Not found', 'STOREFRONT_DISABLED');
			}
			if (!publicConfig.checkoutEnabled) {
				return problem(503, 'Checkout unavailable', 'CHECKOUT_DISABLED');
			}

			let privateConfig: PrivateConfig;
			try {
				privateConfig = parsePrivateConfig(runtimeEnv);
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

			try {
				service ??= createService(privateConfig, runtimeEnv);
			} catch {
				return problem(503, 'Checkout unavailable', 'SERVICE_NOT_READY');
			}
			let destinationCountry;
			try {
				destinationCountry = resolvePricingDestination({
					cookieValue: cookies.get(DESTINATION_COOKIE),
					cloudflareCountry: request.headers.get('cf-ipcountry')
				}).countryCode;
			} catch {
				return problem(503, 'Checkout unavailable', 'SERVICE_NOT_READY');
			}
			const result = await service.start(input, destinationCountry);
			return json(result, { headers: { 'cache-control': 'no-store' } });
		} catch (error) {
			if (error instanceof CheckoutError) return checkoutProblem(error);
			return problem(500, 'Checkout unavailable', 'CHECKOUT_INTERNAL_ERROR');
		}
	};
}

export const POST: RequestHandler = _createCheckoutPost(env);
