import * as v from 'valibot';
import type { GenericSchema } from 'valibot';
import type { McpServer } from 'tmcp';
import type { FulfillmentStatus } from '$lib/domain/orders';
import type { ShopDatabase } from '$lib/server/db/types';
import {
	caughtToolError,
	isInvalidToolInput,
	safeToolSchema,
	toolError,
	toolErrorSchema,
	toolResult
} from '../result';

const reviewAlertCodes = ['ORDER_PENDING_REVIEW', 'STYRIA_REVIEW_REQUIRED'] as const;
const deliveryStatuses = [
	'outstanding_due',
	'outstanding_scheduled',
	'completed',
	'suppressed'
] as const;
const attemptBuckets = ['0', '1', '2_to_3', '4_plus'] as const;
const createdAgeBuckets = [
	'future',
	'under_1_hour',
	'one_to_six_hours',
	'six_to_twenty_four_hours',
	'one_to_seven_days',
	'older_than_seven_days'
] as const;
const fulfillmentStatuses = [
	'pending_review',
	'submitting',
	'submitted',
	'awaiting_vendor_payment',
	'in_production',
	'shipped',
	'review_required',
	'cancelled'
] as const satisfies readonly FulfillmentStatus[];
const currentOrderStatuses = [...fulfillmentStatuses, 'missing'] as const;

type ReviewAlertCode = (typeof reviewAlertCodes)[number];
type DeliveryStatus = (typeof deliveryStatuses)[number];
type AttemptBucket = (typeof attemptBuckets)[number];
type CreatedAgeBucket = (typeof createdAgeBuckets)[number];
type CurrentOrderStatus = (typeof currentOrderStatuses)[number];

type CountByStatus<TStatus extends string> = {
	status: TStatus;
	alertCount: number;
	uniqueSubjectCount: number;
};

export type ReviewAlertCodeDiagnostics = {
	code: ReviewAlertCode;
	alertCount: number;
	uniqueSubjectCount: number;
	matchedOrderCount: number;
	oldestCreatedAt: Date | null;
	newestCreatedAt: Date | null;
	oldestOutstandingNextAttemptAt: Date | null;
	newestOutstandingNextAttemptAt: Date | null;
	deliveryStatuses: CountByStatus<DeliveryStatus>[];
	currentOrderStatuses: Array<{ status: CurrentOrderStatus; uniqueSubjectCount: number }>;
	attemptBuckets: Array<{ bucket: AttemptBucket; alertCount: number }>;
};

export type ReviewAlertDiagnostics = {
	asOf: Date;
	alertCount: number;
	uniqueSubjectCount: number;
	matchedOrderCount: number;
	outstandingCount: number;
	completedCount: number;
	suppressedCount: number;
	oldestCreatedAt: Date | null;
	newestCreatedAt: Date | null;
	oldestOutstandingNextAttemptAt: Date | null;
	newestOutstandingNextAttemptAt: Date | null;
	byCode: ReviewAlertCodeDiagnostics[];
	subjectOverlap: {
		bothCodes: number;
		orderPendingReviewOnly: number;
		styriaReviewRequiredOnly: number;
	};
	createdAgeBuckets: Array<{
		bucket: CreatedAgeBucket;
		byCode: Array<{
			code: ReviewAlertCode;
			alertCount: number;
			uniqueSubjectCount: number;
			outstandingCount: number;
			completedCount: number;
			suppressedCount: number;
		}>;
	}>;
};

export type ReviewAlertDiagnosticsService = {
	inspect(now: Date): ReviewAlertDiagnostics;
};

type CodeSummaryRow = {
	alert_code: unknown;
	alert_count: unknown;
	unique_subject_count: unknown;
	matched_order_count: unknown;
	oldest_created_at: unknown;
	newest_created_at: unknown;
	oldest_outstanding_next_attempt_at: unknown;
	newest_outstanding_next_attempt_at: unknown;
};

type DeliveryStatusRow = {
	alert_code: unknown;
	status: unknown;
	alert_count: unknown;
	unique_subject_count: unknown;
};

type CurrentOrderStatusRow = {
	alert_code: unknown;
	status: unknown;
	unique_subject_count: unknown;
};

type AttemptBucketRow = {
	alert_code: unknown;
	bucket: unknown;
	alert_count: unknown;
};

type OverlapRow = {
	both_codes: unknown;
	order_pending_review_only: unknown;
	styria_review_required_only: unknown;
	matched_order_count: unknown;
};

type CreatedAgeBucketRow = {
	bucket: unknown;
	alert_code: unknown;
	alert_count: unknown;
	unique_subject_count: unknown;
	outstanding_count: unknown;
	completed_count: unknown;
	suppressed_count: unknown;
};

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const REVIEW_ALERT_KEY_PREDICATE = `((alert_code = 'ORDER_PENDING_REVIEW'
	AND idempotency_key GLOB 'alert:ORDER_PENDING_REVIEW:*')
	OR (alert_code = 'STYRIA_REVIEW_REQUIRED'
		AND idempotency_key GLOB 'alert:STYRIA_REVIEW_REQUIRED:*'))`;
const QUALIFIED_REVIEW_ALERT_KEY_PREDICATE = `((oj.alert_code = 'ORDER_PENDING_REVIEW'
	AND oj.idempotency_key GLOB 'alert:ORDER_PENDING_REVIEW:*')
	OR (oj.alert_code = 'STYRIA_REVIEW_REQUIRED'
		AND oj.idempotency_key GLOB 'alert:STYRIA_REVIEW_REQUIRED:*'))`;

class ReviewAlertDiagnosticsError extends Error {
	constructor(readonly code: 'ALERT_OUTBOX_TIME_INVALID' | 'ALERT_OUTBOX_ROW_INVALID') {
		super(code);
		this.name = 'ReviewAlertDiagnosticsError';
	}
}

function isReviewAlertCode(value: unknown): value is ReviewAlertCode {
	return reviewAlertCodes.includes(value as ReviewAlertCode);
}

function isFulfillmentStatus(value: unknown): value is FulfillmentStatus {
	return fulfillmentStatuses.includes(value as FulfillmentStatus);
}

function isCurrentOrderStatus(value: unknown): value is CurrentOrderStatus {
	return value === 'missing' || isFulfillmentStatus(value);
}

function isDeliveryStatus(value: unknown): value is DeliveryStatus {
	return deliveryStatuses.includes(value as DeliveryStatus);
}

function isAttemptBucket(value: unknown): value is AttemptBucket {
	return attemptBuckets.includes(value as AttemptBucket);
}

function isCreatedAgeBucket(value: unknown): value is CreatedAgeBucket {
	return createdAgeBuckets.includes(value as CreatedAgeBucket);
}

function validCount(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
	}
	return value as number;
}

function nullableIsoDate(value: unknown): Date | null {
	if (value === null) return null;
	if (typeof value !== 'string') {
		throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
	}
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
		throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
	}
	return parsed;
}

function extremum(dates: readonly (Date | null)[], mode: 'oldest' | 'newest'): Date | null {
	const timestamps = dates.flatMap((date) => (date ? [date.getTime()] : []));
	if (timestamps.length === 0) return null;
	return new Date(mode === 'oldest' ? Math.min(...timestamps) : Math.max(...timestamps));
}

export class SqliteReviewAlertDiagnosticsService implements ReviewAlertDiagnosticsService {
	constructor(private readonly database: ShopDatabase) {}

	inspect(now: Date): ReviewAlertDiagnostics {
		if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
			throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_TIME_INVALID');
		}
		const nowTimestamp = now.toISOString();
		const oneHourAgo = new Date(now.getTime() - HOUR_MS).toISOString();
		const sixHoursAgo = new Date(now.getTime() - 6 * HOUR_MS).toISOString();
		const oneDayAgo = new Date(now.getTime() - DAY_MS).toISOString();
		const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
		// These fixed prefixes use the existing UNIQUE idempotency-key index, avoiding a scan of
		// unrelated commerce, shipping, withdrawal, and operational-alert history.
		const readSnapshot = this.database.transaction(() => ({
			codeSummaries: this.database
				.prepare(
					`SELECT oj.alert_code,
						COUNT(*) AS alert_count,
						COUNT(DISTINCT oj.alert_subject_id) AS unique_subject_count,
						COUNT(DISTINCT CASE WHEN o.id IS NOT NULL THEN oj.alert_subject_id END)
							AS matched_order_count,
						MIN(oj.alert_observed_at) AS oldest_created_at,
						MAX(oj.alert_observed_at) AS newest_created_at,
						MIN(CASE WHEN oj.completed_at IS NULL AND suppression.outbox_job_id IS NULL
							THEN oj.next_attempt_at END)
							AS oldest_outstanding_next_attempt_at,
						MAX(CASE WHEN oj.completed_at IS NULL AND suppression.outbox_job_id IS NULL
							THEN oj.next_attempt_at END)
							AS newest_outstanding_next_attempt_at
					 FROM outbox_jobs AS oj
					 LEFT JOIN orders AS o ON o.id = oj.alert_subject_id
					 LEFT JOIN outbox_job_suppressions AS suppression
						ON suppression.outbox_job_id = oj.id
					 WHERE oj.kind = 'operational-alert'
					   AND ${QUALIFIED_REVIEW_ALERT_KEY_PREDICATE}
					   AND oj.alert_code IN ('ORDER_PENDING_REVIEW', 'STYRIA_REVIEW_REQUIRED')
					 GROUP BY oj.alert_code`
				)
				.all() as CodeSummaryRow[],
			deliveryStatuses: this.database
				.prepare(
					`SELECT oj.alert_code,
						CASE
							WHEN suppression.outbox_job_id IS NOT NULL THEN 'suppressed'
							WHEN oj.completed_at IS NOT NULL THEN 'completed'
							WHEN oj.next_attempt_at <= ? THEN 'outstanding_due'
							ELSE 'outstanding_scheduled'
						END AS status,
						COUNT(*) AS alert_count,
						COUNT(DISTINCT oj.alert_subject_id) AS unique_subject_count
					 FROM outbox_jobs AS oj
					 LEFT JOIN outbox_job_suppressions AS suppression
						ON suppression.outbox_job_id = oj.id
					 WHERE oj.kind = 'operational-alert'
					   AND ${QUALIFIED_REVIEW_ALERT_KEY_PREDICATE}
					   AND oj.alert_code IN ('ORDER_PENDING_REVIEW', 'STYRIA_REVIEW_REQUIRED')
					 GROUP BY oj.alert_code, status`
				)
				.all(nowTimestamp) as DeliveryStatusRow[],
			currentOrderStatuses: this.database
				.prepare(
					`SELECT oj.alert_code, COALESCE(o.fulfillment_status, 'missing') AS status,
						COUNT(DISTINCT oj.alert_subject_id) AS unique_subject_count
					 FROM outbox_jobs AS oj
					 LEFT JOIN orders AS o ON o.id = oj.alert_subject_id
					 WHERE oj.kind = 'operational-alert'
					   AND ${QUALIFIED_REVIEW_ALERT_KEY_PREDICATE}
					   AND oj.alert_code IN ('ORDER_PENDING_REVIEW', 'STYRIA_REVIEW_REQUIRED')
					 GROUP BY oj.alert_code, status`
				)
				.all() as CurrentOrderStatusRow[],
			attemptBuckets: this.database
				.prepare(
					`SELECT alert_code,
						CASE
							WHEN attempt_count = 0 THEN '0'
							WHEN attempt_count = 1 THEN '1'
							WHEN attempt_count <= 3 THEN '2_to_3'
							ELSE '4_plus'
						END AS bucket,
						COUNT(*) AS alert_count
					 FROM outbox_jobs
					 WHERE kind = 'operational-alert'
					   AND ${REVIEW_ALERT_KEY_PREDICATE}
					   AND alert_code IN ('ORDER_PENDING_REVIEW', 'STYRIA_REVIEW_REQUIRED')
					 GROUP BY alert_code, bucket`
				)
				.all() as AttemptBucketRow[],
			overlap: this.database
				.prepare(
					`WITH subject_codes AS (
						SELECT alert_subject_id,
							MAX(alert_code = 'ORDER_PENDING_REVIEW') AS has_order_pending,
							MAX(alert_code = 'STYRIA_REVIEW_REQUIRED') AS has_styria_review
						FROM outbox_jobs
						WHERE kind = 'operational-alert'
						  AND ${REVIEW_ALERT_KEY_PREDICATE}
						  AND alert_code IN ('ORDER_PENDING_REVIEW', 'STYRIA_REVIEW_REQUIRED')
						GROUP BY alert_subject_id
					)
					SELECT
						COALESCE(SUM(has_order_pending = 1 AND has_styria_review = 1), 0) AS both_codes,
						COALESCE(SUM(has_order_pending = 1 AND has_styria_review = 0), 0)
							AS order_pending_review_only,
						COALESCE(SUM(has_order_pending = 0 AND has_styria_review = 1), 0)
							AS styria_review_required_only,
						COUNT(o.id) AS matched_order_count
					FROM subject_codes AS sc
					LEFT JOIN orders AS o ON o.id = sc.alert_subject_id`
				)
				.get() as OverlapRow,
			createdAgeBuckets: this.database
				.prepare(
					`SELECT
						CASE
							WHEN oj.alert_observed_at > ? THEN 'future'
							WHEN oj.alert_observed_at > ? THEN 'under_1_hour'
							WHEN oj.alert_observed_at > ? THEN 'one_to_six_hours'
							WHEN oj.alert_observed_at > ? THEN 'six_to_twenty_four_hours'
							WHEN oj.alert_observed_at > ? THEN 'one_to_seven_days'
							ELSE 'older_than_seven_days'
						END AS bucket,
						oj.alert_code,
						COUNT(*) AS alert_count,
						COUNT(DISTINCT oj.alert_subject_id) AS unique_subject_count,
						SUM(oj.completed_at IS NULL AND suppression.outbox_job_id IS NULL)
							AS outstanding_count,
						SUM(oj.completed_at IS NOT NULL AND suppression.outbox_job_id IS NULL)
							AS completed_count,
						SUM(suppression.outbox_job_id IS NOT NULL)
							AS suppressed_count
					 FROM outbox_jobs AS oj
					 LEFT JOIN outbox_job_suppressions AS suppression
						ON suppression.outbox_job_id = oj.id
					 WHERE oj.kind = 'operational-alert'
					   AND ${QUALIFIED_REVIEW_ALERT_KEY_PREDICATE}
					   AND oj.alert_code IN ('ORDER_PENDING_REVIEW', 'STYRIA_REVIEW_REQUIRED')
					 GROUP BY bucket, oj.alert_code`
				)
				.all(
					nowTimestamp,
					oneHourAgo,
					sixHoursAgo,
					oneDayAgo,
					sevenDaysAgo
				) as CreatedAgeBucketRow[]
		}));
		const snapshot = readSnapshot.deferred();
		for (const row of snapshot.deliveryStatuses) {
			if (!isReviewAlertCode(row.alert_code) || !isDeliveryStatus(row.status)) {
				throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
			}
		}
		for (const row of snapshot.currentOrderStatuses) {
			if (!isReviewAlertCode(row.alert_code) || !isCurrentOrderStatus(row.status)) {
				throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
			}
		}
		for (const row of snapshot.attemptBuckets) {
			if (!isReviewAlertCode(row.alert_code) || !isAttemptBucket(row.bucket)) {
				throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
			}
		}
		const codeSummaries = new Map<ReviewAlertCode, ReviewAlertCodeDiagnostics>();
		for (const row of snapshot.codeSummaries) {
			if (!isReviewAlertCode(row.alert_code) || codeSummaries.has(row.alert_code)) {
				throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
			}
			const alertCount = validCount(row.alert_count);
			const uniqueSubjectCount = validCount(row.unique_subject_count);
			const matchedOrderCount = validCount(row.matched_order_count);
			const oldestCreatedAt = nullableIsoDate(row.oldest_created_at);
			const newestCreatedAt = nullableIsoDate(row.newest_created_at);
			if (
				alertCount < 1 ||
				uniqueSubjectCount > alertCount ||
				matchedOrderCount > uniqueSubjectCount ||
				!oldestCreatedAt ||
				!newestCreatedAt
			) {
				throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
			}
			codeSummaries.set(row.alert_code, {
				code: row.alert_code,
				alertCount,
				uniqueSubjectCount,
				matchedOrderCount,
				oldestCreatedAt,
				newestCreatedAt,
				oldestOutstandingNextAttemptAt: nullableIsoDate(row.oldest_outstanding_next_attempt_at),
				newestOutstandingNextAttemptAt: nullableIsoDate(row.newest_outstanding_next_attempt_at),
				deliveryStatuses: [],
				currentOrderStatuses: [],
				attemptBuckets: []
			});
		}

		const codeDiagnostics = reviewAlertCodes.map(
			(code) =>
				codeSummaries.get(code) ?? {
					code,
					alertCount: 0,
					uniqueSubjectCount: 0,
					matchedOrderCount: 0,
					oldestCreatedAt: null,
					newestCreatedAt: null,
					oldestOutstandingNextAttemptAt: null,
					newestOutstandingNextAttemptAt: null,
					deliveryStatuses: [],
					currentOrderStatuses: [],
					attemptBuckets: []
				}
		);
		for (const code of codeDiagnostics) {
			code.deliveryStatuses = deliveryStatuses.map((status) => {
				const rows = snapshot.deliveryStatuses.filter(
					(row) => row.alert_code === code.code && row.status === status
				);
				if (rows.length > 1) {
					throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
				}
				const row = rows[0];
				return {
					status,
					alertCount: row ? validCount(row.alert_count) : 0,
					uniqueSubjectCount: row ? validCount(row.unique_subject_count) : 0
				};
			});
			code.currentOrderStatuses = snapshot.currentOrderStatuses
				.flatMap((row) => {
					if (row.alert_code !== code.code) return [];
					if (!isCurrentOrderStatus(row.status)) {
						throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
					}
					return [
						{
							status: row.status,
							uniqueSubjectCount: validCount(row.unique_subject_count)
						}
					];
				})
				.sort(
					(left, right) =>
						currentOrderStatuses.indexOf(left.status) - currentOrderStatuses.indexOf(right.status)
				);
			code.attemptBuckets = attemptBuckets.map((bucket) => {
				const rows = snapshot.attemptBuckets.filter(
					(row) => row.alert_code === code.code && row.bucket === bucket
				);
				if (rows.length > 1) {
					throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
				}
				return { bucket, alertCount: rows[0] ? validCount(rows[0].alert_count) : 0 };
			});
			if (
				code.deliveryStatuses.reduce((sum, status) => sum + status.alertCount, 0) !==
					code.alertCount ||
				code.attemptBuckets.reduce((sum, bucket) => sum + bucket.alertCount, 0) !==
					code.alertCount ||
				code.currentOrderStatuses.reduce((sum, status) => sum + status.uniqueSubjectCount, 0) !==
					code.uniqueSubjectCount
			) {
				throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
			}
		}

		const overlap = {
			bothCodes: validCount(snapshot.overlap.both_codes),
			orderPendingReviewOnly: validCount(snapshot.overlap.order_pending_review_only),
			styriaReviewRequiredOnly: validCount(snapshot.overlap.styria_review_required_only)
		};
		const matchedOrderCount = validCount(snapshot.overlap.matched_order_count);
		const ageRows = snapshot.createdAgeBuckets.map((row) => {
			if (!isCreatedAgeBucket(row.bucket) || !isReviewAlertCode(row.alert_code)) {
				throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
			}
			const alertCount = validCount(row.alert_count);
			const outstandingCount = validCount(row.outstanding_count);
			const completedCount = validCount(row.completed_count);
			const suppressedCount = validCount(row.suppressed_count);
			if (outstandingCount + completedCount + suppressedCount !== alertCount) {
				throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
			}
			return {
				bucket: row.bucket,
				code: row.alert_code,
				alertCount,
				uniqueSubjectCount: validCount(row.unique_subject_count),
				outstandingCount,
				completedCount,
				suppressedCount
			};
		});
		const createdAgeDistribution = createdAgeBuckets.map((bucket) => ({
			bucket,
			byCode: reviewAlertCodes.map((code) => {
				const rows = ageRows.filter((row) => row.bucket === bucket && row.code === code);
				if (rows.length > 1) {
					throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
				}
				return (
					rows[0] ?? {
						code,
						alertCount: 0,
						uniqueSubjectCount: 0,
						outstandingCount: 0,
						completedCount: 0,
						suppressedCount: 0
					}
				);
			})
		}));
		for (const code of codeDiagnostics) {
			const bucketTotal = createdAgeDistribution.reduce(
				(sum, bucket) =>
					sum + (bucket.byCode.find((count) => count.code === code.code)?.alertCount ?? 0),
				0
			);
			if (bucketTotal !== code.alertCount) {
				throw new ReviewAlertDiagnosticsError('ALERT_OUTBOX_ROW_INVALID');
			}
		}

		const alertCount = codeDiagnostics.reduce((sum, code) => sum + code.alertCount, 0);
		const completedCount = codeDiagnostics.reduce(
			(sum, code) =>
				sum +
				(code.deliveryStatuses.find((status) => status.status === 'completed')?.alertCount ?? 0),
			0
		);
		const suppressedCount = codeDiagnostics.reduce(
			(sum, code) =>
				sum +
				(code.deliveryStatuses.find((status) => status.status === 'suppressed')?.alertCount ?? 0),
			0
		);

		return {
			asOf: new Date(now),
			alertCount,
			uniqueSubjectCount:
				overlap.bothCodes + overlap.orderPendingReviewOnly + overlap.styriaReviewRequiredOnly,
			matchedOrderCount,
			outstandingCount: alertCount - completedCount - suppressedCount,
			completedCount,
			suppressedCount,
			oldestCreatedAt: extremum(
				codeDiagnostics.map((code) => code.oldestCreatedAt),
				'oldest'
			),
			newestCreatedAt: extremum(
				codeDiagnostics.map((code) => code.newestCreatedAt),
				'newest'
			),
			oldestOutstandingNextAttemptAt: extremum(
				codeDiagnostics.map((code) => code.oldestOutstandingNextAttemptAt),
				'oldest'
			),
			newestOutstandingNextAttemptAt: extremum(
				codeDiagnostics.map((code) => code.newestOutstandingNextAttemptAt),
				'newest'
			),
			byCode: codeDiagnostics,
			subjectOverlap: overlap,
			createdAgeBuckets: createdAgeDistribution
		};
	}
}

const countSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const nullableTimestampSchema = v.nullable(v.string());
const deliveryStatusSchema = v.strictObject({
	status: v.picklist(deliveryStatuses),
	alert_count: countSchema,
	unique_subject_count: countSchema
});
const currentOrderStatusSchema = v.strictObject({
	status: v.picklist(currentOrderStatuses),
	unique_subject_count: countSchema
});
const attemptBucketSchema = v.strictObject({
	bucket: v.picklist(attemptBuckets),
	alert_count: countSchema
});
const codeDiagnosticsSchema = v.strictObject({
	code: v.picklist(reviewAlertCodes),
	alert_count: countSchema,
	unique_subject_count: countSchema,
	matched_order_count: countSchema,
	oldest_created_at: nullableTimestampSchema,
	newest_created_at: nullableTimestampSchema,
	oldest_outstanding_next_attempt_at: nullableTimestampSchema,
	newest_outstanding_next_attempt_at: nullableTimestampSchema,
	delivery_statuses: v.array(deliveryStatusSchema),
	current_order_statuses: v.array(currentOrderStatusSchema),
	attempt_buckets: v.array(attemptBucketSchema)
});
const ageCodeSchema = v.strictObject({
	code: v.picklist(reviewAlertCodes),
	alert_count: countSchema,
	unique_subject_count: countSchema,
	outstanding_count: countSchema,
	completed_count: countSchema,
	suppressed_count: countSchema
});
const inputSchema = safeToolSchema(v.strictObject({}));
const outputSchema = v.strictObject({
	as_of: v.optional(v.string()),
	created_at_source: v.optional(v.literal('alert_observed_at')),
	totals: v.optional(
		v.strictObject({
			alert_count: countSchema,
			unique_subject_count: countSchema,
			matched_order_count: countSchema,
			outstanding_count: countSchema,
			completed_count: countSchema,
			suppressed_count: countSchema,
			oldest_created_at: nullableTimestampSchema,
			newest_created_at: nullableTimestampSchema,
			oldest_outstanding_next_attempt_at: nullableTimestampSchema,
			newest_outstanding_next_attempt_at: nullableTimestampSchema
		})
	),
	by_code: v.optional(v.array(codeDiagnosticsSchema)),
	subject_overlap: v.optional(
		v.strictObject({
			both_codes: countSchema,
			order_pending_review_only: countSchema,
			styria_review_required_only: countSchema
		})
	),
	created_age_buckets: v.optional(
		v.array(
			v.strictObject({
				bucket: v.picklist(createdAgeBuckets),
				by_code: v.array(ageCodeSchema)
			})
		)
	),
	error: toolErrorSchema
});

function timestamp(value: Date | null): string | null {
	return value?.toISOString() ?? null;
}

function publicDiagnostics(diagnostics: ReviewAlertDiagnostics) {
	return {
		as_of: diagnostics.asOf.toISOString(),
		created_at_source: 'alert_observed_at' as const,
		totals: {
			alert_count: diagnostics.alertCount,
			unique_subject_count: diagnostics.uniqueSubjectCount,
			matched_order_count: diagnostics.matchedOrderCount,
			outstanding_count: diagnostics.outstandingCount,
			completed_count: diagnostics.completedCount,
			suppressed_count: diagnostics.suppressedCount,
			oldest_created_at: timestamp(diagnostics.oldestCreatedAt),
			newest_created_at: timestamp(diagnostics.newestCreatedAt),
			oldest_outstanding_next_attempt_at: timestamp(diagnostics.oldestOutstandingNextAttemptAt),
			newest_outstanding_next_attempt_at: timestamp(diagnostics.newestOutstandingNextAttemptAt)
		},
		by_code: diagnostics.byCode.map((code) => ({
			code: code.code,
			alert_count: code.alertCount,
			unique_subject_count: code.uniqueSubjectCount,
			matched_order_count: code.matchedOrderCount,
			oldest_created_at: timestamp(code.oldestCreatedAt),
			newest_created_at: timestamp(code.newestCreatedAt),
			oldest_outstanding_next_attempt_at: timestamp(code.oldestOutstandingNextAttemptAt),
			newest_outstanding_next_attempt_at: timestamp(code.newestOutstandingNextAttemptAt),
			delivery_statuses: code.deliveryStatuses.map((status) => ({
				status: status.status,
				alert_count: status.alertCount,
				unique_subject_count: status.uniqueSubjectCount
			})),
			current_order_statuses: code.currentOrderStatuses.map((status) => ({
				status: status.status,
				unique_subject_count: status.uniqueSubjectCount
			})),
			attempt_buckets: code.attemptBuckets.map((bucket) => ({
				bucket: bucket.bucket,
				alert_count: bucket.alertCount
			}))
		})),
		subject_overlap: {
			both_codes: diagnostics.subjectOverlap.bothCodes,
			order_pending_review_only: diagnostics.subjectOverlap.orderPendingReviewOnly,
			styria_review_required_only: diagnostics.subjectOverlap.styriaReviewRequiredOnly
		},
		created_age_buckets: diagnostics.createdAgeBuckets.map((bucket) => ({
			bucket: bucket.bucket,
			by_code: bucket.byCode.map((code) => ({
				code: code.code,
				alert_count: code.alertCount,
				unique_subject_count: code.uniqueSubjectCount,
				outstanding_count: code.outstandingCount,
				completed_count: code.completedCount,
				suppressed_count: code.suppressedCount
			}))
		}))
	};
}

export function registerInspectReviewAlertOutboxTool(
	server: McpServer<GenericSchema>,
	diagnostics: ReviewAlertDiagnosticsService | undefined,
	now: () => Date
): void {
	server.tool(
		{
			name: 'inspect_review_alert_outbox',
			description:
				'Inspect aggregate local outbox state for ORDER_PENDING_REVIEW and STYRIA_REVIEW_REQUIRED without returning subject IDs, message contents, contact data, or secrets.',
			schema: inputSchema,
			outputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		(input) => {
			if (isInvalidToolInput(input)) return toolError('INVALID_TOOL_ARGUMENTS');
			if (!diagnostics) return toolError('MCP_ALERT_DIAGNOSTICS_SERVICE_UNAVAILABLE');
			try {
				return toolResult(publicDiagnostics(diagnostics.inspect(now())));
			} catch (error) {
				return caughtToolError(error, 'ALERT_OUTBOX_DIAGNOSTICS_FAILED');
			}
		}
	);
}
