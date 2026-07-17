import { describe, expect, it, vi } from 'vitest';
import { createMcpResponder } from '$lib/server/mcp/transport.server';
import { _createMcpRequestHandler } from './+server';

const TOKEN = 'test.mcp-token_123-~';
const ENABLED_ENV = {
	MCP_ENABLED: 'true',
	MCP_BEARER_TOKEN: TOKEN
};

type JsonRpcResponse = {
	jsonrpc: '2.0';
	id: number;
	result: Record<string, unknown>;
};

function request(
	method: 'GET' | 'POST' | 'DELETE',
	options: {
		token?: string | null;
		sessionId?: string;
		body?: Record<string, unknown>;
		origin?: string;
	} = {}
): Request {
	const headers = new Headers();
	if (options.token !== null) headers.set('authorization', `Bearer ${options.token ?? TOKEN}`);
	if (options.sessionId) headers.set('mcp-session-id', options.sessionId);
	if (options.origin) headers.set('origin', options.origin);
	if (method === 'POST') headers.set('content-type', 'application/json');

	return new Request('https://shop.sveltesociety.dev/mcp', {
		method,
		headers,
		body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined
	});
}

async function invoke(
	handler: ReturnType<typeof _createMcpRequestHandler>,
	mcpRequest: Request
): Promise<Response> {
	return handler({ request: mcpRequest } as Parameters<typeof handler>[0]);
}

async function eventData(response: Response): Promise<JsonRpcResponse> {
	const payload = await response.text();
	const data = payload
		.split('\n')
		.find((line) => line.startsWith('data: '))
		?.slice('data: '.length);
	if (!data) throw new Error('MCP_EVENT_DATA_MISSING');
	return JSON.parse(data) as JsonRpcResponse;
}

function initializeBody(id = 1): Record<string, unknown> {
	return {
		jsonrpc: '2.0',
		id,
		method: 'initialize',
		params: {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'codex-admin-test', version: '1.0.0' }
		}
	};
}

describe('/mcp bearer guard', () => {
	it('returns 404 before auth or transport when MCP is disabled', async () => {
		const respond = vi.fn(async () => new Response(null, { status: 200 }));
		const handler = _createMcpRequestHandler(
			{ MCP_ENABLED: 'false', MCP_BEARER_TOKEN: TOKEN },
			respond
		);

		const response = await invoke(handler, request('POST', { body: initializeBody() }));

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
		expect(respond).not.toHaveBeenCalled();
	});

	it.each([
		['missing bearer', null, TOKEN],
		['invalid bearer', 'wrong-token', TOKEN],
		['absent server secret', TOKEN, '']
	])('returns a bearer challenge for %s before transport', async (_label, supplied, expected) => {
		const respond = vi.fn(async () => new Response(null, { status: 200 }));
		const handler = _createMcpRequestHandler(
			{ MCP_ENABLED: 'true', MCP_BEARER_TOKEN: expected },
			respond
		);

		const response = await invoke(handler, request('POST', { token: supplied }));
		const observable = `${response.status}\n${JSON.stringify([...response.headers])}\n${await response.text()}`;

		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe('Bearer');
		expect(respond).not.toHaveBeenCalled();
		expect(observable).not.toContain('wrong-token');
		expect(observable).not.toContain(TOKEN);
	});

	it.each(['GET', 'POST', 'DELETE'] as const)(
		'forwards an authenticated %s request to TMCP',
		async (method) => {
			const mcpRequest = request(method);
			const transportResponse = new Response(null, { status: 204 });
			const respond = vi.fn(async () => transportResponse);
			const handler = _createMcpRequestHandler(ENABLED_ENV, respond);

			const response = await invoke(handler, mcpRequest);

			expect(response).toBe(transportResponse);
			expect(respond).toHaveBeenCalledOnce();
			expect(respond).toHaveBeenCalledWith(mcpRequest);
		}
	);
});

describe('/mcp TMCP Streamable HTTP protocol', () => {
	const handler = _createMcpRequestHandler(
		ENABLED_ENV,
		createMcpResponder(() => ({}))
	);

	it('initializes the exact internal fulfillment server without browser CORS', async () => {
		const response = await invoke(
			handler,
			request('POST', {
				body: initializeBody(),
				origin: 'https://browser.example'
			})
		);
		const message = await eventData(response);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/event-stream');
		expect(response.headers.get('mcp-session-id')).toBeTruthy();
		expect(response.headers.get('access-control-allow-origin')).toBeNull();
		expect(message).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: {
				protocolVersion: '2025-06-18',
				adapter: expect.any(Object),
				capabilities: { tools: { listChanged: false } },
				instructions:
					'Operate paid Svelte Society Shop orders. Prepare before submit; reconcile every ambiguous Styria create.',
				serverInfo: { name: 'svelte-society-shop', version: '1.0.0' }
			}
		});
	});

	it('lists tools and preserves the supplied session header across requests', async () => {
		const sessionId = 'codex-session-preserved';
		const initialize = await invoke(
			handler,
			request('POST', { sessionId, body: initializeBody(10) })
		);
		const initialized = await eventData(initialize);
		const list = await invoke(
			handler,
			request('POST', {
				sessionId,
				body: { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }
			})
		);
		const listed = await eventData(list);

		expect(initialize.headers.get('mcp-session-id')).toBe(sessionId);
		expect(initialized.id).toBe(10);
		expect(list.status).toBe(200);
		expect(list.headers.get('mcp-session-id')).toBe(sessionId);
		expect(listed.jsonrpc).toBe('2.0');
		expect(listed.id).toBe(11);
		expect((listed.result.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
			'list_pending_orders',
			'inspect_order',
			'prepare_styria_submission',
			'submit_styria_order',
			'reconcile_styria_order',
			'check_fulfillment_status',
			'resend_shipping_email',
			'record_return_or_replacement'
		]);
	});

	it('DELETE cleans up a notification stream session so it can be opened again', async () => {
		const sessionId = 'codex-session-cleanup';
		const first = await invoke(handler, request('GET', { sessionId }));
		const conflict = await invoke(handler, request('GET', { sessionId }));
		const deleted = await invoke(handler, request('DELETE', { sessionId }));
		const replacement = await invoke(handler, request('GET', { sessionId }));

		expect(first.status).toBe(200);
		expect(first.headers.get('mcp-session-id')).toBe(sessionId);
		expect(conflict.status).toBe(409);
		expect(deleted.status).toBe(200);
		expect(deleted.headers.get('mcp-session-id')).toBe(sessionId);
		expect(replacement.status).toBe(200);

		await replacement.body?.cancel();
		await first.body?.cancel();
	});
});
