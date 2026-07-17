import { env } from '$env/dynamic/private';
import { HttpTransport } from '@tmcp/transport-http';
import { applicationLifecycle } from '$lib/server/app.server';
import { createRuntimeMcpServices } from './runtime.server';
import {
	createBoundedMcpSessionManagers,
	type BoundedMcpSessionManagers
} from './session-managers.server';
import { createMcpServer, type McpServices } from './server';

export type McpResponder = (request: Request) => Promise<Response>;

export function createMcpResponder(
	createServices: () => McpServices,
	options: { sessionManagers?: BoundedMcpSessionManagers } = {}
): McpResponder {
	let transport: HttpTransport | undefined;
	const sessionManagers = options.sessionManagers ?? createBoundedMcpSessionManagers();
	return async (request: Request): Promise<Response> => {
		transport ??= new HttpTransport(createMcpServer(createServices()), {
			path: '/mcp',
			sessionManager: sessionManagers
		});
		return (await transport.respond(request)) ?? new Response(null, { status: 404 });
	};
}

export const handleMcp = createMcpResponder(() => {
	const runtime = applicationLifecycle.current();
	if (!runtime) throw new Error('APPLICATION_NOT_READY');
	return createRuntimeMcpServices(runtime.database, env);
});
