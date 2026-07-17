import { env } from '$env/dynamic/private';
import { authorizeBearer } from '$lib/server/mcp/auth.server';
import { handleMcp } from '$lib/server/mcp/transport.server';
import type { RequestHandler } from './$types';

type RuntimeEnvironment = Record<string, string | undefined>;
type McpResponder = (request: Request) => Promise<Response>;

export function _createMcpRequestHandler(
	runtimeEnv: RuntimeEnvironment,
	respond: McpResponder = handleMcp
): RequestHandler {
	return ({ request }) => {
		if (runtimeEnv.MCP_ENABLED === 'false') {
			return new Response(null, { status: 404 });
		}

		if (!authorizeBearer(request.headers.get('authorization'), runtimeEnv.MCP_BEARER_TOKEN ?? '')) {
			return new Response(null, {
				status: 401,
				headers: { 'www-authenticate': 'Bearer' }
			});
		}

		return respond(request);
	};
}

const mcpRequestHandler = _createMcpRequestHandler(env);

export const GET = mcpRequestHandler;
export const POST = mcpRequestHandler;
export const DELETE = mcpRequestHandler;
