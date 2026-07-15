import {
	assertCatalogSnapshot,
	immutableCatalogSnapshot,
	type CatalogSnapshot
} from '$lib/domain/catalog';

const FRESH_TTL_MS = 60_000;
const STALE_IF_ERROR_MS = 15 * 60_000;

export type CatalogCache = {
	get(): Promise<CatalogSnapshot>;
};

export type CatalogCacheOptions = {
	clock?: () => Date;
};

export function createCatalogCache(
	load: () => Promise<unknown>,
	options: CatalogCacheOptions = {}
): CatalogCache {
	const clock = options.clock ?? (() => new Date());
	let stored: CatalogSnapshot | null = null;
	let inFlightRefresh: Promise<CatalogSnapshot> | null = null;

	function currentState(): { snapshot: CatalogSnapshot | null; age: number } {
		const now = clock().getTime();
		if (!Number.isFinite(now)) throw new Error('CATALOG_UNAVAILABLE');
		return {
			snapshot: stored,
			age: stored ? now - stored.loadedAt.getTime() : Number.POSITIVE_INFINITY
		};
	}

	function copy(snapshot: CatalogSnapshot, stale: boolean): CatalogSnapshot {
		return immutableCatalogSnapshot(snapshot, stale);
	}

	function refreshOnce(): Promise<CatalogSnapshot> {
		if (inFlightRefresh) return inFlightRefresh;

		const pending = (async () => {
			const loaded = await load();
			assertCatalogSnapshot(loaded);
			if (loaded.stale) throw new Error('CATALOG_SNAPSHOT_INVALID');
			stored = immutableCatalogSnapshot(loaded, false);
			return stored;
		})();
		inFlightRefresh = pending;
		const clear = () => {
			if (inFlightRefresh === pending) inFlightRefresh = null;
		};
		void pending.then(clear, clear);
		return pending;
	}

	return {
		async get() {
			const initial = currentState();
			if (initial.snapshot && initial.age >= 0 && initial.age < FRESH_TTL_MS) {
				return copy(initial.snapshot, false);
			}

			try {
				await refreshOnce();
			} catch {
				const failed = currentState();
				if (failed.snapshot && failed.age >= 0 && failed.age <= STALE_IF_ERROR_MS) {
					return copy(failed.snapshot, true);
				}
				throw new Error('CATALOG_UNAVAILABLE');
			}

			const completed = currentState();
			if (!completed.snapshot) throw new Error('CATALOG_UNAVAILABLE');
			return copy(completed.snapshot, false);
		}
	};
}
