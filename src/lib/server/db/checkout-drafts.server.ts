import { randomUUID } from 'node:crypto';
import type {
	CheckoutDraft,
	CheckoutDraftLine,
	CheckoutDraftWithLines,
	DesignPlacements,
	NewCheckoutDraft,
	NewCheckoutDraftLine
} from '$lib/domain/orders';
import { RepositoryError } from '$lib/domain/orders';
import type { ShopDatabase } from './types';

export interface CheckoutDraftRepository {
	create(input: NewCheckoutDraft): CheckoutDraft;
	attachSession(draftId: string, sessionId: string): void;
	findById(draftId: string): CheckoutDraftWithLines | null;
	markCompleted(draftId: string, completedAt: Date): void;
}

type DraftRow = {
	id: unknown;
	stripe_checkout_session_id: unknown;
	contract_version: unknown;
	currency: unknown;
	total_unit_count: unknown;
	shipping_mode: unknown;
	created_at: unknown;
	expires_at: unknown;
	completed_at: unknown;
};

type DraftLineRow = {
	line_index: unknown;
	stripe_product_id: unknown;
	stripe_price_id: unknown;
	product_name: unknown;
	variant_label: unknown;
	sku: unknown;
	styria_product_number: unknown;
	design_reference: unknown;
	design_json: unknown;
	quantity: unknown;
	unit_amount: unknown;
	currency: unknown;
};

function fail(code: string): never {
	throw new RepositoryError(code);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isoTimestamp(value: Date, invalidCode: string): string {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(invalidCode);
	return value.toISOString();
}

function dateFromIso(value: unknown, invalidCode: string): Date {
	if (typeof value !== 'string') fail(invalidCode);
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(invalidCode);
	return parsed;
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

function canonicalDesignJson(input: unknown, invalidCode: string): string {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(invalidCode);

	let keys: string[];
	try {
		keys = Object.keys(input).sort();
	} catch {
		fail(invalidCode);
	}
	if (keys.length === 0 || keys.some((key) => key.trim().length === 0)) fail(invalidCode);

	const canonical: DesignPlacements = {};
	try {
		for (const key of keys) {
			const value = (input as Record<string, unknown>)[key];
			if (!isNonEmptyString(value) || !isHttpsUrl(value)) fail(invalidCode);
			canonical[key] = value;
		}
		return JSON.stringify(canonical);
	} catch (error) {
		if (error instanceof RepositoryError) throw error;
		fail(invalidCode);
	}
}

function designFromJson(value: unknown, invalidCode: string): DesignPlacements {
	if (typeof value !== 'string') fail(invalidCode);
	try {
		const parsed: unknown = JSON.parse(value);
		const canonical = canonicalDesignJson(parsed, invalidCode);
		if (canonical !== value) fail(invalidCode);
		return parsed as DesignPlacements;
	} catch (error) {
		if (error instanceof RepositoryError) throw error;
		fail(invalidCode);
	}
}

function validateLine(line: NewCheckoutDraftLine): string {
	if (
		!line ||
		!isNonEmptyString(line.stripeProductId) ||
		!isNonEmptyString(line.stripePriceId) ||
		!isNonEmptyString(line.productName) ||
		!isNonEmptyString(line.variantLabel) ||
		!isNonEmptyString(line.sku) ||
		!isNonEmptyString(line.styriaProductNumber) ||
		!isNonEmptyString(line.designReference) ||
		!Number.isSafeInteger(line.quantity) ||
		line.quantity < 1 ||
		line.quantity > 20 ||
		!isSafeNonNegativeInteger(line.unitAmount) ||
		line.currency !== 'eur'
	) {
		fail('CHECKOUT_DRAFT_INVALID');
	}
	return canonicalDesignJson(line.designPlacements, 'CHECKOUT_DRAFT_INVALID');
}

function validateNewDraft(input: NewCheckoutDraft): {
	createdAt: string;
	expiresAt: string;
	designs: string[];
} {
	if (
		!input ||
		!Number.isSafeInteger(input.contractVersion) ||
		input.contractVersion < 1 ||
		input.currency !== 'eur' ||
		!Number.isSafeInteger(input.totalUnitCount) ||
		input.totalUnitCount < 1 ||
		input.totalUnitCount > 20 ||
		(input.shippingMode !== 'paid' && input.shippingMode !== 'free') ||
		!Array.isArray(input.lines) ||
		input.lines.length < 1 ||
		input.lines.length > 10
	) {
		fail('CHECKOUT_DRAFT_INVALID');
	}

	const designs = input.lines.map(validateLine);
	const totalUnitCount = input.lines.reduce((total, line) => total + line.quantity, 0);
	const expectedShippingMode = totalUnitCount === 1 ? 'paid' : 'free';
	if (
		totalUnitCount !== input.totalUnitCount ||
		input.shippingMode !== expectedShippingMode ||
		new Set(input.lines.map((line) => line.stripePriceId)).size !== input.lines.length
	) {
		fail('CHECKOUT_DRAFT_INVALID');
	}

	const createdAt = isoTimestamp(input.createdAt, 'CHECKOUT_DRAFT_INVALID');
	const expiresAt = isoTimestamp(input.expiresAt, 'CHECKOUT_DRAFT_INVALID');
	if (expiresAt <= createdAt) fail('CHECKOUT_DRAFT_INVALID');
	return { createdAt, expiresAt, designs };
}

function mapLine(row: DraftLineRow, expectedIndex: number): CheckoutDraftLine {
	if (
		row.line_index !== expectedIndex ||
		!isNonEmptyString(row.stripe_product_id) ||
		!isNonEmptyString(row.stripe_price_id) ||
		!isNonEmptyString(row.product_name) ||
		!isNonEmptyString(row.variant_label) ||
		!isNonEmptyString(row.sku) ||
		!isNonEmptyString(row.styria_product_number) ||
		!isNonEmptyString(row.design_reference) ||
		!Number.isSafeInteger(row.quantity) ||
		(row.quantity as number) < 1 ||
		(row.quantity as number) > 20 ||
		!isSafeNonNegativeInteger(row.unit_amount) ||
		row.currency !== 'eur'
	) {
		fail('CHECKOUT_DRAFT_ROW_INVALID');
	}

	return {
		lineIndex: expectedIndex,
		stripeProductId: row.stripe_product_id,
		stripePriceId: row.stripe_price_id,
		productName: row.product_name,
		variantLabel: row.variant_label,
		sku: row.sku,
		styriaProductNumber: row.styria_product_number,
		designReference: row.design_reference,
		designPlacements: designFromJson(row.design_json, 'CHECKOUT_DRAFT_ROW_INVALID'),
		quantity: row.quantity as number,
		unitAmount: row.unit_amount,
		currency: 'eur'
	};
}

function mapDraft(row: DraftRow, lines: CheckoutDraftLine[]): CheckoutDraftWithLines {
	if (
		!isNonEmptyString(row.id) ||
		(row.stripe_checkout_session_id !== null &&
			!isNonEmptyString(row.stripe_checkout_session_id)) ||
		!Number.isSafeInteger(row.contract_version) ||
		(row.contract_version as number) < 1 ||
		row.currency !== 'eur' ||
		!Number.isSafeInteger(row.total_unit_count) ||
		(row.total_unit_count as number) < 1 ||
		(row.total_unit_count as number) > 20 ||
		(row.shipping_mode !== 'paid' && row.shipping_mode !== 'free')
	) {
		fail('CHECKOUT_DRAFT_ROW_INVALID');
	}

	const createdAt = dateFromIso(row.created_at, 'CHECKOUT_DRAFT_ROW_INVALID');
	const expiresAt = dateFromIso(row.expires_at, 'CHECKOUT_DRAFT_ROW_INVALID');
	const completedAt =
		row.completed_at === null ? null : dateFromIso(row.completed_at, 'CHECKOUT_DRAFT_ROW_INVALID');
	const totalUnitCount = lines.reduce((total, line) => total + line.quantity, 0);
	if (
		expiresAt <= createdAt ||
		(completedAt !== null && completedAt < createdAt) ||
		totalUnitCount !== row.total_unit_count ||
		(row.shipping_mode === 'paid') !== (totalUnitCount === 1)
	) {
		fail('CHECKOUT_DRAFT_ROW_INVALID');
	}

	return {
		id: row.id,
		checkoutSessionId: row.stripe_checkout_session_id as string | null,
		contractVersion: row.contract_version as number,
		currency: 'eur',
		totalUnitCount: row.total_unit_count as number,
		shippingMode: row.shipping_mode,
		createdAt,
		expiresAt,
		completedAt,
		lines
	};
}

export class SqliteCheckoutDraftRepository implements CheckoutDraftRepository {
	constructor(private readonly database: ShopDatabase) {}

	create(input: NewCheckoutDraft): CheckoutDraft {
		const validated = validateNewDraft(input);
		const id = randomUUID();
		const insertDraft = this.database.prepare(`
			INSERT INTO checkout_drafts (
				id, stripe_checkout_session_id, contract_version, currency,
				total_unit_count, shipping_mode, created_at, expires_at, completed_at
			) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL)
		`);
		const insertLine = this.database.prepare(`
			INSERT INTO checkout_draft_lines (
				draft_id, line_index, stripe_product_id, stripe_price_id, product_name,
				variant_label, sku, styria_product_number, design_reference, design_json,
				quantity, unit_amount, currency
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const create = this.database.transaction(() => {
			insertDraft.run(
				id,
				input.contractVersion,
				input.currency,
				input.totalUnitCount,
				input.shippingMode,
				validated.createdAt,
				validated.expiresAt
			);
			for (const [index, line] of input.lines.entries()) {
				insertLine.run(
					id,
					index,
					line.stripeProductId,
					line.stripePriceId,
					line.productName,
					line.variantLabel,
					line.sku,
					line.styriaProductNumber,
					line.designReference,
					validated.designs[index],
					line.quantity,
					line.unitAmount,
					line.currency
				);
			}
		});

		try {
			create.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('CHECKOUT_DRAFT_CREATE_FAILED');
		}

		const created = this.findById(id);
		if (!created) fail('CHECKOUT_DRAFT_CREATE_FAILED');
		return {
			id: created.id,
			checkoutSessionId: created.checkoutSessionId,
			contractVersion: created.contractVersion,
			currency: created.currency,
			totalUnitCount: created.totalUnitCount,
			shippingMode: created.shippingMode,
			createdAt: created.createdAt,
			expiresAt: created.expiresAt,
			completedAt: created.completedAt
		};
	}

	attachSession(draftId: string, sessionId: string): void {
		if (!isNonEmptyString(draftId) || !isNonEmptyString(sessionId)) {
			fail('CHECKOUT_DRAFT_SESSION_INVALID');
		}
		try {
			const find = this.database.prepare(
				'SELECT stripe_checkout_session_id FROM checkout_drafts WHERE id = ?'
			);
			const update = this.database.prepare(`
				UPDATE checkout_drafts
				SET stripe_checkout_session_id = ?
				WHERE id = ? AND stripe_checkout_session_id IS NULL
			`);
			const attach = this.database.transaction(() => {
				const row = find.get(draftId) as { stripe_checkout_session_id: unknown } | undefined;
				if (!row) fail('CHECKOUT_DRAFT_NOT_FOUND');
				if (row.stripe_checkout_session_id === sessionId) return;
				if (row.stripe_checkout_session_id !== null) fail('CHECKOUT_DRAFT_SESSION_CONFLICT');
				update.run(sessionId, draftId);
			});
			attach.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			if (
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				error.code === 'SQLITE_CONSTRAINT_UNIQUE'
			) {
				fail('CHECKOUT_SESSION_CONFLICT');
			}
			fail('CHECKOUT_DRAFT_SESSION_ATTACH_FAILED');
		}
	}

	findById(draftId: string): CheckoutDraftWithLines | null {
		if (!isNonEmptyString(draftId)) fail('CHECKOUT_DRAFT_ID_INVALID');
		const row = this.database.prepare('SELECT * FROM checkout_drafts WHERE id = ?').get(draftId) as
			DraftRow | undefined;
		if (!row) return null;
		const lineRows = this.database
			.prepare('SELECT * FROM checkout_draft_lines WHERE draft_id = ? ORDER BY line_index')
			.all(draftId) as DraftLineRow[];
		return mapDraft(
			row,
			lineRows.map((line, index) => mapLine(line, index))
		);
	}

	markCompleted(draftId: string, completedAt: Date): void {
		if (!isNonEmptyString(draftId)) fail('CHECKOUT_DRAFT_ID_INVALID');
		const timestamp = isoTimestamp(completedAt, 'CHECKOUT_DRAFT_COMPLETION_INVALID');
		try {
			const find = this.database.prepare(
				'SELECT created_at, completed_at FROM checkout_drafts WHERE id = ?'
			);
			const update = this.database.prepare(`
				UPDATE checkout_drafts SET completed_at = ? WHERE id = ? AND completed_at IS NULL
			`);
			const complete = this.database.transaction(() => {
				const row = find.get(draftId) as { created_at: unknown; completed_at: unknown } | undefined;
				if (!row) fail('CHECKOUT_DRAFT_NOT_FOUND');
				const createdAt = dateFromIso(row.created_at, 'CHECKOUT_DRAFT_ROW_INVALID');
				if (completedAt < createdAt) fail('CHECKOUT_DRAFT_COMPLETION_INVALID');
				if (row.completed_at === timestamp) return;
				if (row.completed_at !== null) fail('CHECKOUT_DRAFT_COMPLETION_CONFLICT');
				update.run(timestamp, draftId);
			});
			complete.immediate();
		} catch (error) {
			if (error instanceof RepositoryError) throw error;
			fail('CHECKOUT_DRAFT_COMPLETION_FAILED');
		}
	}
}
