import type { ShopDatabase } from '$lib/server/db/types';

export interface LeaseRepository {
	acquire(name: string, ownerId: string, now: Date, ttlMs: number): boolean;
	renew(name: string, ownerId: string, now: Date, ttlMs: number): boolean;
	release(name: string, ownerId: string): void;
}

export class SqliteLeaseRepository implements LeaseRepository {
	constructor(private readonly database: ShopDatabase) {}

	acquire(name: string, ownerId: string, now: Date, ttlMs: number): boolean {
		const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
		const result = this.database
			.prepare(
				`INSERT INTO job_leases (name, owner_id, expires_at)
				VALUES (?, ?, ?)
				ON CONFLICT(name) DO UPDATE SET
					owner_id = excluded.owner_id,
					expires_at = excluded.expires_at
				WHERE job_leases.expires_at <= ?`
			)
			.run(name, ownerId, expiresAt, now.toISOString());

		return result.changes === 1;
	}

	renew(name: string, ownerId: string, now: Date, ttlMs: number): boolean {
		const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
		const result = this.database
			.prepare(
				`UPDATE job_leases
				SET expires_at = ?
				WHERE name = ? AND owner_id = ? AND expires_at > ?`
			)
			.run(expiresAt, name, ownerId, now.toISOString());

		return result.changes === 1;
	}

	release(name: string, ownerId: string): void {
		this.database
			.prepare('DELETE FROM job_leases WHERE name = ? AND owner_id = ?')
			.run(name, ownerId);
	}
}
