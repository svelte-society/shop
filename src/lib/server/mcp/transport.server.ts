import { HttpTransport } from '@tmcp/transport-http';
import { createMcpServer } from './server';

const transport = new HttpTransport(createMcpServer({}), { path: '/mcp' });

export async function handleMcp(request: Request): Promise<Response> {
	return (await transport.respond(request)) ?? new Response(null, { status: 404 });
}
