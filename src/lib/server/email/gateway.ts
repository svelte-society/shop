export type EmailSendInput = {
	to: string;
	from: { name: string; email: string };
	replyTo: string;
	subject: string;
	html: string;
	/** Durable logical delivery key. Adapters may combine it with the exact payload. */
	idempotencyKey: string;
};

export interface EmailGateway {
	send(input: EmailSendInput, signal?: AbortSignal): Promise<{ deliveryId: string }>;
}

export type EmailGatewayErrorCode =
	| 'EMAIL_TIMEOUT'
	| 'EMAIL_RATE_LIMITED'
	| 'EMAIL_UNAVAILABLE'
	| 'EMAIL_CONFIGURATION_INVALID'
	| 'EMAIL_REQUEST_REJECTED'
	| 'EMAIL_RESPONSE_INVALID';

export class EmailGatewayError extends Error {
	constructor(readonly code: EmailGatewayErrorCode) {
		super(code);
		this.name = 'EmailGatewayError';
	}
}
