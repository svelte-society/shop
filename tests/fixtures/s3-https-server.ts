import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { resolve } from 'node:path';

type StoredObject = {
	body: Uint8Array;
	contentType: string;
	lastModified: Date;
};

export type S3FixtureRequest = {
	method: string;
	bucket: string;
	key?: string;
	authorization?: string;
	continuationToken?: string;
	deletedKeys?: string[];
};

const certificatePath = resolve('tests/fixtures/provider-cert.pem');
const privateKeyPath = resolve('tests/fixtures/provider-key.pem');

function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function unescapeXml(value: string): string {
	return value
		.replaceAll('&apos;', "'")
		.replaceAll('&quot;', '"')
		.replaceAll('&gt;', '>')
		.replaceAll('&lt;', '<')
		.replaceAll('&amp;', '&');
}

async function requestBody(request: import('node:http').IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

export class S3HttpsFixture {
	readonly objects = new Map<string, StoredObject>();
	readonly requests: S3FixtureRequest[] = [];
	readonly pageSize = 1;
	private endpointValue = '';

	private constructor(private readonly server: Server) {}

	static async start(): Promise<S3HttpsFixture> {
		const server = createServer({
			cert: readFileSync(certificatePath),
			key: readFileSync(privateKeyPath)
		});
		const fixture = new S3HttpsFixture(server);
		server.on('request', (request, response) => {
			void fixture.handle(request, response).catch(() => {
				if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/xml' });
				response.end('<Error><Code>InternalError</Code></Error>');
			});
		});
		server.requestTimeout = 2_000;
		server.headersTimeout = 2_000;
		server.keepAliveTimeout = 100;
		await new Promise<void>((resolvePromise, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolvePromise());
		});
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('TEST_S3_ADDRESS_INVALID');
		fixture.endpointValue = `https://127.0.0.1:${address.port}`;
		return fixture;
	}

	get endpoint(): string {
		return this.endpointValue;
	}

	get listening(): boolean {
		return this.server.listening;
	}

	seed(bucket: string, key: string, body: Uint8Array, lastModified: Date): void {
		this.objects.set(`${bucket}/${key}`, {
			body: Uint8Array.from(body),
			contentType: 'application/octet-stream',
			lastModified
		});
	}

	object(bucket: string, key: string): StoredObject | undefined {
		return this.objects.get(`${bucket}/${key}`);
	}

	async close(): Promise<void> {
		this.server.closeIdleConnections();
		this.server.closeAllConnections();
		if (!this.server.listening) return;
		await new Promise<void>((resolvePromise, reject) => {
			this.server.close((error) => (error ? reject(error) : resolvePromise()));
		});
	}

	private async handle(
		request: import('node:http').IncomingMessage,
		response: import('node:http').ServerResponse
	): Promise<void> {
		request.setTimeout(2_000, () => request.destroy(new Error('TEST_S3_REQUEST_TIMEOUT')));
		const url = new URL(request.url ?? '/', this.endpointValue || 'https://127.0.0.1');
		const pathParts = url.pathname
			.split('/')
			.filter(Boolean)
			.map((part) => decodeURIComponent(part));
		const bucket = pathParts.shift() ?? '';
		const key = pathParts.join('/');
		const authorization = Array.isArray(request.headers.authorization)
			? request.headers.authorization[0]
			: request.headers.authorization;

		if (request.method === 'PUT' && key) {
			const body = await requestBody(request);
			this.requests.push({ method: 'PUT', bucket, key, authorization });
			this.objects.set(`${bucket}/${key}`, {
				body,
				contentType: request.headers['content-type'] ?? 'application/octet-stream',
				lastModified: new Date()
			});
			response.writeHead(200, {
				etag: `"${createHash('md5').update(body).digest('hex')}"`,
				'x-amz-request-id': 'fixture-put'
			});
			response.end();
			return;
		}

		if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
			const prefix = url.searchParams.get('prefix') ?? '';
			const continuationToken = url.searchParams.get('continuation-token') ?? undefined;
			this.requests.push({ method: 'LIST', bucket, key: prefix, authorization, continuationToken });
			const all = [...this.objects.entries()]
				.filter(([storedKey]) => storedKey.startsWith(`${bucket}/${prefix}`))
				.sort(([left], [right]) => left.localeCompare(right));
			const offset = continuationToken ? Number.parseInt(continuationToken, 10) : 0;
			const page = all.slice(offset, offset + this.pageSize);
			const nextOffset = offset + page.length;
			const truncated = nextOffset < all.length;
			const contents = page
				.map(([storedKey, object]) => {
					const objectKey = storedKey.slice(bucket.length + 1);
					return `<Contents><Key>${escapeXml(objectKey)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>"fixture"</ETag><Size>${object.body.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
				})
				.join('');
			const token = truncated ? `<NextContinuationToken>${nextOffset}</NextContinuationToken>` : '';
			response.writeHead(200, {
				'content-type': 'application/xml',
				'x-amz-request-id': 'fixture-list'
			});
			response.end(
				`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${escapeXml(bucket)}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${this.pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${token}</ListBucketResult>`
			);
			return;
		}

		if (request.method === 'GET' && key) {
			this.requests.push({ method: 'GET', bucket, key, authorization });
			const object = this.objects.get(`${bucket}/${key}`);
			if (!object) {
				response.writeHead(404, { 'content-type': 'application/xml' });
				response.end('<Error><Code>NoSuchKey</Code></Error>');
				return;
			}
			response.writeHead(200, {
				'content-type': object.contentType,
				'content-length': object.body.byteLength,
				etag: '"fixture"',
				'x-amz-request-id': 'fixture-get'
			});
			response.end(object.body);
			return;
		}

		if (request.method === 'POST' && url.searchParams.has('delete')) {
			const body = (await requestBody(request)).toString('utf8');
			const deletedKeys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/gu)].map((match) =>
				unescapeXml(match[1] ?? '')
			);
			this.requests.push({ method: 'DELETE', bucket, authorization, deletedKeys });
			for (const deletedKey of deletedKeys) this.objects.delete(`${bucket}/${deletedKey}`);
			response.writeHead(200, {
				'content-type': 'application/xml',
				'x-amz-request-id': 'fixture-delete'
			});
			response.end(
				`<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deletedKeys.map((deletedKey) => `<Deleted><Key>${escapeXml(deletedKey)}</Key></Deleted>`).join('')}</DeleteResult>`
			);
			return;
		}

		response.writeHead(404, { 'content-type': 'application/xml' });
		response.end('<Error><Code>NotFound</Code></Error>');
	}
}
