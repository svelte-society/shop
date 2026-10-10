import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShopDatabase } from '$lib/server/db/types';
import { createMcpServer } from '../server';
import { SqliteReviewAlertDiagnosticsService } from './inspect-review-alert-outbox';

const now = new Date('2026-07-17T10:00:00.000Z');

type RpcResult = {
	result: {
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
		structuredContent?: Record<string, unknown>;
		tools?: Array<{ name: string; annotations: Record<string, boolean> }>;
	};
};

let database: ShopDatabase;

function insertAlert(input: {
	kind?: string;
	code: string;
	subject: string;
	createdAt: string;
	nextAttemptAt: string;
	completedAt?: string | null;
	attemptCount: number;
	idempotencySuffix?: string;
}): void {
	database
		.prepare(
			`INSERT INTO outbox_jobs (
				kind, idempotency_key, attempt_count, next_attempt_at, completed_at,
				last_error_code, alert_code, alert_subject_id, alert_observed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.kind ?? 'operational-alert',
			`alert:${input.code}:${input.subject}:${input.idempotencySuffix ?? input.createdAt}`,
			input.attemptCount,
			input.nextAttemptAt,
			input.completedAt ?? null,
			'PRIVATE_DELIVERY_DETAIL',
			input.code,
			input.subject,
			input.createdAt
		);
}

async function callDiagnostics() {
	const server = createMcpServer({
		reviewAlertDiagnostics: new SqliteReviewAlertDiagnosticsService(database),
		now: () => now
	});
	return (await server.receive({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name: 'inspect_review_alert_outbox', arguments: {} }
	})) as RpcResult;
}

beforeEach(() => {
	database = new Database(':memory:');
	database.exec(`
		CREATE TABLE orders (
			id TEXT PRIMARY KEY,
			fulfillment_status TEXT NOT NULL
		);
		CREATE TABLE outbox_jobs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			idempotency_key TEXT NOT NULL UNIQUE,
			attempt_count INTEGER NOT NULL,
			next_attempt_at TEXT NOT NULL,
			completed_at TEXT,
			last_error_code TEXT,
			alert_code TEXT,
			alert_subject_id TEXT,
			alert_observed_at TEXT
		);
		CREATE TABLE outbox_job_suppressions (
			outbox_job_id INTEGER PRIMARY KEY REFERENCES outbox_jobs(id),
			reason TEXT NOT NULL,
			actor TEXT NOT NULL,
			backup_id TEXT NOT NULL,
			backup_filename TEXT NOT NULL,
			backup_sha256 TEXT NOT NULL,
			previous_next_attempt_at TEXT NOT NULL,
			previous_last_error_code TEXT,
			suppressed_at TEXT NOT NULL
		);
	`);
	database
		.prepare('INSERT INTO orders (id, fulfillment_status) VALUES (?, ?)')
		.run('private_order_alpha', 'review_required');
	database
		.prepare('INSERT INTO orders (id, fulfillment_status) VALUES (?, ?)')
		.run('private_order_beta', 'review_required');
	database
		.prepare('INSERT INTO orders (id, fulfillment_status) VALUES (?, ?)')
		.run('private_order_gamma', 'pending_review');

	insertAlert({
		code: 'ORDER_PENDING_REVIEW',
		subject: 'private_order_alpha',
		createdAt: '2026-07-17T09:30:00.000Z',
		nextAttemptAt: '2026-07-17T09:31:00.000Z',
		completedAt: '2026-07-17T09:32:00.000Z',
		attemptCount: 0
	});
	insertAlert({
		code: 'STYRIA_REVIEW_REQUIRED',
		subject: 'private_order_alpha',
		createdAt: '2026-07-17T09:45:00.000Z',
		nextAttemptAt: '2026-07-17T10:05:00.000Z',
		attemptCount: 1
	});
	insertAlert({
		code: 'STYRIA_REVIEW_REQUIRED',
		subject: 'private_order_alpha',
		createdAt: '2026-07-17T08:45:00.000Z',
		nextAttemptAt: '2026-07-17T08:46:00.000Z',
		completedAt: '2026-07-17T08:46:30.000Z',
		attemptCount: 0
	});
	insertAlert({
		code: 'STYRIA_REVIEW_REQUIRED',
		subject: 'private_order_beta',
		createdAt: '2026-07-17T08:00:00.000Z',
		nextAttemptAt: '2026-07-17T09:50:00.000Z',
		attemptCount: 3
	});
	insertAlert({
		code: 'ORDER_PENDING_REVIEW',
		subject: 'private_order_gamma',
		createdAt: '2026-07-15T10:00:00.000Z',
		nextAttemptAt: '2026-07-15T10:01:00.000Z',
		attemptCount: 4
	});
	insertAlert({
		code: 'SHIPPING_EMAIL_UNSENT',
		subject: 'private_ignored_other_code',
		createdAt: '2026-07-17T09:55:00.000Z',
		nextAttemptAt: '2026-07-17T09:56:00.000Z',
		attemptCount: 8
	});
	insertAlert({
		kind: 'not-an-operational-alert',
		code: 'ORDER_PENDING_REVIEW',
		subject: 'private_ignored_other_kind',
		createdAt: '2026-07-17T09:56:00.000Z',
		nextAttemptAt: '2026-07-17T09:57:00.000Z',
		attemptCount: 9
	});
});

afterEach(() => database.close());

describe('review alert outbox diagnostics', () => {
	it('aggregates completed and outstanding review alerts without exposing subjects or payload data', async () => {
		const before = database.prepare('SELECT * FROM outbox_jobs ORDER BY id').all();
		const response = await callDiagnostics();
		const after = database.prepare('SELECT * FROM outbox_jobs ORDER BY id').all();
		const result = response.result;

		expect(result.isError).not.toBe(true);
		expect(result.content).toEqual([
			{ type: 'text', text: JSON.stringify(result.structuredContent) }
		]);
		expect(after).toEqual(before);
		expect(result.structuredContent).toMatchObject({
			as_of: '2026-07-17T10:00:00.000Z',
			created_at_source: 'alert_observed_at',
			totals: {
				alert_count: 5,
				unique_subject_count: 3,
				matched_order_count: 3,
				outstanding_count: 3,
				completed_count: 2,
				suppressed_count: 0,
				oldest_created_at: '2026-07-15T10:00:00.000Z',
				newest_created_at: '2026-07-17T09:45:00.000Z',
				oldest_outstanding_next_attempt_at: '2026-07-15T10:01:00.000Z',
				newest_outstanding_next_attempt_at: '2026-07-17T10:05:00.000Z'
			},
			subject_overlap: {
				both_codes: 1,
				order_pending_review_only: 1,
				styria_review_required_only: 1
			}
		});
		expect(result.structuredContent?.by_code).toEqual([
			expect.objectContaining({
				code: 'ORDER_PENDING_REVIEW',
				alert_count: 2,
				unique_subject_count: 2,
				matched_order_count: 2,
				delivery_statuses: [
					{ status: 'outstanding_due', alert_count: 1, unique_subject_count: 1 },
					{ status: 'outstanding_scheduled', alert_count: 0, unique_subject_count: 0 },
					{ status: 'completed', alert_count: 1, unique_subject_count: 1 },
					{ status: 'suppressed', alert_count: 0, unique_subject_count: 0 }
				],
				current_order_statuses: [
					{ status: 'pending_review', unique_subject_count: 1 },
					{ status: 'review_required', unique_subject_count: 1 }
				],
				attempt_buckets: [
					{ bucket: '0', alert_count: 1 },
					{ bucket: '1', alert_count: 0 },
					{ bucket: '2_to_3', alert_count: 0 },
					{ bucket: '4_plus', alert_count: 1 }
				]
			}),
			expect.objectContaining({
				code: 'STYRIA_REVIEW_REQUIRED',
				alert_count: 3,
				unique_subject_count: 2,
				delivery_statuses: [
					{ status: 'outstanding_due', alert_count: 1, unique_subject_count: 1 },
					{ status: 'outstanding_scheduled', alert_count: 1, unique_subject_count: 1 },
					{ status: 'completed', alert_count: 1, unique_subject_count: 1 },
					{ status: 'suppressed', alert_count: 0, unique_subject_count: 0 }
				],
				current_order_statuses: [{ status: 'review_required', unique_subject_count: 2 }],
				attempt_buckets: [
					{ bucket: '0', alert_count: 1 },
					{ bucket: '1', alert_count: 1 },
					{ bucket: '2_to_3', alert_count: 1 },
					{ bucket: '4_plus', alert_count: 0 }
				]
			})
		]);
		const ageBuckets = result.structuredContent?.created_age_buckets as Array<{
			bucket: string;
			by_code: Array<Record<string, unknown>>;
		}>;
		expect(ageBuckets.find(({ bucket }) => bucket === 'under_1_hour')?.by_code).toEqual([
			{
				code: 'ORDER_PENDING_REVIEW',
				alert_count: 1,
				unique_subject_count: 1,
				outstanding_count: 0,
				completed_count: 1,
				suppressed_count: 0
			},
			{
				code: 'STYRIA_REVIEW_REQUIRED',
				alert_count: 1,
				unique_subject_count: 1,
				outstanding_count: 1,
				completed_count: 0,
				suppressed_count: 0
			}
		]);
		expect(ageBuckets.find(({ bucket }) => bucket === 'one_to_six_hours')?.by_code).toEqual([
			expect.objectContaining({ code: 'ORDER_PENDING_REVIEW', alert_count: 0 }),
			expect.objectContaining({
				code: 'STYRIA_REVIEW_REQUIRED',
				alert_count: 2,
				outstanding_count: 1,
				completed_count: 1,
				suppressed_count: 0
			})
		]);

		const serialized = JSON.stringify(result);
		for (const forbidden of [
			'private_order_alpha',
			'private_order_beta',
			'private_order_gamma',
			'private_ignored_other_code',
			'alert:ORDER_PENDING_REVIEW:private_order_alpha:2026-07-17T09:30:00.000Z',
			'PRIVATE_DELIVERY_DETAIL',
			'idempotency_key',
			'last_error_code'
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it('reports suppressed jobs separately and excludes them from active outstanding totals', async () => {
		const row = database
			.prepare(
				`SELECT id FROM outbox_jobs
				 WHERE alert_code = 'STYRIA_REVIEW_REQUIRED'
				   AND alert_subject_id = 'private_order_beta'`
			)
			.get() as { id: number };
		database
			.prepare(
				`INSERT INTO outbox_job_suppressions (
					outbox_job_id, reason, actor, backup_id, backup_filename,
					backup_sha256, previous_next_attempt_at,
					previous_last_error_code, suppressed_at
				) VALUES (?, 'REVIEW_ALERT_BACKLOG_CLEANUP', 'codex-admin',
					'backup-private', 'backup-private.sqlite.ssbk', ?, ?, 'PRIVATE_DELIVERY_DETAIL', ?)`
			)
			.run(row.id, 'a'.repeat(64), '2026-07-17T09:50:00.000Z', now.toISOString());
		database
			.prepare('UPDATE outbox_jobs SET completed_at = ? WHERE id = ?')
			.run(now.toISOString(), row.id);

		const response = await callDiagnostics();
		expect(response.result.structuredContent?.totals).toMatchObject({
			alert_count: 5,
			outstanding_count: 2,
			completed_count: 2,
			suppressed_count: 1
		});
		const byCode = response.result.structuredContent?.by_code as Array<{
			code: string;
			delivery_statuses: Array<{ status: string; alert_count: number }>;
		}>;
		expect(
			byCode
				.find(({ code }) => code === 'STYRIA_REVIEW_REQUIRED')
				?.delivery_statuses.find(({ status }) => status === 'suppressed')
		).toMatchObject({ alert_count: 1 });
	});

	it('advertises an exact local read-only contract and rejects arbitrary query input', async () => {
		const server = createMcpServer({
			reviewAlertDiagnostics: new SqliteReviewAlertDiagnosticsService(database),
			now: () => now
		});
		const listed = (await server.receive({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: {}
		})) as RpcResult;
		const tool = listed.result.tools?.find(({ name }) => name === 'inspect_review_alert_outbox');
		expect(tool?.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		});

		const rejected = (await server.receive({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'inspect_review_alert_outbox',
				arguments: { sql: 'SELECT * FROM outbox_jobs' }
			}
		})) as RpcResult;
		expect(rejected.result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'INVALID_TOOL_ARGUMENTS' } }
		});
		expect(JSON.stringify(rejected)).not.toContain('SELECT * FROM outbox_jobs');
	});

	it('uses the existing unique idempotency-key index for every bounded aggregate query', () => {
		const prepare = vi.spyOn(database, 'prepare');

		new SqliteReviewAlertDiagnosticsService(database).inspect(now);

		const statements = prepare.mock.calls.map(([sql]) => sql as string);
		expect(statements).toHaveLength(6);
		for (const sql of statements) {
			expect(sql).toContain("idempotency_key GLOB 'alert:ORDER_PENDING_REVIEW:*'");
			expect(sql).toContain("idempotency_key GLOB 'alert:STYRIA_REVIEW_REQUIRED:*'");
			const parameters = Array.from({ length: sql.match(/\?/gu)?.length ?? 0 }, () =>
				now.toISOString()
			);
			const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{
				detail: string;
			}>;
			expect(plan.some(({ detail }) => detail.includes('sqlite_autoindex_outbox_jobs_1'))).toBe(
				true
			);
		}
	});
});
