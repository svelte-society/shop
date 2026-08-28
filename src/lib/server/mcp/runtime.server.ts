import type { ShopDatabase } from '$lib/server/db/types';
import {
	parseMcpDeploymentConfig,
	parseResendDeploymentConfig,
	type RuntimeEnvironment
} from '$lib/config/deployment.server';
import type { EmailGateway } from '$lib/server/email/gateway';
import { createResendEmailGateway } from '$lib/server/email/resend.server';
import {
	createShippingEmailSender,
	SqliteShippingEmailService
} from '$lib/server/email/shipping-email';
import { SqliteOutboxRepository } from '$lib/server/db/outbox.server';
import { SqliteApprovalRepository } from '$lib/server/fulfillment/approvals.server';
import { FulfillmentPreparationService } from '$lib/server/fulfillment/prepare.server';
import { StyriaReconciliationService } from '$lib/server/fulfillment/reconcile.server';
import { SqliteFulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import { FulfillmentSubmissionService } from '$lib/server/fulfillment/submit.server';
import { SqliteStyriaSyncJob } from '$lib/server/jobs/styria-sync.server';
import {
	createStripeClient,
	createStripeFulfillmentGateway
} from '$lib/server/stripe/client.server';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import { createStyriaClient, type StyriaClientOptions } from '$lib/server/styria/client.server';
import type { StyriaGateway } from '$lib/server/styria/gateway';
import { WithdrawalCaseReader } from '$lib/server/withdrawals/case-reader.server';
import { SqliteWithdrawalRepository } from '$lib/server/withdrawals/repository.server';
import { WithdrawalWorkflowService } from '$lib/server/withdrawals/workflow.server';
import type { McpServices } from './server';
import { SqliteAlertService } from '$lib/server/monitoring/alerts.server';

type RuntimeMcpDependencies = {
	createStripeGateway?: (secretKey: string) => StripeFulfillmentGateway;
	createStyriaGateway?: (options: StyriaClientOptions) => StyriaGateway;
	createEmailGateway?: () => EmailGateway;
};

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
	const configuration = parseMcpDeploymentConfig(environment);
	const fulfillment = new SqliteFulfillmentRepository(database);
	const stripe = (dependencies.createStripeGateway ?? defaultStripeGateway)(
		configuration.stripeSecretKey
	);
	const styria = (dependencies.createStyriaGateway ?? createStyriaClient)({
		appId: configuration.styria.appId,
		secretKey: configuration.styria.secretKey,
		baseUrl: configuration.styria.baseUrl,
		timeoutMs: configuration.styria.timeoutMs
	});
	const approvals = new SqliteApprovalRepository(database);
	const outbox = new SqliteOutboxRepository(database);
	const alerts = new SqliteAlertService(outbox);
	const withdrawalRepository = new SqliteWithdrawalRepository(database);
	const withdrawalDataKey = configuration.withdrawal.dataKey;
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
		return new WithdrawalWorkflowService({
			...workflowDependencies,
			productionOrigin: configuration.withdrawal.productionOrigin,
			supportEmail: configuration.withdrawal.supportEmail,
			seller: configuration.withdrawal.seller
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
	const brandName = configuration.styria.brandName;
	const email = dependencies.createEmailGateway
		? dependencies.createEmailGateway()
		: createResendEmailGateway(parseResendDeploymentConfig(environment, 'MCP_CONFIG_INVALID'));
	const supportEmail = configuration.withdrawal.supportEmail;
	const sender = createShippingEmailSender(
		email,
		configuration.email.from,
		configuration.withdrawal.productionOrigin.origin
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
