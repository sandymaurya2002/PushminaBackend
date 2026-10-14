/**
 * Per-isolate cache for data that is read on every storefront request but
 * changes rarely (the published catalogue, site content).
 *
 * Every write to the underlying tables changes a row in `cache_versions`
 * through triggers, in the same transaction as the write. A request costs one
 * single-row read to compare versions; the full reload only happens after a
 * change, so admin edits still show up on the very next request.
 */
const MAX_AGE_MS = 10 * 60 * 1000;

interface Entry {
  version: number;
  loadedAt: number;
  value: Promise<unknown>;
}

const entries = new Map<string, Entry>();

export type CacheKey = "catalog" | "content";

export async function cacheVersion(db: D1Database, key: CacheKey): Promise<number> {
  const row = await db.prepare(`SELECT version FROM cache_versions WHERE key = ?`).bind(key).first<{ version: number }>();
  return row?.version ?? 0;
}

export async function versioned<T>(db: D1Database, key: CacheKey, slot: string, load: () => Promise<T>): Promise<T> {
  const version = await cacheVersion(db, key);
  const id = `${key}:${slot}`;
  const now = Date.now();
  const hit = entries.get(id);
  if (hit && hit.version === version && now - hit.loadedAt < MAX_AGE_MS) return hit.value as Promise<T>;

  const value = load();
  entries.set(id, { version, loadedAt: now, value });
  value.catch(() => {
    if (entries.get(id)?.value === value) entries.delete(id);
  });
  return value;
}

export function clearVersionedCache(): void {
  entries.clear();
}
