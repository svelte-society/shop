import { env } from '$env/dynamic/private';
import { fail, type Cookies, type RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeWithdrawalInput, type CanonicalWithdrawalInput } from '$lib/domain/withdrawals';
import { applicationLifecycle, type WithdrawalRuntime } from '$lib/server/app.server';
import { readBoundedFormData, BoundedFormError } from '$lib/server/security/bounded-form.server';
import {
	createSecurityConfig,
	normalizeClientAddress,
	validateHostAndOrigin
} from '$lib/server/security/host-origin.server';
import { createFixedWindowRateLimiter } from '$lib/server/security/rate-limit.server';
import {
	createReceiptSession,
	WITHDRAWAL_RECEIPT_COOKIE,
	WITHDRAWAL_RECEIPT_MAX_AGE_SECONDS
} from '$lib/server/withdrawals/receipt.server';

const CSRF_COOKIE = 'withdrawal_csrf';
const CSRF_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FORM_LIMIT = 65_536;
const MAX_FIELDS = 100;
const MAX_ITEMS = 20;
const CONFIRM_POLICY = { limit: 5, windowMs: 15 * 60_000 } as const;

type RawFields = {
	fullName: string;
	receiptEmail: string;
	enteredOrderReference: string;
	scope: string;
	itemDescriptions: string[];
	itemQuantities: string[];
};

type PageDependencies = {
	environment: Record<string, string | undefined>;
	production: boolean;
	now: () => Date;
	getRuntime: () => Pick<WithdrawalRuntime, 'submission' | 'dataKey'> | null;
};

function csrfCookieOptions(secure: boolean) {
	return { httpOnly: true, sameSite: 'strict' as const, secure, path: '/withdraw', maxAge: 1_800 };
}

export function _issueOrReuseWithdrawalCsrf(cookies: Cookies, secure: boolean): string {
	const existing = cookies.get(CSRF_COOKIE);
	if (existing && CSRF_PATTERN.test(existing)) return existing;
	const token = randomBytes(32).toString('base64url');
	cookies.set(CSRF_COOKIE, token, csrfCookieOptions(secure));
	return token;
}

function exactText(data: FormData, name: string): string {
	const values = data.getAll(name);
	return values.length === 1 && typeof values[0] === 'string' ? values[0] : '';
}

function rawFields(data: FormData): RawFields {
	return {
		fullName: exactText(data, 'fullName'),
		receiptEmail: exactText(data, 'receiptEmail'),
		enteredOrderReference: exactText(data, 'enteredOrderReference'),
		scope: exactText(data, 'scope'),
		itemDescriptions: data
			.getAll('itemDescription')
			.map((value) => (typeof value === 'string' ? value : '')),
		itemQuantities: data
			.getAll('itemQuantity')
			.map((value) => (typeof value === 'string' ? value : ''))
	};
}

function itemStructureError(fields: RawFields): string | undefined {
	if (
		fields.itemDescriptions.length > MAX_ITEMS ||
		fields.itemQuantities.length > MAX_ITEMS ||
		fields.itemDescriptions.length !== fields.itemQuantities.length
	) {
		return 'Add between 1 and 20 item rows.';
	}
}

function fieldErrors(fields: RawFields): Record<string, string> {
	const errors: Record<string, string> = {};
	const structureError = itemStructureError(fields);
	if (structureError) errors.items = structureError;
	if (!fields.fullName.trim()) errors.fullName = 'Enter your full name.';
	if (!/^\S+@[^\s@]+\.[^\s@]+$/u.test(fields.receiptEmail.trim()))
		errors.receiptEmail = 'Enter a valid email address.';
	if (!fields.enteredOrderReference.trim())
		errors.enteredOrderReference = 'Enter the order reference from your purchase.';
	if (fields.scope !== 'entire_order' && fields.scope !== 'specific_items')
		errors.scope = 'Choose the whole purchase or specific items.';
	if (fields.scope === 'specific_items') {
		if (fields.itemDescriptions.length < 1) errors.items = 'Add between 1 and 20 item rows.';
		if (!structureError) {
			fields.itemDescriptions.forEach((description, index) => {
				if (!description.trim()) errors[`itemDescription-${index}`] = 'Describe this item.';
				const quantity = Number(fields.itemQuantities[index]);
				if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99)
					errors[`itemQuantity-${index}`] = 'Enter a quantity from 1 to 99.';
			});
		}
	}
	return errors;
}

function canonical(fields: RawFields): {
	value?: CanonicalWithdrawalInput;
	errors: Record<string, string>;
} {
	const errors = fieldErrors(fields);
	if (Object.keys(errors).length) return { errors };
	try {
		return {
			value: normalizeWithdrawalInput({
				fullName: fields.fullName,
				receiptEmail: fields.receiptEmail,
				enteredOrderReference: fields.enteredOrderReference,
				scope: fields.scope,
				items: fields.itemDescriptions.map((description, index) => ({
					description,
					quantity: Number(fields.itemQuantities[index])
				}))
			}),
			errors: {}
		};
	} catch {
		return { errors: { form: 'Check the entered details and try again.' } };
	}
}

function validCsrf(cookies: Cookies, supplied: string): boolean {
	const stored = cookies.get(CSRF_COOKIE);
	if (!stored || !CSRF_PATTERN.test(stored) || !CSRF_PATTERN.test(supplied)) return false;
	return timingSafeEqual(Buffer.from(stored, 'base64url'), Buffer.from(supplied, 'base64url'));
}

export function _createWithdrawalPage(overrides: Partial<PageDependencies> = {}) {
	const dependencies: PageDependencies = {
		environment: env,
		production: process.env.NODE_ENV === 'production',
		now: () => new Date(),
		getRuntime: () => applicationLifecycle.current()?.withdrawal ?? null,
		...overrides
	};
	const limiter = createFixedWindowRateLimiter();

	const load: PageServerLoad = async ({ cookies, url }) => ({
		csrfToken: _issueOrReuseWithdrawalCsrf(cookies, url.protocol === 'https:'),
		itemRowCount: 1
	});

	async function read(event: RequestEvent): Promise<FormData | ReturnType<typeof fail>> {
		try {
			if (dependencies.production)
				validateHostAndOrigin(event.request, createSecurityConfig(dependencies.environment, true));
			const data = await readBoundedFormData(event.request, FORM_LIMIT);
			if ([...data.entries()].length > MAX_FIELDS)
				return fail(400, { message: 'Invalid form submission.' });
			if (!validCsrf(event.cookies, exactText(data, 'csrfToken')))
				return fail(403, { message: 'This form expired. Reload the page and try again.' });
			return data;
		} catch (error) {
			if (error instanceof BoundedFormError && error.code === 'FORM_BODY_TOO_LARGE')
				return fail(413, { message: 'Form submission is too large.' });
			return fail(
				error && typeof error === 'object' && 'status' in error ? Number(error.status) : 400,
				{ message: 'Invalid form submission.' }
			);
		}
	}

	function validationFailure(fields: RawFields, errors: Record<string, string>) {
		return fail(400, {
			fields,
			errors,
			itemRowCount: Math.min(MAX_ITEMS, Math.max(1, fields.itemDescriptions.length)),
			errorSummary: true
		});
	}

	const addItem = async (event: RequestEvent) => {
		const parsed = await read(event);
		if (!(parsed instanceof FormData)) return parsed;
		const fields = rawFields(parsed);
		const structureError = itemStructureError(fields);
		if (structureError) return validationFailure(fields, { items: structureError });
		if (fields.itemDescriptions.length >= MAX_ITEMS)
			return validationFailure(fields, { items: 'You can add up to 20 item rows.' });
		fields.itemDescriptions.push('');
		fields.itemQuantities.push('1');
		return { fields, itemRowCount: fields.itemDescriptions.length };
	};

	const removeItem = async (event: RequestEvent) => {
		const parsed = await read(event);
		if (!(parsed instanceof FormData)) return parsed;
		const fields = rawFields(parsed);
		const structureError = itemStructureError(fields);
		if (structureError) return validationFailure(fields, { items: structureError });
		const index = Number(exactText(parsed, 'removeIndex'));
		if (
			Number.isInteger(index) &&
			index >= 0 &&
			index < fields.itemDescriptions.length &&
			fields.itemDescriptions.length > 1
		) {
			fields.itemDescriptions.splice(index, 1);
			fields.itemQuantities.splice(index, 1);
		}
		return {
			fields,
			itemRowCount: Math.min(MAX_ITEMS, Math.max(1, fields.itemDescriptions.length))
		};
	};

	const review = async (event: RequestEvent) => {
		const parsed = await read(event);
		if (!(parsed instanceof FormData)) return parsed;
		const fields = rawFields(parsed);
		const checked = canonical(fields);
		if (!checked.value) return validationFailure(fields, checked.errors);
		return {
			fields,
			itemRowCount: Math.max(1, fields.itemDescriptions.length),
			review: checked.value
		};
	};

	const confirm = async (event: RequestEvent) => {
		const parsed = await read(event);
		if (!(parsed instanceof FormData)) return parsed;
		const fields = rawFields(parsed);
		const checked = canonical(fields);
		if (!checked.value) return validationFailure(fields, checked.errors);
		let address: string;
		try {
			address = normalizeClientAddress(event.getClientAddress());
		} catch {
			return fail(400, { message: 'Invalid form submission.' });
		}
		if (!limiter.take(`withdraw:${address}`, CONFIRM_POLICY, dependencies.now().getTime()))
			return fail(429, { message: 'Too many attempts. Wait 15 minutes and try again.' });
		const runtime = dependencies.getRuntime();
		if (!runtime)
			return fail(503, {
				message: 'Withdrawal notices are temporarily unavailable. Try again shortly.'
			});
		try {
			const submission = await runtime.submission.submit(checked.value, dependencies.now());
			const token = createReceiptSession(submission.reference, dependencies.now(), runtime.dataKey);
			event.cookies.set(WITHDRAWAL_RECEIPT_COOKIE, token, {
				httpOnly: true,
				sameSite: 'strict',
				secure: dependencies.production || event.url.protocol === 'https:',
				path: `/withdraw/receipt/${submission.reference}`,
				maxAge: WITHDRAWAL_RECEIPT_MAX_AGE_SECONDS
			});
			return {
				success: true,
				result: { ...submission, createdAt: submission.createdAt.toISOString() }
			};
		} catch {
			return fail(503, {
				message: 'Withdrawal notices are temporarily unavailable. Try again shortly.'
			});
		}
	};

	return { load, actions: { addItem, removeItem, review, confirm } satisfies Actions };
}

const page = _createWithdrawalPage();
export const load = page.load;
export const actions = page.actions;
