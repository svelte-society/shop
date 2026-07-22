import { nodeFetch } from '$lib/server/http/node-fetch.server';
import { normalizeHttpsProviderBaseUrl } from '$lib/server/http/provider-url.server';
import type { StyriaGateway } from './gateway';
import { StyriaError } from './gateway';
import { signGet, signPost } from './signing';
import type { StyriaOrder, StyriaOrderPayload } from './types';

export { StyriaError } from './gateway';

export const STYRIA_DEFAULT_BASE_URL = 'https://styriashirts.eu';
export const STYRIA_DEFAULT_TIMEOUT_MS = 10_000;

export type StyriaClientOptions = {
	appId: string;
	secretKey: string;
	baseUrl?: string;
	timeoutMs?: number;
	fetch?: typeof globalThis.fetch;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactString(value: unknown, maxLength = 2_000): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maxLength &&
		value === value.trim() &&
		!/\r|\n/.test(value)
	);
}

function normalizedId(value: unknown): string | null {
	if (isExactString(value, 200)) return value;
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
	return null;
}

function normalizedPositiveInteger(value: unknown): number | null {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
	if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed)) return parsed;
	}
	return null;
}

function normalizedMoney(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,5})?$/.test(value)) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function decodeHtmlText(value: string): string | null {
	try {
		const decoded = value.replace(
			/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|amp|lt|gt|quot|apos);/gi,
			(entity, decimal: string | undefined, hexadecimal: string | undefined) => {
				if (decimal) return String.fromCodePoint(Number(decimal));
				if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
				const named = entity.slice(1, -1).toLowerCase();
				return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named] ?? entity;
			}
		);
		return isExactString(decoded, 500) ? decoded : null;
	} catch {
		return null;
	}
}

function normalizedDescription(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 2_000) return null;
	const instructions = value.match(
		/<li\s+data-note=(?:"instructions"|'instructions')>Note:\s*([^<]{1,500})<\/li>/i
	);
	return instructions ? decodeHtmlText(instructions[1]) : value;
}

function normalizedBoolean(value: unknown): boolean | null {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	if (value === 'false') return false;
	return null;
}

function optionalString(value: unknown, maxLength = 2_000): string | null | undefined {
	if (value === undefined || value === null || value === '') return null;
	if (isExactString(value, maxLength)) return value;
	return undefined;
}

function isTimestamp(value: unknown): value is string {
	return isExactString(value, 100) && Number.isFinite(new Date(value).getTime());
}

function normalizeDesigns(value: unknown): Record<string, string> | null {
	let entries: Array<[string, string]>;
	if (Array.isArray(value)) {
		entries = [];
		for (const design of value) {
			if (!isRecord(design) || !isExactString(design.title, 100) || !isExactString(design.src)) {
				return null;
			}
			entries.push([design.title, design.src]);
		}
	} else if (isRecord(value)) {
		entries = Object.entries(value) as Array<[string, string]>;
	} else {
		return null;
	}
	entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	if (
		entries.length === 0 ||
		entries.some(
			([position, url], index) =>
				!isExactString(position, 100) ||
				!isExactString(url, 2_000) ||
				(index > 0 && entries[index - 1][0] === position)
		)
	) {
		return null;
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

function normalizeOrder(value: unknown): StyriaOrder | null {
	if (!isRecord(value)) return null;
	const id = normalizedId(value.id);
	const externalId = optionalString(value.external_id, 200);
	const deleted = normalizedBoolean(value.deleted);
	if (
		id === null ||
		externalId === undefined ||
		!isTimestamp(value.created_at) ||
		!isExactString(value.status, 100) ||
		deleted === null ||
		!isRecord(value.shipping_address) ||
		!isExactString(value.shipping_address.country, 200) ||
		!isRecord(value.shipping) ||
		!isExactString(value.shipping.shippingMethod, 100) ||
		!Array.isArray(value.items) ||
		value.items.length === 0
	) {
		return null;
	}

	const trackingNumber = optionalString(value.shipping.trackingNumber, 500);
	const shippedAt = optionalString(value.shipping.shipped_at ?? value.shipping.shiped_at, 100);
	if (trackingNumber === undefined || shippedAt === undefined) return null;
	if (shippedAt !== null && !isTimestamp(shippedAt)) return null;

	const items: StyriaOrder['items'] = [];
	for (const item of value.items) {
		if (!isRecord(item)) return null;
		const quantity = normalizedPositiveInteger(item.quantity);
		const retailPrice = normalizedMoney(item.retailPrice);
		const description = normalizedDescription(item.description);
		const designs = normalizeDesigns(item.designs);
		if (
			!isExactString(item.pn, 200) ||
			quantity === null ||
			retailPrice === null ||
			description === null ||
			designs === null
		) {
			return null;
		}
		items.push({
			pn: item.pn,
			quantity,
			retailPrice,
			description,
			designs
		});
	}

	return {
		id,
		external_id: externalId,
		created_at: value.created_at,
		status: value.status,
		deleted,
		shipping_address: { country: value.shipping_address.country },
		shipping: {
			shippingMethod: value.shipping.shippingMethod,
			trackingNumber,
			shiped_at: shippedAt
		},
		items
	};
}

function normalizeOrderList(value: unknown): StyriaOrder[] | null {
	const candidates = isRecord(value) ? value.orders : value;
	if (!Array.isArray(candidates)) return null;
	const orders: StyriaOrder[] = [];
	for (const candidate of candidates) {
		const order = normalizeOrder(
			isRecord(candidate) && Object.hasOwn(candidate, 'order') ? candidate.order : candidate
		);
		if (order === null) return null;
		orders.push(order);
	}
	return orders;
}

function normalizeOrderEnvelope(value: unknown): StyriaOrder | null {
	return normalizeOrder(isRecord(value) && Object.hasOwn(value, 'order') ? value.order : value);
}

function httpError(status: number): StyriaError {
	if (status === 429) return new StyriaError('STYRIA_RATE_LIMITED');
	if (status >= 500) return new StyriaError('STYRIA_UNAVAILABLE');
	return new StyriaError('STYRIA_REQUEST_REJECTED');
}

function invalidRequest(): never {
	throw new StyriaError('STYRIA_REQUEST_REJECTED');
}

class HttpStyriaClient implements StyriaGateway {
	private readonly baseUrl: string;
	private readonly fetch: typeof globalThis.fetch;
	private readonly timeoutMs: number;

	constructor(private readonly options: StyriaClientOptions) {
		if (
			!isExactString(options.appId, 200) ||
			!isExactString(options.secretKey, 500) ||
			(options.timeoutMs !== undefined &&
				(!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))
		) {
			invalidRequest();
		}
		const baseUrl = normalizeHttpsProviderBaseUrl(options.baseUrl ?? STYRIA_DEFAULT_BASE_URL);
		if (baseUrl === null) invalidRequest();
		this.baseUrl = baseUrl;
		this.fetch = options.fetch ?? nodeFetch;
		this.timeoutMs = options.timeoutMs ?? STYRIA_DEFAULT_TIMEOUT_MS;
	}

	private async requestJson(
		url: string,
		init: RequestInit,
		signal?: AbortSignal
	): Promise<unknown> {
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
				response = await this.fetch(url, { ...init, signal: controller.signal });
			} catch {
				throw new StyriaError(timedOut ? 'STYRIA_TIMEOUT' : 'STYRIA_UNAVAILABLE');
			}
			if (!response.ok) throw httpError(response.status);

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new StyriaError(timedOut ? 'STYRIA_TIMEOUT' : 'STYRIA_RESPONSE_INVALID');
			}
			if (
				isRecord(payload) &&
				typeof payload.error === 'string' &&
				payload.error.trim().length > 0
			) {
				throw new StyriaError('STYRIA_REQUEST_REJECTED');
			}
			return payload;
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', abortFromCaller);
		}
	}

	private signedGetUrl(path: string, parameters: Record<string, string>): string {
		const unsignedParameters = new URLSearchParams();
		for (const [key, value] of Object.entries({ AppId: this.options.appId, ...parameters }).sort(
			([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)
		)) {
			unsignedParameters.append(key, value);
		}
		const unsignedQuery = unsignedParameters.toString();
		return `${this.baseUrl}${path}?${unsignedQuery}&Signature=${signGet(
			unsignedQuery,
			this.options.secretKey
		)}`;
	}

	async searchByExternalId(
		externalId: string,
		createdAfter: Date,
		signal?: AbortSignal
	): Promise<StyriaOrder[]> {
		if (
			!isExactString(externalId, 200) ||
			!(createdAfter instanceof Date) ||
			!Number.isFinite(createdAfter.getTime())
		) {
			invalidRequest();
		}
		const matches: StyriaOrder[] = [];
		let page = 1;
		while (Number.isSafeInteger(page)) {
			const payload = await this.requestJson(
				this.signedGetUrl('/api/orders.php', {
					created_at_min: createdAfter.toISOString(),
					format: 'json',
					limit: '250',
					page: String(page)
				}),
				{ method: 'GET' },
				signal
			);
			const orders = normalizeOrderList(payload);
			if (orders === null) throw new StyriaError('STYRIA_RESPONSE_INVALID');
			matches.push(...orders.filter((order) => order.external_id === externalId));
			if (orders.length < 250) return matches;
			page += 1;
		}
		throw new StyriaError('STYRIA_RESPONSE_INVALID');
	}

	async create(payload: StyriaOrderPayload, signal?: AbortSignal): Promise<StyriaOrder> {
		let body: string;
		try {
			body = JSON.stringify(payload);
		} catch {
			invalidRequest();
		}
		const appIdQuery = new URLSearchParams({ AppId: this.options.appId }).toString();
		const response = await this.requestJson(
			`${this.baseUrl}/api/orders.php?${appIdQuery}&Signature=${signPost(
				body,
				this.options.secretKey
			)}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body
			},
			signal
		);
		const order = normalizeOrderEnvelope(response);
		if (order === null) throw new StyriaError('STYRIA_RESPONSE_INVALID');
		return order;
	}

	async get(orderId: string, signal?: AbortSignal): Promise<StyriaOrder> {
		if (!isExactString(orderId, 200)) invalidRequest();
		const response = await this.requestJson(
			this.signedGetUrl('/api/order.php', { format: 'json', id: orderId }),
			{ method: 'GET' },
			signal
		);
		const order = normalizeOrderEnvelope(response);
		if (order === null) throw new StyriaError('STYRIA_RESPONSE_INVALID');
		return order;
	}
}

export function createStyriaClient(options: StyriaClientOptions): StyriaGateway {
	return new HttpStyriaClient(options);
}
