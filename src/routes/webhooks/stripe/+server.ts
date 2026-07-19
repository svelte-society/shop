import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import Stripe from 'stripe';
import { applicationLifecycle } from '$lib/server/app.server';
import { parsePrivateConfig } from '$lib/config/private.server';
import { SqliteCheckoutDraftRepository } from '$lib/server/db/checkout-drafts.server';
import { SqlitePaidOrderUnitOfWork } from '$lib/server/db/orders.server';
import { SqliteStripeEventRepository } from '$lib/server/db/stripe-events.server';
import { checkReadiness } from '$lib/server/health/readiness.server';
import { SqliteRefundOrderUnitOfWork } from '$lib/server/orders/intake.server';
import { createStripeClient } from '$lib/server/stripe/client.server';
import { createStripeOrderGateway } from '$lib/server/stripe/paid-checkout';
import {
	createStripeWebhookService,
	createStripeWebhookVerifier,
	StripeWebhookError,
	type StripeWebhookService
} from '$lib/server/stripe/webhook.server';

type StripeWebhookServiceFactory = () => StripeWebhookService;
type RuntimeEnvironment = Record<string, string | undefined>;

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

function webhookProblem(error: StripeWebhookError): Response {
	const status =
		error.code === 'STRIPE_WEBHOOK_SIGNATURE_INVALID' ? 400 : error.retryable ? 500 : 422;
	const title = status === 400 ? 'Invalid Stripe webhook' : 'Stripe webhook processing failed';
	return problem(status, title, error.code);
}

function requiredRuntimeValue(runtimeEnv: RuntimeEnvironment, name: string): string {
	const value = runtimeEnv[name];
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new StripeWebhookError('STRIPE_WEBHOOK_CONFIG_INVALID', true);
	}
	return value;
}

export function _createDefaultStripeWebhookServiceFactory(
	runtimeEnv: RuntimeEnvironment
): StripeWebhookService {
	const webhookSecret = requiredRuntimeValue(runtimeEnv, 'STRIPE_WEBHOOK_SECRET');
	return createStripeWebhookService({
		webhookSecret,
		verifier: createStripeWebhookVerifier({ webhooks: Stripe.webhooks }),
		checkReadiness,
		loadProcessingDependencies() {
			const config = parsePrivateConfig(runtimeEnv);
			const database = applicationLifecycle.current()?.database;
			if (!database?.open) throw new Error('APPLICATION_NOT_READY');
			const stripeClient = createStripeClient(config.stripeSecretKey);
			return {
				stripeEvents: new SqliteStripeEventRepository(database),
				drafts: new SqliteCheckoutDraftRepository(database),
				stripeOrders: createStripeOrderGateway(stripeClient, config.styriaSupportedCountries),
				paidOrders: new SqlitePaidOrderUnitOfWork(database),
				refunds: new SqliteRefundOrderUnitOfWork(database)
			};
		}
	});
}

export function _createStripeWebhookPost(
	createService: StripeWebhookServiceFactory
): RequestHandler {
	let service: StripeWebhookService | undefined;

	return async ({ request }) => {
		const signature = request.headers.get('stripe-signature');
		if (signature === null || signature.trim().length === 0) {
			return problem(400, 'Invalid Stripe webhook', 'STRIPE_WEBHOOK_SIGNATURE_MISSING');
		}

		try {
			const rawBody = await request.text();
			service ??= createService();
			const result = await service.handle(rawBody, signature);
			return new Response(JSON.stringify({ received: true, duplicate: result.duplicate }), {
				status: 200,
				headers: {
					'cache-control': 'no-store',
					'content-type': 'application/json'
				}
			});
		} catch (error) {
			if (error instanceof StripeWebhookError) return webhookProblem(error);
			return problem(500, 'Stripe webhook processing failed', 'STRIPE_WEBHOOK_INTERNAL_ERROR');
		}
	};
}

export const POST: RequestHandler = _createStripeWebhookPost(() =>
	_createDefaultStripeWebhookServiceFactory(env)
);
