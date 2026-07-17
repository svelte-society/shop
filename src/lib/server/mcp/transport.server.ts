import { env } from '$env/dynamic/private';
import { HttpTransport } from '@tmcp/transport-http';
import { applicationLifecycle } from '$lib/server/app.server';
import { createRuntimeMcpServices } from './runtime.server';
import { createMcpServer, type McpServices } from './server';

export type McpResponder = (request: Request) => Promise<Response>;

export function createMcpResponder(createServices: () => McpServices): McpResponder {
	let transport: HttpTransport | undefined;
	return async (request: Request): Promise<Response> => {
		transport ??= new HttpTransport(createMcpServer(createServices()), { path: '/mcp' });
		return (await transport.respond(request)) ?? new Response(null, { status: 404 });
	};
}

export const handleMcp = createMcpResponder(() => {
	const runtime = applicationLifecycle.current();
	if (!runtime) throw new Error('APPLICATION_NOT_READY');
	return createRuntimeMcpServices(runtime.database, env);
});
