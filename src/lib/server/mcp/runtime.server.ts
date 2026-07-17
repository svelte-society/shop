import type { ShopDatabase } from '$lib/server/db/types';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import { SqliteApprovalRepository } from '$lib/server/fulfillment/approvals.server';
import { FulfillmentPreparationService } from '$lib/server/fulfillment/prepare.server';
import { StyriaReconciliationService } from '$lib/server/fulfillment/reconcile.server';
import { SqliteFulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import { FulfillmentSubmissionService } from '$lib/server/fulfillment/submit.server';
import { SqliteStyriaSyncJob } from '$lib/server/jobs/styria-sync.server';
import { createPlunkClient } from '$lib/server/plunk/client.server';
import type { PlunkGateway } from '$lib/server/plunk/gateway';
import {
	createShippingEmailSender,
	SqliteShippingEmailService
} from '$lib/server/plunk/shipping-email';
import {
	createStripeClient,
	createStripeFulfillmentGateway
} from '$lib/server/stripe/client.server';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import { createStyriaClient, type StyriaClientOptions } from '$lib/server/styria/client.server';
import type { StyriaGateway } from '$lib/server/styria/gateway';
import type { McpServices } from './server';
import { SqliteAlertService } from '$lib/server/monitoring/alerts.server';

type RuntimeEnvironment = Record<string, string | undefined>;

type RuntimeMcpDependencies = {
	createStripeGateway?: (secretKey: string) => StripeFulfillmentGateway;
	createStyriaGateway?: (options: StyriaClientOptions) => StyriaGateway;
	createPlunkGateway?: (secretKey: string) => PlunkGateway;
};

function requiredEnvironmentValue(environment: RuntimeEnvironment, name: string): string {
	const value = environment[name];
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value !== value.trim() ||
		/[\r\n]/.test(value)
	) {
		throw new Error('MCP_CONFIG_INVALID');
	}
	return value;
}

function timeoutValue(environment: RuntimeEnvironment): number | undefined {
	const value = environment.STYRIA_TIMEOUT_MS;
	if (value === undefined) return undefined;
	if (!/^[1-9]\d*$/.test(value)) throw new Error('MCP_CONFIG_INVALID');
	const timeoutMs = Number(value);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 10_000) {
		throw new Error('MCP_CONFIG_INVALID');
	}
	return timeoutMs;
}

function defaultStripeGateway(secretKey: string): StripeFulfillmentGateway {
	return createStripeFulfillmentGateway(createStripeClient(secretKey));
}

export function createRuntimeMcpServices(
	database: ShopDatabase,
	environment: RuntimeEnvironment,
	dependencies: RuntimeMcpDependencies = {}
): McpServices {
	const fulfillment = new SqliteFulfillmentRepository(database);
	const stripe = (dependencies.createStripeGateway ?? defaultStripeGateway)(
		requiredEnvironmentValue(environment, 'STRIPE_SECRET_KEY')
	);
	const styria = (dependencies.createStyriaGateway ?? createStyriaClient)({
		appId: requiredEnvironmentValue(environment, 'STYRIA_APP_ID'),
		secretKey: requiredEnvironmentValue(environment, 'STYRIA_SECRET_KEY'),
		baseUrl: environment.STYRIA_BASE_URL,
		timeoutMs: timeoutValue(environment)
	});
	const approvals = new SqliteApprovalRepository(database);
	const outbox = new SqliteOutboxRepository(database);
	const alerts = new SqliteAlertService(outbox);
	const brandName = requiredEnvironmentValue(environment, 'STYRIA_BRAND_NAME');
	const plunkSecretKey = requiredEnvironmentValue(environment, 'PLUNK_SECRET_KEY');
	const plunk = dependencies.createPlunkGateway
		? dependencies.createPlunkGateway(plunkSecretKey)
		: createPlunkClient({ secretKey: plunkSecretKey, baseUrl: environment.PLUNK_BASE_URL });
	const supportEmail = requiredEnvironmentValue(environment, 'SUPPORT_EMAIL');
	const sender = createShippingEmailSender(plunk, {
		name: requiredEnvironmentValue(environment, 'PLUNK_FROM_NAME'),
		email: requiredEnvironmentValue(environment, 'PLUNK_FROM_EMAIL')
	});
	const status = new SqliteStyriaSyncJob({ database, styria, fulfillment, outbox, alerts });
	const shipping = new SqliteShippingEmailService({
		database,
		outbox,
		stripe,
		sender,
		supportEmail
	});
	const shared = {
		fulfillment,
		stripe,
		brandName,
		comment: 'Approved Svelte Society fulfillment'
	};

	return {
		fulfillment,
		stripe,
		preparation: new FulfillmentPreparationService({ ...shared, approvals }),
		submission: new FulfillmentSubmissionService({ ...shared, styria, alerts }),
		reconciliation: new StyriaReconciliationService({ fulfillment, styria }),
		status,
		shipping
	};
}
