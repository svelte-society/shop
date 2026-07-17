export class BoundedFormError extends Error {
	constructor(readonly code: 'FORM_BODY_TOO_LARGE' | 'FORM_BODY_INVALID') {
		super(code);
		this.name = 'BoundedFormError';
	}
}

export async function readBoundedFormData(
	request: Request,
	maximumBytes: number
): Promise<FormData> {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
		throw new BoundedFormError('FORM_BODY_INVALID');
	}
	const declared = request.headers.get('content-length');
	if (declared !== null) {
		if (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes) {
			throw new BoundedFormError('FORM_BODY_TOO_LARGE');
		}
	}

	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	const reader = request.body?.getReader();
	if (reader) {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				byteLength += value.byteLength;
				if (byteLength > maximumBytes) {
					await reader.cancel();
					throw new BoundedFormError('FORM_BODY_TOO_LARGE');
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return await new Request(request.url, {
			method: 'POST',
			headers: request.headers,
			body: bytes
		}).formData();
	} catch (error) {
		if (error instanceof BoundedFormError) throw error;
		throw new BoundedFormError('FORM_BODY_INVALID');
	}
}
