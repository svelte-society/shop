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

	function copyStored(stale: boolean): CatalogSnapshot {
		if (!stored) throw new Error('CATALOG_UNAVAILABLE');
		return immutableCatalogSnapshot(stored, stale);
	}

	return {
		async get() {
			const now = clock().getTime();
			if (!Number.isFinite(now)) throw new Error('CATALOG_UNAVAILABLE');

			const age = stored ? now - stored.loadedAt.getTime() : Number.POSITIVE_INFINITY;
			if (stored && age >= 0 && age < FRESH_TTL_MS) return copyStored(false);

			try {
				const loaded = await load();
				assertCatalogSnapshot(loaded);
				if (loaded.stale) throw new Error('CATALOG_SNAPSHOT_INVALID');
				stored = immutableCatalogSnapshot(loaded, false);
				return copyStored(false);
			} catch {
				if (stored && age >= 0 && age <= STALE_IF_ERROR_MS) return copyStored(true);
				throw new Error('CATALOG_UNAVAILABLE');
			}
		}
	};
}
