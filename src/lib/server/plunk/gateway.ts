export type PlunkSendInput = {
	to: string;
	from: { name: string; email: string };
	replyTo: string;
	subject: string;
	html: string;
};

export interface PlunkGateway {
	send(input: PlunkSendInput, signal?: AbortSignal): Promise<{ deliveryId: string }>;
}

export type PlunkErrorCode =
	| 'PLUNK_TIMEOUT'
	| 'PLUNK_RATE_LIMITED'
	| 'PLUNK_UNAVAILABLE'
	| 'PLUNK_REQUEST_REJECTED'
	| 'PLUNK_RESPONSE_INVALID';

export class PlunkError extends Error {
	constructor(readonly code: PlunkErrorCode) {
		super(code);
		this.name = 'PlunkError';
	}
}
