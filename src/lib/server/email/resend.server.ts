import { createHash } from 'node:crypto';
import { nodeFetch } from '$lib/server/http/node-fetch.server';
import { normalizeHttpsProviderBaseUrl } from '$lib/server/http/provider-url.server';
import type { EmailGateway, EmailSendInput } from './gateway';
import { EmailGatewayError } from './gateway';

export const RESEND_DEFAULT_BASE_URL = 'https://api.resend.com';
export const RESEND_DEFAULT_TIMEOUT_MS = 10_000;

export type ResendEmailGatewayOptions = {
	apiKey: string;
	baseUrl?: string;
	timeoutMs?: number;
	fetch?: typeof globalThis.fetch;
};

type ResendSendResponse = {
	id: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSendResponse(value: unknown): value is ResendSendResponse {
	return isRecord(value) && typeof value.id === 'string' && value.id.trim().length > 0;
}

function isRetryableConflict(value: unknown): boolean {
	return (
		isRecord(value) &&
		(value.name === 'concurrent_idempotent_requests' || value.name === 'resource_locked')
	);
}

function invalidRequest(): never {
	throw new EmailGatewayError('EMAIL_REQUEST_REJECTED');
}

function exactHeaderValue(value: unknown, maximum: number): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum &&
		value === value.trim() &&
		!/[\r\n]/u.test(value)
	);
}

function validateInput(input: EmailSendInput): void {
	if (
		!input ||
		!exactHeaderValue(input.to, 320) ||
		!input.from ||
		!exactHeaderValue(input.from.name, 200) ||
		!exactHeaderValue(input.from.email, 320) ||
		!exactHeaderValue(input.replyTo, 320) ||
		!exactHeaderValue(input.subject, 998) ||
		typeof input.html !== 'string' ||
		input.html.length === 0 ||
		!exactHeaderValue(input.idempotencyKey, 2_000)
	) {
		invalidRequest();
	}
}

function resendFrom(from: EmailSendInput['from']): string {
	const escapedName = from.name.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
	return `"${escapedName}" <${from.email}>`;
}

function resendBody(input: EmailSendInput): string {
	return JSON.stringify({
		to: [input.to],
		from: resendFrom(input.from),
		reply_to: input.replyTo,
		subject: input.subject,
		html: input.html
	});
}

function resendIdempotencyKey(logicalKey: string, body: string): string {
	const digest = createHash('sha256').update(logicalKey).update('\0').update(body).digest('hex');
	return `sha256:${digest}`;
}

class HttpResendEmailGateway implements EmailGateway {
	private readonly endpoint: string;
	private readonly fetch: typeof globalThis.fetch;
	private readonly timeoutMs: number;

	constructor(private readonly options: ResendEmailGatewayOptions) {
		const baseUrl = normalizeHttpsProviderBaseUrl(options.baseUrl ?? RESEND_DEFAULT_BASE_URL);
		if (baseUrl === null || !exactHeaderValue(options.apiKey, 500)) invalidRequest();
		this.endpoint = `${baseUrl}/emails`;
		this.fetch = options.fetch ?? nodeFetch;
		this.timeoutMs = options.timeoutMs ?? RESEND_DEFAULT_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) invalidRequest();
	}

	async send(input: EmailSendInput, signal?: AbortSignal): Promise<{ deliveryId: string }> {
		validateInput(input);
		const body = resendBody(input);
		const idempotencyKey = resendIdempotencyKey(input.idempotencyKey, body);
		const controller = new AbortController();
		let timedOut = false;
		const abortFromCaller = (): void => controller.abort(signal?.reason);
		if (signal?.aborted) abortFromCaller();
		else signal?.addEventListener('abort', abortFromCaller, { once: true });
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeoutMs);
		timeout.unref?.();

		try {
			let response: Response;
			try {
				response = await this.fetch(this.endpoint, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${this.options.apiKey}`,
						'content-type': 'application/json',
						'idempotency-key': idempotencyKey,
						'user-agent': 'svelte-society-shop/0.0.1'
					},
					body,
					signal: controller.signal
				});
			} catch {
				throw new EmailGatewayError(timedOut ? 'EMAIL_TIMEOUT' : 'EMAIL_UNAVAILABLE');
			}

			if (!response.ok) {
				if (response.status === 429) throw new EmailGatewayError('EMAIL_RATE_LIMITED');
				if (response.status >= 500) throw new EmailGatewayError('EMAIL_UNAVAILABLE');
				if ([401, 403, 404, 405, 451].includes(response.status)) {
					throw new EmailGatewayError('EMAIL_CONFIGURATION_INVALID');
				}
				if (response.status === 409) {
					let payload: unknown;
					try {
						payload = await response.json();
					} catch {
						throw new EmailGatewayError(timedOut ? 'EMAIL_TIMEOUT' : 'EMAIL_RESPONSE_INVALID');
					}
					if (isRetryableConflict(payload)) {
						throw new EmailGatewayError('EMAIL_RATE_LIMITED');
					}
					if (isRecord(payload) && payload.name === 'invalid_idempotent_request') {
						throw new EmailGatewayError('EMAIL_REQUEST_REJECTED');
					}
					throw new EmailGatewayError('EMAIL_RESPONSE_INVALID');
				}
				throw new EmailGatewayError('EMAIL_REQUEST_REJECTED');
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new EmailGatewayError(timedOut ? 'EMAIL_TIMEOUT' : 'EMAIL_RESPONSE_INVALID');
			}
			if (!isSendResponse(payload)) throw new EmailGatewayError('EMAIL_RESPONSE_INVALID');
			return { deliveryId: payload.id };
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', abortFromCaller);
		}
	}
}

export function createResendEmailGateway(options: ResendEmailGatewayOptions): EmailGateway {
	return new HttpResendEmailGateway(options);
}
