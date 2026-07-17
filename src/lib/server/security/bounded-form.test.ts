import { describe, expect, it } from 'vitest';
import { readBoundedFormData } from './bounded-form.server';

function streamingRequest(body: Uint8Array, headers: HeadersInit = {}): Request {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let offset = 0; offset < body.length; offset += 4_096) {
				controller.enqueue(body.slice(offset, offset + 4_096));
			}
			controller.close();
		}
	});
	return new Request('https://shop.sveltesociety.dev/withdraw?/review', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
		body: stream,
		duplex: 'half'
	} as RequestInit);
}

describe('readBoundedFormData', () => {
	it('parses a form only after reading a body within the byte limit', async () => {
		const request = streamingRequest(
			new TextEncoder().encode('fullName=Ada+Lovelace&scope=entire_order')
		);
		const data = await readBoundedFormData(request, 65_536);
		expect(data.get('fullName')).toBe('Ada Lovelace');
	});

	it('rejects an oversized declared content length before reading the stream', async () => {
		const request = {
			headers: new Headers({ 'content-length': '65537' }),
			get body(): never {
				throw new Error('BODY_WAS_READ');
			}
		} as unknown as Request;
		await expect(readBoundedFormData(request, 65_536)).rejects.toThrow('FORM_BODY_TOO_LARGE');
	});

	it.each([
		['absent', {}],
		['understated', { 'content-length': '10' }]
	])(
		'rejects a %s content length when actual streamed bytes exceed the limit',
		async (_name, headers) => {
			const request = streamingRequest(new Uint8Array(65_537).fill(97), headers);
			await expect(readBoundedFormData(request, 65_536)).rejects.toThrow('FORM_BODY_TOO_LARGE');
		}
	);

	it('rejects malformed and unsupported form bodies generically', async () => {
		const request = streamingRequest(new TextEncoder().encode('{"name":"Ada"}'), {
			'content-type': 'application/json'
		});
		await expect(readBoundedFormData(request, 65_536)).rejects.toThrow('FORM_BODY_INVALID');
	});
});
