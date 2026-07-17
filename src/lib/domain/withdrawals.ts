import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';

export type WithdrawalScope = 'entire_order' | 'specific_items';
export type WithdrawalStatus =
	'submitted' | 'reviewing' | 'awaiting_return' | 'ineligible' | 'support_handling' | 'closed';
export type WithdrawalEligibility =
	'pending' | 'eligible_eu' | 'ineligible_non_eu' | 'support_handling';
export type WithdrawalItem = { description: string; quantity: number };

export type CanonicalWithdrawalInput = {
	fullName: string;
	receiptEmail: string;
	enteredOrderReference: string;
	scope: WithdrawalScope;
	items: WithdrawalItem[];
};

export type WithdrawalPayloadV1 = {
	fullName: string;
	receiptEmail: string;
	enteredOrderReference: string;
	items: WithdrawalItem[];
	reconciliation: null | {
		internalOrderReference: string;
		countryCode: string;
		customerInstructions: string | null;
		returnOutcome: null | 'parcel_received' | 'return_waived' | 'return_not_received';
		parcelReference: string | null;
	};
};

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const EMAIL_LOCAL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u;
const EMAIL_DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const ITEM_MARKUP_PATTERN = /[<>]/u;
const ITEM_URL_PATTERN = /(?:\bhttps?:\/\/|\bwww\.)/iu;

function invalidInput(): never {
	throw new Error('WITHDRAWAL_INPUT_INVALID');
}

function invalidItems(): never {
	throw new Error('WITHDRAWAL_ITEMS_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function characterLength(value: string): number {
	return Array.from(value).length;
}

function normalizeText(value: unknown, maximum: number, failure: () => never): string {
	if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) failure();
	const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
	if (normalized.length === 0 || characterLength(normalized) > maximum) failure();
	return normalized;
}

function normalizeEmail(value: unknown): string {
	if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) invalidInput();
	const trimmed = value.normalize('NFC').trim();
	if (trimmed.length === 0 || characterLength(trimmed) > 320 || /\s/u.test(trimmed)) {
		invalidInput();
	}
	const separator = trimmed.indexOf('@');
	if (separator < 1 || separator !== trimmed.lastIndexOf('@')) invalidInput();
	const localPart = trimmed.slice(0, separator);
	const domain = trimmed.slice(separator + 1);
	if (
		!EMAIL_LOCAL_PATTERN.test(localPart) ||
		localPart.startsWith('.') ||
		localPart.endsWith('.') ||
		localPart.includes('..')
	) {
		invalidInput();
	}
	const labels = domain.split('.');
	if (labels.length < 2 || labels.some((label) => !EMAIL_DOMAIN_LABEL_PATTERN.test(label))) {
		invalidInput();
	}
	return `${localPart}@${domain.toLowerCase()}`;
}

function normalizeItems(value: unknown): WithdrawalItem[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 20) invalidItems();
	return value.map((item) => {
		if (!isRecord(item)) invalidItems();
		const description = normalizeText(item.description, 300, invalidItems);
		if (ITEM_MARKUP_PATTERN.test(description) || ITEM_URL_PATTERN.test(description)) invalidItems();
		if (
			!Number.isInteger(item.quantity) ||
			(item.quantity as number) < 1 ||
			(item.quantity as number) > 99
		) {
			invalidItems();
		}
		return { description, quantity: item.quantity as number };
	});
}

export function normalizeWithdrawalInput(input: unknown): CanonicalWithdrawalInput {
	if (!isRecord(input)) invalidInput();
	const fullName = normalizeText(input.fullName, 200, invalidInput);
	const receiptEmail = normalizeEmail(input.receiptEmail);
	const enteredOrderReference = normalizeText(input.enteredOrderReference, 200, invalidInput);
	if (input.scope !== 'entire_order' && input.scope !== 'specific_items') invalidInput();
	const scope = input.scope;
	const items = scope === 'entire_order' ? [] : normalizeItems(input.items);
	return { fullName, receiptEmail, enteredOrderReference, scope, items };
}

export function stableWithdrawalJson(input: CanonicalWithdrawalInput): string {
	return JSON.stringify({
		fullName: input.fullName,
		receiptEmail: input.receiptEmail,
		enteredOrderReference: input.enteredOrderReference,
		scope: input.scope,
		items: input.items.map(({ description, quantity }) => ({ description, quantity }))
	});
}

export function generateWithdrawalReference(
	randomBytes: (size: number) => Buffer = nodeRandomBytes
): string {
	try {
		const bytes = randomBytes(16);
		if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
			throw new Error('WITHDRAWAL_REFERENCE_INVALID');
		}
		return `WDR-${bytes.toString('base64url')}`;
	} catch {
		throw new Error('WITHDRAWAL_REFERENCE_INVALID');
	}
}
