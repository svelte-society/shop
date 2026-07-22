import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase } from './connection.server';
import { migrate } from './migrate.server';
import type { ShopDatabase } from './types';

const initialMigrationsDirectory = fileURLToPath(
	new URL('../../../../migrations', import.meta.url)
);

type ColumnShape = {
	name: string;
	type: 'BLOB' | 'INTEGER' | 'TEXT';
	notnull: 0 | 1;
	dflt_value: string | null;
	pk: number;
};

function column(
	name: string,
	type: ColumnShape['type'],
	notnull: ColumnShape['notnull'],
	dflt_value: string | null = null,
	pk = 0
): ColumnShape {
	return { name, type, notnull, dflt_value, pk };
}

const expectedColumns = {
	checkout_drafts: [
		column('id', 'TEXT', 0, null, 1),
		column('stripe_checkout_session_id', 'TEXT', 0),
		column('contract_version', 'INTEGER', 1),
		column('currency', 'TEXT', 1),
		column('total_unit_count', 'INTEGER', 1),
		column('shipping_mode', 'TEXT', 1),
		column('created_at', 'TEXT', 1),
		column('expires_at', 'TEXT', 1),
		column('completed_at', 'TEXT', 0),
		column('destination_country', 'TEXT', 0)
	],
	checkout_draft_lines: [
		column('draft_id', 'TEXT', 1, null, 1),
		column('line_index', 'INTEGER', 1, null, 2),
		column('stripe_product_id', 'TEXT', 1),
		column('stripe_price_id', 'TEXT', 1),
		column('product_name', 'TEXT', 1),
		column('variant_label', 'TEXT', 1),
		column('sku', 'TEXT', 1),
		column('styria_product_number', 'TEXT', 1),
		column('design_reference', 'TEXT', 1),
		column('design_json', 'TEXT', 1),
		column('quantity', 'INTEGER', 1),
		column('unit_amount', 'INTEGER', 1),
		column('currency', 'TEXT', 1),
		column('production_json', 'TEXT', 1, '\'{"mockupPlacements":{},"threadColors":{}}\'')
	],
	orders: [
		column('id', 'TEXT', 0, null, 1),
		column('stripe_checkout_session_id', 'TEXT', 1),
		column('stripe_payment_intent_id', 'TEXT', 1),
		column('stripe_customer_id', 'TEXT', 1),
		column('checkout_draft_id', 'TEXT', 1),
		column('currency', 'TEXT', 1),
		column('subtotal_amount', 'INTEGER', 1),
		column('discount_amount', 'INTEGER', 1),
		column('shipping_amount', 'INTEGER', 1),
		column('tax_amount', 'INTEGER', 1),
		column('total_amount', 'INTEGER', 1),
		column('destination_country', 'TEXT', 1),
		column('payment_status', 'TEXT', 1),
		column('fulfillment_status', 'TEXT', 1),
		column('styria_order_id', 'TEXT', 0),
		column('styria_status', 'TEXT', 0),
		column('tracking_number', 'TEXT', 0),
		column('submitted_at', 'TEXT', 0),
		column('shipped_at', 'TEXT', 0),
		column('updated_at', 'TEXT', 1),
		column('last_error_code', 'TEXT', 0),
		column('styria_last_checked_at', 'TEXT', 0),
		column('shipping_tax_amount', 'INTEGER', 1, '0')
	],
	stripe_events: [
		column('stripe_event_id', 'TEXT', 0, null, 1),
		column('event_type', 'TEXT', 1),
		column('processing_status', 'TEXT', 1),
		column('stripe_checkout_session_id', 'TEXT', 0),
		column('stripe_payment_intent_id', 'TEXT', 0),
		column('last_error_code', 'TEXT', 0),
		column('first_seen_at', 'TEXT', 1),
		column('completed_at', 'TEXT', 0)
	],
	order_lines: [
		column('order_id', 'TEXT', 1, null, 1),
		column('line_index', 'INTEGER', 1, null, 2),
		column('stripe_product_id', 'TEXT', 1),
		column('stripe_price_id', 'TEXT', 1),
		column('product_name', 'TEXT', 1),
		column('variant_label', 'TEXT', 1),
		column('sku', 'TEXT', 1),
		column('styria_product_number', 'TEXT', 1),
		column('design_reference', 'TEXT', 1),
		column('design_json', 'TEXT', 1),
		column('quantity', 'INTEGER', 1),
		column('unit_amount', 'INTEGER', 1),
		column('currency', 'TEXT', 1),
		column('production_json', 'TEXT', 1, '\'{"mockupPlacements":{},"threadColors":{}}\''),
		column('retail_unit_amount', 'INTEGER', 1, '0')
	],
	order_events: [
		column('id', 'INTEGER', 0, null, 1),
		column('order_id', 'TEXT', 1),
		column('actor', 'TEXT', 1),
		column('action', 'TEXT', 1),
		column('prior_state', 'TEXT', 0),
		column('next_state', 'TEXT', 0),
		column('result', 'TEXT', 1),
		column('error_code', 'TEXT', 0),
		column('created_at', 'TEXT', 1)
	],
	submission_approvals: [
		column('id', 'TEXT', 0, null, 1),
		column('order_id', 'TEXT', 1),
		column('payload_hash', 'TEXT', 1),
		column('actor', 'TEXT', 1),
		column('expires_at', 'TEXT', 1),
		column('used_at', 'TEXT', 0)
	],
	outbox_jobs: [
		column('id', 'INTEGER', 0, null, 1),
		column('kind', 'TEXT', 1),
		column('idempotency_key', 'TEXT', 1),
		column('order_id', 'TEXT', 0),
		column('attempt_count', 'INTEGER', 1, '0'),
		column('next_attempt_at', 'TEXT', 1),
		column('completed_at', 'TEXT', 0),
		column('last_error_code', 'TEXT', 0),
		column('alert_code', 'TEXT', 0),
		column('alert_subject_id', 'TEXT', 0),
		column('alert_observed_at', 'TEXT', 0)
	],
	email_deliveries: [
		column('id', 'INTEGER', 0, null, 1),
		column('order_id', 'TEXT', 1),
		column('kind', 'TEXT', 1),
		column('tracking_reference', 'TEXT', 0),
		column('idempotency_key', 'TEXT', 1),
		column('provider_delivery_id', 'TEXT', 0),
		column('attempt_count', 'INTEGER', 1, '0'),
		column('completed_at', 'TEXT', 0)
	],
	support_notes: [
		column('id', 'INTEGER', 0, null, 1),
		column('order_id', 'TEXT', 1),
		column('outcome', 'TEXT', 1),
		column('external_reference', 'TEXT', 0),
		column('actor', 'TEXT', 1),
		column('created_at', 'TEXT', 1),
		column('note', 'TEXT', 0)
	],
	job_leases: [
		column('name', 'TEXT', 0, null, 1),
		column('owner_id', 'TEXT', 1),
		column('expires_at', 'TEXT', 1)
	],
	job_runs: [
		column('id', 'INTEGER', 0, null, 1),
		column('name', 'TEXT', 1),
		column('owner_id', 'TEXT', 1),
		column('started_at', 'TEXT', 1),
		column('finished_at', 'TEXT', 0),
		column('result', 'TEXT', 0),
		column('error_code', 'TEXT', 0)
	],
	withdrawal_cases: [
		column('id', 'TEXT', 0, null, 1),
		column('public_reference', 'TEXT', 1),
		column('status', 'TEXT', 1),
		column('revision', 'INTEGER', 1, '1'),
		column('scope', 'TEXT', 1),
		column('eligibility', 'TEXT', 1),
		column('outcome_code', 'TEXT', 0),
		column('schema_version', 'INTEGER', 0),
		column('encryption_key_version', 'INTEGER', 0),
		column('encrypted_payload', 'BLOB', 0),
		column('payload_nonce', 'BLOB', 0),
		column('payload_tag', 'BLOB', 0),
		column('dedupe_fingerprint', 'TEXT', 0),
		column('created_at', 'TEXT', 1),
		column('updated_at', 'TEXT', 1),
		column('reconciled_at', 'TEXT', 0),
		column('closed_at', 'TEXT', 0),
		column('pii_purge_due_at', 'TEXT', 0),
		column('purged_at', 'TEXT', 0)
	],
	withdrawal_case_events: [
		column('id', 'INTEGER', 0, null, 1),
		column('case_id', 'TEXT', 1),
		column('actor', 'TEXT', 1),
		column('action', 'TEXT', 1),
		column('prior_status', 'TEXT', 0),
		column('next_status', 'TEXT', 1),
		column('result_code', 'TEXT', 1),
		column('created_at', 'TEXT', 1)
	],
	withdrawal_messages: [
		column('id', 'INTEGER', 0, null, 1),
		column('case_id', 'TEXT', 1),
		column('kind', 'TEXT', 1),
		column('resend_of_message_id', 'INTEGER', 0),
		column('idempotency_key', 'TEXT', 1),
		column('attempt_count', 'INTEGER', 1, '0'),
		column('next_attempt_at', 'TEXT', 1),
		column('provider_delivery_id', 'TEXT', 0),
		column('completed_at', 'TEXT', 0),
		column('last_error_code', 'TEXT', 0)
	]
} as const satisfies Record<string, readonly ColumnShape[]>;

type TableName = keyof typeof expectedColumns;

type ForeignKeyShape = {
	id: number;
	seq: number;
	table: string;
	from: string;
	to: string;
	on_update: 'NO ACTION';
	on_delete: 'CASCADE' | 'NO ACTION';
	match: 'NONE';
};

function foreignKey(
	table: string,
	from: string,
	on_delete: ForeignKeyShape['on_delete'] = 'NO ACTION'
): ForeignKeyShape[] {
	return [
		{ id: 0, seq: 0, table, from, to: 'id', on_update: 'NO ACTION', on_delete, match: 'NONE' }
	];
}

const expectedForeignKeys = {
	checkout_drafts: [],
	checkout_draft_lines: foreignKey('checkout_drafts', 'draft_id', 'CASCADE'),
	orders: foreignKey('checkout_drafts', 'checkout_draft_id'),
	stripe_events: [],
	order_lines: foreignKey('orders', 'order_id'),
	order_events: foreignKey('orders', 'order_id'),
	submission_approvals: foreignKey('orders', 'order_id'),
	outbox_jobs: foreignKey('orders', 'order_id'),
	email_deliveries: foreignKey('orders', 'order_id'),
	support_notes: foreignKey('orders', 'order_id'),
	job_leases: [],
	job_runs: [],
	withdrawal_cases: [],
	withdrawal_case_events: foreignKey('withdrawal_cases', 'case_id'),
	withdrawal_messages: [
		{
			id: 0,
			seq: 0,
			table: 'withdrawal_messages',
			from: 'resend_of_message_id',
			to: 'id',
			on_update: 'NO ACTION',
			on_delete: 'NO ACTION',
			match: 'NONE'
		},
		{
			id: 1,
			seq: 0,
			table: 'withdrawal_cases',
			from: 'case_id',
			to: 'id',
			on_update: 'NO ACTION',
			on_delete: 'NO ACTION',
			match: 'NONE'
		}
	]
} satisfies Record<TableName, ForeignKeyShape[]>;

type DraftInput = {
	id: string;
	sessionId: string | null;
	destinationCountry: string | null;
	currency: string;
	totalUnitCount: number;
	shippingMode: string;
};

function insertDraft(database: ShopDatabase, overrides: Partial<DraftInput> = {}): void {
	const input: DraftInput = {
		id: 'draft_default',
		sessionId: 'cs_draft_default',
		destinationCountry: 'SE',
		currency: 'eur',
		totalUnitCount: 1,
		shippingMode: 'paid',
		...overrides
	};
	database
		.prepare(
			`INSERT INTO checkout_drafts (
				id, stripe_checkout_session_id, contract_version, currency,
				total_unit_count, shipping_mode, created_at, expires_at, destination_country
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.id,
			input.sessionId,
			2,
			input.currency,
			input.totalUnitCount,
			input.shippingMode,
			'2026-07-16T00:00:00.000Z',
			'2026-07-16T01:00:00.000Z',
			input.destinationCountry
		);
}

type DraftLineInput = {
	draftId: string;
	lineIndex: number;
	quantity: number;
	unitAmount: number;
	currency: string;
};

function insertDraftLine(database: ShopDatabase, overrides: Partial<DraftLineInput> = {}): void {
	const input: DraftLineInput = {
		draftId: 'draft_default',
		lineIndex: 0,
		quantity: 1,
		unitAmount: 2_000,
		currency: 'eur',
		...overrides
	};
	database
		.prepare(
			`INSERT INTO checkout_draft_lines (
				draft_id, line_index, stripe_product_id, stripe_price_id, product_name,
				variant_label, sku, styria_product_number, design_reference, design_json,
				quantity, unit_amount, currency
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.draftId,
			input.lineIndex,
			'prod_test',
			'price_test',
			'Test product',
			'M',
			'SKU-TEST',
			'STYRIA-TEST',
			'design-test',
			'{}',
			input.quantity,
			input.unitAmount,
			input.currency
		);
}

type OrderInput = {
	id: string;
	sessionId: string;
	paymentIntentId: string;
	draftId: string;
	currency: string;
	paymentStatus: string;
	fulfillmentStatus: string;
	styriaOrderId: string | null;
	shippingTax: number;
};

function insertOrder(database: ShopDatabase, overrides: Partial<OrderInput> = {}): void {
	const id = overrides.id ?? 'order_default';
	const input: OrderInput = {
		id,
		sessionId: `cs_${id}`,
		paymentIntentId: `pi_${id}`,
		draftId: 'draft_default',
		currency: 'eur',
		paymentStatus: 'paid',
		fulfillmentStatus: 'pending_review',
		styriaOrderId: null,
		shippingTax: 200,
		...overrides
	};
	database
		.prepare(
			`INSERT INTO orders (
				id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
				checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
				shipping_tax_amount, tax_amount, total_amount, destination_country, payment_status, fulfillment_status,
				styria_order_id, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.id,
			input.sessionId,
			input.paymentIntentId,
			`cus_${id}`,
			input.draftId,
			input.currency,
			2_000,
			0,
			1_000,
			input.shippingTax,
			500,
			3_500,
			'SE',
			input.paymentStatus,
			input.fulfillmentStatus,
			input.styriaOrderId,
			'2026-07-16T00:00:00.000Z'
		);
}

function insertOrderLine(
	database: ShopDatabase,
	orderId: string,
	currency = 'eur',
	retailUnitAmount = 2_500
): void {
	database
		.prepare(
			`INSERT INTO order_lines (
				order_id, line_index, stripe_product_id, stripe_price_id, product_name,
				variant_label, sku, styria_product_number, design_reference, design_json,
				quantity, unit_amount, currency, retail_unit_amount
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			orderId,
			0,
			'prod_test',
			'price_test',
			'Test product',
			'M',
			'SKU-TEST',
			'STYRIA-TEST',
			'design-test',
			'{}',
			1,
			2_000,
			currency,
			retailUnitAmount
		);
}

let database: ShopDatabase;

beforeEach(() => {
	database = openDatabase(':memory:');
	migrate(database, initialMigrationsDirectory);
});

afterEach(() => {
	closeDatabase();
});

describe('initial schema metadata', () => {
	it('contains exactly the 15 application tables with exact column shapes', () => {
		const applicationTables = database
			.prepare(
				`SELECT name FROM sqlite_schema
				 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'
				 ORDER BY name`
			)
			.all()
			.map((row) => (row as { name: string }).name);

		expect(applicationTables).toEqual(Object.keys(expectedColumns).sort());
		for (const [table, expected] of Object.entries(expectedColumns)) {
			const actual = (
				database.pragma(`table_info(${table})`) as Array<ColumnShape & { cid: number }>
			).map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }));
			expect(actual, table).toEqual(expected);
		}
	});

	it('contains exactly the nine custom indexes and accounts for automatic indexes separately', () => {
		type IndexRow = { name: string; tbl_name: string; sql: string | null };
		const indexes = database
			.prepare(
				`SELECT name, tbl_name, sql FROM sqlite_schema
				 WHERE type = 'index' AND tbl_name != '_migrations'
				 ORDER BY name`
			)
			.all() as IndexRow[];
		const custom = indexes.filter((index) => index.sql !== null);
		const automatic = indexes.filter((index) => index.sql === null);

		expect(custom).toEqual([
			{
				name: 'idx_order_events_order',
				tbl_name: 'order_events',
				sql: 'CREATE INDEX idx_order_events_order ON order_events(order_id, created_at)'
			},
			{
				name: 'idx_orders_fulfillment_status',
				tbl_name: 'orders',
				sql: 'CREATE INDEX idx_orders_fulfillment_status ON orders(fulfillment_status, updated_at)'
			},
			{
				name: 'idx_orders_styria_sync',
				tbl_name: 'orders',
				sql: 'CREATE INDEX idx_orders_styria_sync\nON orders(styria_last_checked_at, updated_at, id)'
			},
			{
				name: 'idx_outbox_due',
				tbl_name: 'outbox_jobs',
				sql: 'CREATE INDEX idx_outbox_due ON outbox_jobs(completed_at, next_attempt_at)'
			},
			{
				name: 'withdrawal_case_events_case_idx',
				tbl_name: 'withdrawal_case_events',
				sql: 'CREATE INDEX withdrawal_case_events_case_idx ON withdrawal_case_events(case_id, id)'
			},
			{
				name: 'withdrawal_cases_dedupe_idx',
				tbl_name: 'withdrawal_cases',
				sql: 'CREATE INDEX withdrawal_cases_dedupe_idx ON withdrawal_cases(dedupe_fingerprint, created_at)'
			},
			{
				name: 'withdrawal_cases_purge_idx',
				tbl_name: 'withdrawal_cases',
				sql: 'CREATE INDEX withdrawal_cases_purge_idx ON withdrawal_cases(pii_purge_due_at) WHERE purged_at IS NULL'
			},
			{
				name: 'withdrawal_cases_status_idx',
				tbl_name: 'withdrawal_cases',
				sql: 'CREATE INDEX withdrawal_cases_status_idx ON withdrawal_cases(status, created_at)'
			},
			{
				name: 'withdrawal_messages_due_idx',
				tbl_name: 'withdrawal_messages',
				sql: 'CREATE INDEX withdrawal_messages_due_idx ON withdrawal_messages(completed_at, next_attempt_at, id)'
			}
		]);
		expect(
			Object.fromEntries(
				Object.entries(
					automatic.reduce<Record<string, number>>((counts, index) => {
						counts[index.tbl_name] = (counts[index.tbl_name] ?? 0) + 1;
						return counts;
					}, {})
				).sort(([left], [right]) => left.localeCompare(right))
			)
		).toEqual({
			checkout_draft_lines: 1,
			checkout_drafts: 2,
			email_deliveries: 1,
			job_leases: 1,
			order_lines: 1,
			orders: 5,
			outbox_jobs: 1,
			stripe_events: 1,
			submission_approvals: 1,
			withdrawal_cases: 2,
			withdrawal_messages: 1
		});
		expect(automatic).toHaveLength(17);
		expect(automatic.every((index) => index.name.startsWith('sqlite_autoindex_'))).toBe(true);

		const expectedIndexColumns = {
			idx_order_events_order: ['order_id', 'created_at'],
			idx_orders_fulfillment_status: ['fulfillment_status', 'updated_at'],
			idx_orders_styria_sync: ['styria_last_checked_at', 'updated_at', 'id'],
			idx_outbox_due: ['completed_at', 'next_attempt_at'],
			withdrawal_case_events_case_idx: ['case_id', 'id'],
			withdrawal_cases_dedupe_idx: ['dedupe_fingerprint', 'created_at'],
			withdrawal_cases_purge_idx: ['pii_purge_due_at'],
			withdrawal_cases_status_idx: ['status', 'created_at'],
			withdrawal_messages_due_idx: ['completed_at', 'next_attempt_at', 'id']
		};
		for (const [name, columns] of Object.entries(expectedIndexColumns)) {
			const actual = (database.pragma(`index_info(${name})`) as Array<{ name: string }>).map(
				(index) => index.name
			);
			expect(actual, name).toEqual(columns);
		}
	});

	it('declares every foreign key with its exact action', () => {
		for (const table of Object.keys(expectedColumns) as TableName[]) {
			expect(database.pragma(`foreign_key_list(${table})`), table).toEqual(
				expectedForeignKeys[table]
			);
		}
	});
});

describe('initial schema CHECK constraints', () => {
	it('enforces checkout draft currency, unit bounds, and shipping mode on inserts and updates', () => {
		expect(() => insertDraft(database, { currency: 'usd' })).toThrow(/CHECK constraint failed/);
		expect(() => insertDraft(database, { totalUnitCount: 0 })).toThrow(/CHECK constraint failed/);
		expect(() => insertDraft(database, { totalUnitCount: 21 })).toThrow(/CHECK constraint failed/);
		expect(() => insertDraft(database, { shippingMode: 'express' })).toThrow(
			/CHECK constraint failed/
		);
		insertDraft(database);
		insertDraft(database, {
			id: 'draft_upper_bound',
			sessionId: 'cs_upper_bound',
			totalUnitCount: 20,
			shippingMode: 'free'
		});
		expect(() =>
			database.prepare("UPDATE checkout_drafts SET shipping_mode = 'express'").run()
		).toThrow(/CHECK constraint failed/);
	});

	it('requires a valid uppercase market destination on every new or updated checkout draft', () => {
		expect(() => insertDraft(database, { destinationCountry: null })).toThrow(
			/checkout destination required/
		);
		expect(() => insertDraft(database, { destinationCountry: 'se' })).toThrow(
			/CHECK constraint failed/
		);
		expect(() => insertDraft(database, { destinationCountry: 'SWE' })).toThrow(
			/CHECK constraint failed/
		);
		insertDraft(database);
		expect(() =>
			database.prepare('UPDATE checkout_drafts SET destination_country = NULL').run()
		).toThrow(/checkout destination required/);
		expect(() =>
			database.prepare("UPDATE checkout_drafts SET destination_country = 'se'").run()
		).toThrow(/CHECK constraint failed/);
	});

	it('enforces draft-line quantity, unit amount, and currency on inserts and updates', () => {
		insertDraft(database);
		expect(() => insertDraftLine(database, { quantity: 0 })).toThrow(/CHECK constraint failed/);
		expect(() => insertDraftLine(database, { quantity: 21 })).toThrow(/CHECK constraint failed/);
		expect(() => insertDraftLine(database, { unitAmount: -1 })).toThrow(/CHECK constraint failed/);
		expect(() => insertDraftLine(database, { currency: 'usd' })).toThrow(/CHECK constraint failed/);
		insertDraftLine(database);
		insertDraftLine(database, { lineIndex: 1, quantity: 20, unitAmount: 0 });
		expect(() => database.prepare('UPDATE checkout_draft_lines SET quantity = 0').run()).toThrow(
			/CHECK constraint failed/
		);
	});

	it('enforces order currency and independent payment and fulfillment states', () => {
		insertDraft(database);
		expect(() => insertOrder(database, { currency: 'usd' })).toThrow(/CHECK constraint failed/);
		expect(() => insertOrder(database, { paymentStatus: 'unpaid' })).toThrow(
			/CHECK constraint failed/
		);
		expect(() => insertOrder(database, { fulfillmentStatus: 'unknown' })).toThrow(
			/CHECK constraint failed/
		);
		const paymentStatuses = ['paid', 'partially_refunded', 'refunded'];
		const fulfillmentStatuses = [
			'pending_review',
			'submitting',
			'submitted',
			'awaiting_vendor_payment',
			'in_production',
			'shipped',
			'review_required',
			'cancelled'
		];
		for (const [index, fulfillmentStatus] of fulfillmentStatuses.entries()) {
			const id = `allowed_${index}`;
			insertDraft(database, { id: `draft_${id}`, sessionId: `cs_draft_${id}` });
			insertOrder(database, {
				id: `order_${id}`,
				draftId: `draft_${id}`,
				paymentStatus: paymentStatuses[index % paymentStatuses.length],
				fulfillmentStatus
			});
		}
		expect(() => database.prepare("UPDATE orders SET payment_status = 'unpaid'").run()).toThrow(
			/CHECK constraint failed/
		);
	});

	it('enforces non-negative explicit shipping tax and retail unit snapshots', () => {
		insertDraft(database);
		expect(() => insertOrder(database, { shippingTax: -1 })).toThrow(/CHECK constraint failed/);
		insertOrder(database);
		expect(() => insertOrderLine(database, 'order_default', 'eur', -1)).toThrow(
			/CHECK constraint failed/
		);
		insertOrderLine(database, 'order_default');
		expect(() => database.prepare('UPDATE orders SET shipping_tax_amount = -1').run()).toThrow(
			/CHECK constraint failed/
		);
		expect(() => database.prepare('UPDATE order_lines SET retail_unit_amount = -1').run()).toThrow(
			/CHECK constraint failed/
		);
	});

	it('enforces Stripe event processing states on inserts and updates', () => {
		const insert = database.prepare(
			`INSERT INTO stripe_events (stripe_event_id, event_type, processing_status, first_seen_at)
			 VALUES (?, ?, ?, ?)`
		);
		expect(() =>
			insert.run('evt_invalid', 'checkout.session.completed', 'queued', '2026-07-16')
		).toThrow(/CHECK constraint failed/);
		for (const status of ['processing', 'completed', 'failed']) {
			insert.run(`evt_${status}`, 'checkout.session.completed', status, '2026-07-16');
		}
		expect(() =>
			database.prepare("UPDATE stripe_events SET processing_status = 'queued'").run()
		).toThrow(/CHECK constraint failed/);
	});

	it('enforces order-line currency on inserts and updates', () => {
		insertDraft(database);
		insertOrder(database);
		expect(() => insertOrderLine(database, 'order_default', 'usd')).toThrow(
			/CHECK constraint failed/
		);
		insertOrderLine(database, 'order_default');
		expect(() => database.prepare("UPDATE order_lines SET currency = 'usd'").run()).toThrow(
			/CHECK constraint failed/
		);
	});

	it('enforces the fixed approval actor on inserts and updates', () => {
		insertDraft(database);
		insertOrder(database);
		const insert = database.prepare(
			`INSERT INTO submission_approvals (id, order_id, payload_hash, actor, expires_at)
			 VALUES (?, ?, ?, ?, ?)`
		);
		expect(() =>
			insert.run('approval_invalid', 'order_default', 'hash', 'operator', '2026-07-16')
		).toThrow(/CHECK constraint failed/);
		insert.run('approval_valid', 'order_default', 'hash', 'codex-admin', '2026-07-16');
		expect(() =>
			database.prepare("UPDATE submission_approvals SET actor = 'operator'").run()
		).toThrow(/CHECK constraint failed/);
	});

	it('enforces the fixed support-note actor on inserts and updates', () => {
		insertDraft(database);
		insertOrder(database);
		const insert = database.prepare(
			`INSERT INTO support_notes (order_id, outcome, actor, created_at)
			 VALUES (?, ?, ?, ?)`
		);
		expect(() => insert.run('order_default', 'noted', 'operator', '2026-07-16')).toThrow(
			/CHECK constraint failed/
		);
		insert.run('order_default', 'noted', 'codex-admin', '2026-07-16');
		expect(() => database.prepare("UPDATE support_notes SET actor = 'operator'").run()).toThrow(
			/CHECK constraint failed/
		);
	});

	it('enforces withdrawal states, revisions, encrypted-or-purged shape, actors, and message kinds', () => {
		database
			.prepare(
				`INSERT INTO withdrawal_cases (
					id, public_reference, status, revision, scope, eligibility,
					schema_version, encryption_key_version, encrypted_payload,
					payload_nonce, payload_tag, dedupe_fingerprint, created_at, updated_at
				) VALUES (?, ?, 'submitted', 1, 'specific_items', 'pending', 1, 1, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				'case_1',
				'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				Buffer.from('ciphertext'),
				Buffer.alloc(12),
				Buffer.alloc(16),
				'a'.repeat(64),
				'2026-07-17T08:00:00.000Z',
				'2026-07-17T08:00:00.000Z'
			);

		for (const sql of [
			"UPDATE withdrawal_cases SET status = 'unknown' WHERE id = 'case_1'",
			"UPDATE withdrawal_cases SET revision = 0 WHERE id = 'case_1'",
			"UPDATE withdrawal_cases SET scope = 'some_items' WHERE id = 'case_1'",
			"UPDATE withdrawal_cases SET eligibility = 'approved' WHERE id = 'case_1'",
			"UPDATE withdrawal_cases SET encrypted_payload = NULL WHERE id = 'case_1'",
			"UPDATE withdrawal_cases SET purged_at = '2026-07-18T08:00:00.000Z' WHERE id = 'case_1'"
		]) {
			expect(() => database.prepare(sql).run()).toThrow(/CHECK constraint failed/);
		}

		database
			.prepare(
				`INSERT INTO withdrawal_case_events (
					case_id, actor, action, prior_status, next_status, result_code, created_at
				) VALUES ('case_1', 'customer', 'submitted', NULL, 'submitted',
					'NOTICE_RECEIVED', '2026-07-17T08:00:00.000Z')`
			)
			.run();
		expect(() =>
			database
				.prepare(
					`INSERT INTO withdrawal_case_events (
						case_id, actor, action, next_status, result_code, created_at
					) VALUES ('case_1', 'operator', 'reviewed', 'submitted', 'OK',
						'2026-07-17T08:00:00.000Z')`
				)
				.run()
		).toThrow(/CHECK constraint failed/);

		const insertMessage = database.prepare(
			`INSERT INTO withdrawal_messages (
				case_id, kind, resend_of_message_id, idempotency_key, attempt_count, next_attempt_at
			) VALUES ('case_1', ?, ?, ?, ?, '2026-07-17T08:00:00.000Z')`
		);
		insertMessage.run('receipt', null, 'withdrawal:receipt:case_1', 0);
		expect(() => insertMessage.run('unknown', null, 'unknown', 0)).toThrow(
			/CHECK constraint failed/
		);
		expect(() => insertMessage.run('resend', null, 'resend-missing', 0)).toThrow(
			/CHECK constraint failed/
		);
		expect(() => insertMessage.run('receipt', 1, 'receipt-with-source', 0)).toThrow(
			/CHECK constraint failed/
		);
		expect(() => insertMessage.run('receipt', null, 'negative-attempt', -1)).toThrow(
			/CHECK constraint failed/
		);
		insertMessage.run('resend', 1, 'resend-valid', 0);

		database
			.prepare(
				`UPDATE withdrawal_cases SET
					schema_version = NULL, encryption_key_version = NULL,
					encrypted_payload = NULL, payload_nonce = NULL, payload_tag = NULL,
					dedupe_fingerprint = NULL, purged_at = '2026-07-18T08:00:00.000Z'
				 WHERE id = 'case_1'`
			)
			.run();
	});
});

describe('initial schema UNIQUE and foreign-key behavior', () => {
	it('enforces checkout-draft primary and Checkout Session uniqueness', () => {
		insertDraft(database, { id: 'draft_one', sessionId: 'cs_shared' });
		expect(() => insertDraft(database, { id: 'draft_one', sessionId: 'cs_other' })).toThrow(
			/UNIQUE constraint failed: checkout_drafts.id/
		);
		expect(() => insertDraft(database, { id: 'draft_two', sessionId: 'cs_shared' })).toThrow(
			/UNIQUE constraint failed: checkout_drafts.stripe_checkout_session_id/
		);
	});

	it('enforces every order provider and draft uniqueness contract', () => {
		for (const id of ['base', 'session', 'payment', 'draft', 'styria', 'primary']) {
			insertDraft(database, { id: `draft_${id}`, sessionId: `cs_draft_${id}` });
		}
		insertOrder(database, {
			id: 'order_base',
			draftId: 'draft_base',
			sessionId: 'cs_order_shared',
			paymentIntentId: 'pi_order_shared',
			styriaOrderId: 'styria_shared'
		});

		expect(() =>
			insertOrder(database, {
				id: 'order_session',
				draftId: 'draft_session',
				sessionId: 'cs_order_shared'
			})
		).toThrow(/UNIQUE constraint failed: orders.stripe_checkout_session_id/);
		expect(() =>
			insertOrder(database, {
				id: 'order_payment',
				draftId: 'draft_payment',
				paymentIntentId: 'pi_order_shared'
			})
		).toThrow(/UNIQUE constraint failed: orders.stripe_payment_intent_id/);
		expect(() => insertOrder(database, { id: 'order_draft', draftId: 'draft_base' })).toThrow(
			/UNIQUE constraint failed: orders.checkout_draft_id/
		);
		expect(() =>
			insertOrder(database, {
				id: 'order_styria',
				draftId: 'draft_styria',
				styriaOrderId: 'styria_shared'
			})
		).toThrow(/UNIQUE constraint failed: orders.styria_order_id/);
		expect(() => insertOrder(database, { id: 'order_base', draftId: 'draft_primary' })).toThrow(
			/UNIQUE constraint failed: orders.id/
		);
	});

	it('enforces outbox and email idempotency keys', () => {
		insertDraft(database);
		insertOrder(database);
		const insertOutbox = database.prepare(
			`INSERT INTO outbox_jobs (kind, idempotency_key, order_id, next_attempt_at)
			 VALUES (?, ?, ?, ?)`
		);
		insertOutbox.run('paid-order-alert', 'outbox-shared', 'order_default', '2026-07-16');
		expect(() =>
			insertOutbox.run('paid-order-alert', 'outbox-shared', 'order_default', '2026-07-16')
		).toThrow(/UNIQUE constraint failed: outbox_jobs.idempotency_key/);

		const insertEmail = database.prepare(
			`INSERT INTO email_deliveries (order_id, kind, idempotency_key)
			 VALUES (?, ?, ?)`
		);
		insertEmail.run('order_default', 'shipping', 'email-shared');
		expect(() => insertEmail.run('order_default', 'shipping', 'email-shared')).toThrow(
			/UNIQUE constraint failed: email_deliveries.idempotency_key/
		);
	});

	it('enforces both composite line primary keys', () => {
		insertDraft(database);
		insertDraftLine(database);
		expect(() => insertDraftLine(database)).toThrow(
			/UNIQUE constraint failed: checkout_draft_lines.draft_id, checkout_draft_lines.line_index/
		);
		insertOrder(database);
		insertOrderLine(database, 'order_default');
		expect(() => insertOrderLine(database, 'order_default')).toThrow(
			/UNIQUE constraint failed: order_lines.order_id, order_lines.line_index/
		);
	});

	it('cascades draft lines while retaining NO ACTION on referenced orders', () => {
		insertDraft(database, { id: 'draft_cascade', sessionId: 'cs_cascade' });
		insertDraftLine(database, { draftId: 'draft_cascade' });
		database.prepare("DELETE FROM checkout_drafts WHERE id = 'draft_cascade'").run();
		expect(
			database
				.prepare(
					"SELECT count(*) AS count FROM checkout_draft_lines WHERE draft_id = 'draft_cascade'"
				)
				.get()
		).toEqual({ count: 0 });

		insertDraft(database, { id: 'draft_restrict', sessionId: 'cs_restrict' });
		insertOrder(database, { id: 'order_restrict', draftId: 'draft_restrict' });
		expect(() =>
			database.prepare("DELETE FROM checkout_drafts WHERE id = 'draft_restrict'").run()
		).toThrow(/FOREIGN KEY constraint failed/);
	});
});
