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
import { WithdrawalCaseReader } from '$lib/server/withdrawals/case-reader.server';
import { parseWithdrawalDataKey } from '$lib/server/withdrawals/crypto.server';
import { SqliteWithdrawalRepository } from '$lib/server/withdrawals/repository.server';
import { WithdrawalWorkflowService } from '$lib/server/withdrawals/workflow.server';
import type { McpServices } from './server';
import { SqliteAlertService } from '$lib/server/monitoring/alerts.server';
import { parseWithdrawalConfig } from '$lib/config/private.server';

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

class RuntimeWithdrawalError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'RuntimeWithdrawalError';
	}
}

function stableWithdrawalCode(error: unknown): string | undefined {
	const candidate =
		typeof error === 'object' && error !== null && 'code' in error
			? error.code
			: error instanceof Error
				? error.message
				: undefined;
	return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(candidate)
		? candidate
		: undefined;
}

function runtimeWithdrawalError(error: unknown): RuntimeWithdrawalError {
	return new RuntimeWithdrawalError(
		stableWithdrawalCode(error) ?? 'WITHDRAWAL_CASE_INSPECTION_FAILED'
	);
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
	const withdrawalRepository = new SqliteWithdrawalRepository(database);
	const withdrawalDataKey = parseWithdrawalDataKey(environment.WITHDRAWAL_DATA_KEY);
	const withdrawalReader = new WithdrawalCaseReader({
		repository: withdrawalRepository,
		dataKey: withdrawalDataKey,
		alerts
	});
	const workflowDependencies = {
		database,
		repository: withdrawalRepository,
		reader: withdrawalReader,
		dataKey: withdrawalDataKey
	};
	const withdrawalWorkflow = new WithdrawalWorkflowService(workflowDependencies);
	const messageWorkflow = () => {
		const configuration = parseWithdrawalConfig(environment);
		return new WithdrawalWorkflowService({
			...workflowDependencies,
			productionOrigin: configuration.productionOrigin,
			supportEmail: configuration.supportEmail,
			seller: configuration.seller
		});
	};
	const withdrawals: NonNullable<McpServices['withdrawals']> = {
		listCases(input) {
			return withdrawalRepository.list(input);
		},
		inspectCase(reference) {
			let inspection;
			try {
				inspection = withdrawalReader.inspectActive(reference);
			} catch (error) {
				if (stableWithdrawalCode(error) === 'WITHDRAWAL_CASE_NOT_FOUND') {
					try {
						const unavailable = withdrawalRepository.getByReference(reference);
						if (unavailable && unavailable.purgedAt !== null) {
							throw new RuntimeWithdrawalError('WITHDRAWAL_PII_PURGED');
						}
					} catch (lookupError) {
						throw runtimeWithdrawalError(lookupError);
					}
				}
				throw runtimeWithdrawalError(error);
			}
			return {
				inspection,
				history: withdrawalRepository.getInspectionHistory(inspection.id)
			};
		}
	};
	const withdrawalActions: NonNullable<McpServices['withdrawalWorkflow']> = {
		beginReview(input) {
			return withdrawalWorkflow.beginReview({ ...input, now: new Date() });
		},
		recordEligibility(input) {
			return withdrawalWorkflow.recordEligibility({ ...input, now: new Date() });
		},
		recordReturn(input) {
			return withdrawalWorkflow.recordReturn({ ...input, now: new Date() });
		},
		closeCase(input) {
			return withdrawalWorkflow.closeCase({ ...input, now: new Date() });
		},
		resendMessage(input) {
			const now = new Date();
			if (input.mode === 'preview') {
				const preview = messageWorkflow().previewResend({
					reference: input.reference,
					sourceMessageId: input.sourceMessageId,
					now
				});
				return { mode: 'preview', ...preview, queued: false };
			}
			const confirmation = messageWorkflow().confirmResend({
				reference: input.reference,
				sourceMessageId: input.sourceMessageId,
				previewToken: input.previewToken as string,
				idempotencyKey: input.idempotencyKey as string,
				now
			});
			return { mode: 'confirm', ...confirmation };
		}
	};
	const brandName = requiredEnvironmentValue(environment, 'STYRIA_BRAND_NAME');
	const plunkSecretKey = requiredEnvironmentValue(environment, 'PLUNK_SECRET_KEY');
	const plunk = dependencies.createPlunkGateway
		? dependencies.createPlunkGateway(plunkSecretKey)
		: createPlunkClient({ secretKey: plunkSecretKey, baseUrl: environment.PLUNK_BASE_URL });
	const supportEmail = requiredEnvironmentValue(environment, 'SUPPORT_EMAIL');
	const sender = createShippingEmailSender(
		plunk,
		{
			name: requiredEnvironmentValue(environment, 'PLUNK_FROM_NAME'),
			email: requiredEnvironmentValue(environment, 'PLUNK_FROM_EMAIL')
		},
		requiredEnvironmentValue(environment, 'PRODUCTION_ORIGIN')
	);
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
		shipping,
		withdrawals,
		withdrawalWorkflow: withdrawalActions
	};
}
