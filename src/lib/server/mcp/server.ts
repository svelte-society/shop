import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import type { PreparationService } from '$lib/server/fulfillment/prepare.server';
import type { ReconciliationService } from '$lib/server/fulfillment/reconcile.server';
import type { FulfillmentRepository } from '$lib/server/fulfillment/repository.server';
import type { SubmissionService } from '$lib/server/fulfillment/submit.server';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import { registerCheckStatusTool, type FulfillmentStatusService } from './tools/check-status';
import { registerInspectOrderTool } from './tools/inspect-order';
import { registerListPendingTool } from './tools/list-pending';
import { registerPrepareStyriaTool } from './tools/prepare-styria';
import { registerReconcileStyriaTool } from './tools/reconcile-styria';
import { registerRecordSupportTool } from './tools/record-support';
import { registerResendShippingTool, type ShippingEmailService } from './tools/resend-shipping';
import { registerSubmitStyriaTool } from './tools/submit-styria';

export type McpServices = Readonly<{
	fulfillment?: Pick<FulfillmentRepository, 'listPending' | 'inspect' | 'recordSupportNote'>;
	stripe?: Pick<StripeFulfillmentGateway, 'retrieveFulfillmentDetails'>;
	preparation?: PreparationService;
	submission?: SubmissionService;
	reconciliation?: ReconciliationService;
	status?: FulfillmentStatusService;
	shipping?: ShippingEmailService;
	now?: () => Date;
}>;

export function createMcpServer(services: McpServices): McpServer<GenericSchema> {
	const server = new McpServer(
		{ name: 'svelte-society-shop', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: false } },
			instructions:
				'Operate paid Svelte Society Shop orders. Prepare before submit; reconcile every ambiguous Styria create.'
		}
	);

	registerListPendingTool(server, services.fulfillment);
	registerInspectOrderTool(server, {
		fulfillment: services.fulfillment,
		stripe: services.stripe
	});
	registerPrepareStyriaTool(server, services.preparation);
	registerSubmitStyriaTool(server, services.submission);
	registerReconcileStyriaTool(server, services.reconciliation);
	registerCheckStatusTool(server, services.status);
	registerResendShippingTool(server, services.shipping);
	registerRecordSupportTool(server, {
		fulfillment: services.fulfillment,
		now: services.now ?? (() => new Date())
	});

	return server;
}
