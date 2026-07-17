import type { StyriaOrder, StyriaOrderPayload } from './types';

export interface StyriaGateway {
	searchByExternalId(
		externalId: string,
		createdAfter: Date,
		signal?: AbortSignal
	): Promise<StyriaOrder[]>;
	create(payload: StyriaOrderPayload, signal?: AbortSignal): Promise<StyriaOrder>;
	get(orderId: string, signal?: AbortSignal): Promise<StyriaOrder>;
}

export type StyriaErrorCode =
	| 'STYRIA_TIMEOUT'
	| 'STYRIA_RATE_LIMITED'
	| 'STYRIA_UNAVAILABLE'
	| 'STYRIA_REQUEST_REJECTED'
	| 'STYRIA_RESPONSE_INVALID';

export class StyriaError extends Error {
	constructor(readonly code: StyriaErrorCode) {
		super(code);
		this.name = 'StyriaError';
	}
}
