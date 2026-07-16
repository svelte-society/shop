import { createHash } from 'node:crypto';
import type { OrderWithLines } from '$lib/domain/orders';
import type { StyriaOrderPayload } from './types';

const COUNTRY_NAMES = Object.freeze({
	AT: 'Austria',
	BE: 'Belgium',
	BG: 'Bulgaria',
	HR: 'Croatia',
	CY: 'Cyprus',
	CZ: 'Czechia',
	DK: 'Denmark',
	EE: 'Estonia',
	FI: 'Finland',
	FR: 'France',
	DE: 'Germany',
	GR: 'Greece',
	HU: 'Hungary',
	IE: 'Ireland',
	IT: 'Italy',
	LV: 'Latvia',
	LT: 'Lithuania',
	LU: 'Luxembourg',
	MT: 'Malta',
	NL: 'Netherlands',
	PL: 'Poland',
	PT: 'Portugal',
	RO: 'Romania',
	SK: 'Slovakia',
	ES: 'Spain',
	SE: 'Sweden',
	US: 'United States'
} satisfies Record<string, string>);

const DESIGN_POSITION = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export type StyriaFulfillmentDetails = {
	recipient: { firstName: string; lastName: string; company: string; phone: string };
	address: {
		line1: string;
		line2: string;
		city: string;
		state: string;
		postalCode: string;
		countryCode: string;
	};
};

export class StyriaPayloadError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'StyriaPayloadError';
	}
}

function fail(code: string): never {
	throw new StyriaPayloadError(code);
}

function isExactString(value: unknown, maxLength = 500): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maxLength &&
		value === value.trim() &&
		!/\r|\n/.test(value)
	);
}

function isOptionalExactString(value: unknown, maxLength = 500): value is string {
	return value === '' || isExactString(value, maxLength);
}

function isHttpsUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.username === '' && url.password === '';
	} catch {
		return false;
	}
}

function countryName(code: string): string {
	if (!Object.hasOwn(COUNTRY_NAMES, code)) fail('STYRIA_COUNTRY_UNSUPPORTED');
	return COUNTRY_NAMES[code as keyof typeof COUNTRY_NAMES];
}

export function buildStyriaPayload(input: {
	order: OrderWithLines;
	fulfillment: StyriaFulfillmentDetails;
	brandName: string;
	comment: string;
}): StyriaOrderPayload {
	const { order, fulfillment } = input;
	const { recipient, address } = fulfillment;
	if (
		!isExactString(recipient.firstName, 200) ||
		!isExactString(recipient.lastName, 200) ||
		!isOptionalExactString(recipient.company, 200) ||
		!isExactString(recipient.phone, 100) ||
		!isExactString(address.line1, 500) ||
		!isOptionalExactString(address.line2, 500) ||
		!isExactString(address.city, 200) ||
		!isOptionalExactString(address.state, 200) ||
		!isExactString(address.postalCode, 100) ||
		!isExactString(address.countryCode, 2) ||
		(address.countryCode === 'US' && address.state === '')
	) {
		fail('STYRIA_FULFILLMENT_INVALID');
	}
	if (order.destinationCountry !== address.countryCode) fail('STYRIA_FULFILLMENT_INVALID');
	const fullCountryName = countryName(address.countryCode);

	if (
		!isExactString(order.checkoutSessionId, 200) ||
		order.currency !== 'eur' ||
		!Array.isArray(order.lines) ||
		order.lines.length === 0 ||
		!isExactString(input.brandName, 200) ||
		!isExactString(input.comment, 500)
	) {
		fail('STYRIA_ORDER_SNAPSHOT_INVALID');
	}

	const seenLineIndexes = new Set<number>();
	const lines = [...order.lines].sort((left, right) => left.lineIndex - right.lineIndex);
	const items = lines.map((line) => {
		if (
			line.orderId !== order.id ||
			!Number.isSafeInteger(line.lineIndex) ||
			line.lineIndex < 0 ||
			seenLineIndexes.has(line.lineIndex) ||
			!isExactString(line.styriaProductNumber, 200) ||
			!Number.isSafeInteger(line.quantity) ||
			line.quantity < 1 ||
			!Number.isSafeInteger(line.unitAmount) ||
			line.unitAmount < 1 ||
			line.currency !== 'eur' ||
			!isExactString(line.designReference, 500) ||
			typeof line.designPlacements !== 'object' ||
			line.designPlacements === null
		) {
			fail('STYRIA_ORDER_SNAPSHOT_INVALID');
		}
		seenLineIndexes.add(line.lineIndex);

		const designEntries = Object.entries(line.designPlacements).sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0
		);
		if (
			designEntries.length === 0 ||
			designEntries.some(
				([position, url]) =>
					!DESIGN_POSITION.test(position) || !isExactString(url, 2_000) || !isHttpsUrl(url)
			)
		) {
			fail('STYRIA_ORDER_SNAPSHOT_INVALID');
		}

		return {
			pn: line.styriaProductNumber,
			quantity: line.quantity,
			retailPrice: line.unitAmount / 100,
			description: `Design reference: ${line.designReference}`,
			designs: Object.fromEntries(designEntries)
		};
	});

	return {
		external_id: order.checkoutSessionId,
		brandName: input.brandName,
		comment: input.comment,
		shipping_address: {
			firstName: recipient.firstName,
			lastName: recipient.lastName,
			company: recipient.company,
			address1: address.line1,
			address2: address.line2,
			city: address.city,
			county: address.state,
			postcode: address.postalCode,
			country: fullCountryName,
			phone1: recipient.phone
		},
		shipping: { shippingMethod: 'courier' },
		items
	};
}

function canonicalize(value: unknown, ancestors: WeakSet<object>): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) fail('STYRIA_CANONICAL_JSON_INVALID');
		return JSON.stringify(value);
	}
	if (typeof value !== 'object') fail('STYRIA_CANONICAL_JSON_INVALID');
	if (ancestors.has(value)) fail('STYRIA_CANONICAL_JSON_INVALID');
	ancestors.add(value);

	try {
		if (Array.isArray(value)) {
			return `[${value.map((item) => canonicalize(item, ancestors)).join(',')}]`;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			fail('STYRIA_CANONICAL_JSON_INVALID');
		}
		const keys = Object.keys(value).sort();
		if (Reflect.ownKeys(value).length !== keys.length) fail('STYRIA_CANONICAL_JSON_INVALID');
		return `{${keys
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key], ancestors)}`
			)
			.join(',')}}`;
	} finally {
		ancestors.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	return canonicalize(value, new WeakSet());
}

export function hashStyriaPayload(payload: StyriaOrderPayload): string {
	return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}
