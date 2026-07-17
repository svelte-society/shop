import { RepositoryError } from '$lib/domain/orders';
import type { ShopDatabase } from '$lib/server/db/types';
import type { ReadinessResult } from '$lib/server/health/readiness.server';
import type { AlertService } from '$lib/server/monitoring/alerts.server';

const PENDING_REVIEW_AGE_MS = 24 * 60 * 60_000;
export const BACKUP_CADENCE_GRACE_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

type SubjectRow = { id: unknown };

export interface OperationalChecksJob {
	run(
		now?: Date,
		signal?: AbortSignal
	): Promise<{
		pendingReview: number;
		reviewRequired: number;
		shippingUnsent: number;
		backupMissed: boolean;
		diskLow: boolean;
		sqliteNotReady: boolean;
		retryAt?: Date | null;
	}>;
}

export type OperationalChecksDependencies = {
	database: ShopDatabase;
	alerts: AlertService;
	readiness: () => Promise<ReadinessResult>;
	clock?: () => Date;
};

function fail(code: string): never {
	throw new RepositoryError(code);
}

function validateNow(now: Date): void {
	if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
		fail('OPERATIONAL_CHECK_TIME_INVALID');
}

function subjectIds(rows: SubjectRow[]): string[] {
	return rows.map((row) => {
		if (typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(row.id)) {
			fail('OPERATIONAL_CHECK_ROW_INVALID');
		}
		return row.id;
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error('OPERATIONAL_CHECK_ABORTED');
}

function retryDate(value: unknown, now: Date): Date {
	if (typeof value !== 'string') fail('OPERATIONAL_CHECK_ROW_INVALID');
	const parsed = new Date(value);
	if (
		!Number.isFinite(parsed.getTime()) ||
		parsed.toISOString() !== value ||
		parsed.getTime() <= now.getTime()
	) {
		fail('OPERATIONAL_CHECK_ROW_INVALID');
	}
	return parsed;
}

function latestBackupCadence(now: Date): Date {
	const cadence = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 30, 0, 0)
	);
	if (cadence > now) cadence.setUTCDate(cadence.getUTCDate() - 1);
	return cadence;
}

export class SqliteOperationalChecksJob implements OperationalChecksJob {
	private readonly clock: () => Date;

	constructor(private readonly dependencies: OperationalChecksDependencies) {
		this.clock = dependencies.clock ?? (() => new Date());
	}

	async run(now = this.clock(), signal?: AbortSignal) {
		validateNow(now);
		throwIfAborted(signal);
		const pendingCutoff = new Date(now.getTime() - PENDING_REVIEW_AGE_MS).toISOString();
		const pendingReview = subjectIds(
			this.dependencies.database
				.prepare(
					`SELECT id FROM orders
					 WHERE payment_status = 'paid'
					 AND fulfillment_status = 'pending_review'
					 AND updated_at < ?
					 ORDER BY updated_at, id`
				)
				.all(pendingCutoff) as SubjectRow[]
		);
		const reviewRequired = subjectIds(
			this.dependencies.database
				.prepare(
					`SELECT id FROM orders
					 WHERE fulfillment_status = 'review_required'
					 ORDER BY updated_at, id`
				)
				.all() as SubjectRow[]
		);
		const shippingUnsent = subjectIds(
			this.dependencies.database
				.prepare(
					`SELECT o.id FROM orders o
					 WHERE o.tracking_number IS NOT NULL
					 AND NOT EXISTS (
						SELECT 1 FROM email_deliveries ed
						WHERE ed.idempotency_key = 'shipping:' || o.id || ':' || o.tracking_number
						AND ed.completed_at IS NOT NULL
					 )
					 ORDER BY o.updated_at, o.id`
				)
				.all() as SubjectRow[]
		);

		for (const subjectId of pendingReview) {
			throwIfAborted(signal);
			this.dependencies.alerts.enqueueAlert('ORDER_PENDING_REVIEW', subjectId, now);
		}
		for (const subjectId of reviewRequired) {
			throwIfAborted(signal);
			this.dependencies.alerts.enqueueAlert('STYRIA_REVIEW_REQUIRED', subjectId, now);
		}
		for (const subjectId of shippingUnsent) {
			throwIfAborted(signal);
			this.dependencies.alerts.enqueueAlert('SHIPPING_EMAIL_UNSENT', subjectId, now);
		}

		const backupCadence = latestBackupCadence(now);
		const nextBackupCadence = new Date(backupCadence.getTime() + DAY_MS);
		const completedBackup = this.dependencies.database
			.prepare(
				`SELECT 1 FROM job_runs
				 WHERE name = 'backup' AND result = 'completed'
				 AND started_at >= ? AND started_at < ?
				 AND finished_at IS NOT NULL AND finished_at <= ?
				 LIMIT 1`
			)
			.get(backupCadence.toISOString(), nextBackupCadence.toISOString(), now.toISOString());
		const activeBackup = this.dependencies.database
			.prepare(
				`SELECT jl.expires_at FROM job_runs jr
				 JOIN job_leases jl ON jl.name = jr.name AND jl.owner_id = jr.owner_id
				 WHERE jr.name = 'backup'
				 AND jr.started_at >= ? AND jr.started_at < ? AND jr.started_at <= ?
				 AND jr.finished_at IS NULL AND jr.result IS NULL
				 AND jl.expires_at > ?
				 LIMIT 1`
			)
			.get(
				backupCadence.toISOString(),
				nextBackupCadence.toISOString(),
				now.toISOString(),
				now.toISOString()
			) as { expires_at: unknown } | undefined;
		const retryAt =
			completedBackup === undefined && activeBackup !== undefined
				? retryDate(activeBackup.expires_at, now)
				: null;
		const graceElapsed = now.getTime() >= backupCadence.getTime() + BACKUP_CADENCE_GRACE_MS;
		const backupMissed =
			graceElapsed && completedBackup === undefined && activeBackup === undefined;
		if (backupMissed) {
			this.dependencies.alerts.enqueueAlert('BACKUP_MISSED', 'daily-backup', now);
		}

		throwIfAborted(signal);
		const readiness = await this.dependencies.readiness();
		throwIfAborted(signal);
		const diskLow = readiness.checks.disk === 'low';
		const sqliteNotReady =
			readiness.checks.database !== 'ok' ||
			readiness.checks.migrations !== 'ok' ||
			readiness.checks.volume !== 'ok';
		if (diskLow) this.dependencies.alerts.enqueueAlert('DISK_LOW', 'data-volume', now);
		if (sqliteNotReady) {
			this.dependencies.alerts.enqueueAlert('SQLITE_NOT_READY', 'shop-database', now);
		}

		return {
			pendingReview: pendingReview.length,
			reviewRequired: reviewRequired.length,
			shippingUnsent: shippingUnsent.length,
			backupMissed,
			diskLow,
			sqliteNotReady,
			retryAt
		};
	}
}
