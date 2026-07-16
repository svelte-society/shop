import type { PlunkGateway, PlunkSendInput } from './gateway';
import { PlunkError } from './gateway';

export { PlunkError } from './gateway';

export const PLUNK_DEFAULT_BASE_URL = 'https://next-api.useplunk.com';
export const PLUNK_DEFAULT_TIMEOUT_MS = 10_000;

export type PlunkClientOptions = {
	secretKey: string;
	baseUrl?: string;
	timeoutMs?: number;
	fetch?: typeof globalThis.fetch;
};

type PlunkSendResponse = {
	success: true;
	data: {
		emails: [{ email: string }];
	};
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSendResponse(value: unknown): value is PlunkSendResponse {
	if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return false;
	const emails = value.data.emails;
	if (!Array.isArray(emails) || emails.length !== 1 || !isRecord(emails[0])) return false;
	return typeof emails[0].email === 'string' && emails[0].email.trim().length > 0;
}

function httpError(status: number): PlunkError {
	if (status === 429) return new PlunkError('PLUNK_RATE_LIMITED');
	if (status >= 500) return new PlunkError('PLUNK_UNAVAILABLE');
	return new PlunkError('PLUNK_REQUEST_REJECTED');
}

class HttpPlunkClient implements PlunkGateway {
	private readonly endpoint: string;
	private readonly fetch: typeof globalThis.fetch;
	private readonly timeoutMs: number;

	constructor(private readonly options: PlunkClientOptions) {
		this.endpoint = `${(options.baseUrl ?? PLUNK_DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/send`;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? PLUNK_DEFAULT_TIMEOUT_MS;
	}

	async send(input: PlunkSendInput): Promise<{ deliveryId: string }> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		timeout.unref?.();

		try {
			let response: Response;
			try {
				response = await this.fetch(this.endpoint, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${this.options.secretKey}`,
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						to: input.to,
						from: input.from,
						reply: input.replyTo,
						subject: input.subject,
						body: input.html
					}),
					signal: controller.signal
				});
			} catch {
				throw new PlunkError(controller.signal.aborted ? 'PLUNK_TIMEOUT' : 'PLUNK_UNAVAILABLE');
			}

			if (!response.ok) throw httpError(response.status);

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new PlunkError(
					controller.signal.aborted ? 'PLUNK_TIMEOUT' : 'PLUNK_RESPONSE_INVALID'
				);
			}

			if (!isSendResponse(payload)) throw new PlunkError('PLUNK_RESPONSE_INVALID');
			return { deliveryId: payload.data.emails[0].email };
		} finally {
			clearTimeout(timeout);
		}
	}
}

export function createPlunkClient(options: PlunkClientOptions): PlunkGateway {
	return new HttpPlunkClient(options);
}
