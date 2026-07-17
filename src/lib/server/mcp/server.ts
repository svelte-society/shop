import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { McpServer } from 'tmcp';

export type McpServices = Readonly<Record<string, unknown>>;

export function createMcpServer(services: McpServices): McpServer {
	void services;

	return new McpServer(
		{ name: 'svelte-society-shop', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: false } },
			instructions:
				'Operate paid Svelte Society Shop orders. Prepare before submit; reconcile every ambiguous Styria create.'
		}
	);
}
