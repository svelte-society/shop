import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type NodeFetchTransportOptions = {
	ca?: string | Buffer;
};

function requestBody(body: BodyInit | null | undefined): string | Uint8Array | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === 'string' || body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	throw new TypeError('HTTP_REQUEST_BODY_UNSUPPORTED');
}

// Node's ClientRequest destroys its socket when the AbortSignal fires. Using an
// unpooled request here makes shutdown observable at the provider and prevents a
// canceled TLS handshake from keeping the adapter-node process alive.
export function nodeFetch(
	input: RequestInfo | URL,
	init: RequestInit = {},
	transport: NodeFetchTransportOptions = {}
): Promise<Response> {
	const url = new URL(String(input));
	const request =
		url.protocol === 'https:' ? httpsRequest : url.protocol === 'http:' ? httpRequest : null;
	if (!request) return Promise.reject(new TypeError('HTTP_PROTOCOL_UNSUPPORTED'));
	const body = requestBody(init.body);
	const headers = Object.fromEntries(new Headers(init.headers).entries());

	return new Promise((resolve, reject) => {
		const outgoing = request(
			url,
			{
				method: init.method,
				headers,
				signal: init.signal ?? undefined,
				agent: false,
				...(url.protocol === 'https:' && transport.ca ? { ca: transport.ca } : {})
			},
			(incoming) => {
				const chunks: Buffer[] = [];
				let received = 0;
				incoming.on('data', (chunk: Buffer) => {
					received += chunk.byteLength;
					if (received > MAX_RESPONSE_BYTES) {
						incoming.destroy(new Error('HTTP_RESPONSE_TOO_LARGE'));
						return;
					}
					chunks.push(chunk);
				});
				incoming.once('error', reject);
				incoming.once('end', () => {
					const responseHeaders = new Headers();
					for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
						responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
					}
					resolve(
						new Response(Buffer.concat(chunks), {
							status: incoming.statusCode,
							statusText: incoming.statusMessage,
							headers: responseHeaders
						})
					);
				});
			}
		);
		outgoing.once('error', reject);
		outgoing.end(body);
	});
}
