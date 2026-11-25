import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearVersionedCache, versioned } from "../src/db/versioned";

/**
 * Simulates independent Worker invocations that must never share a pending
 * D1 Promise. Each call gets its own fake DB handle identity.
 */
function fakeDb(version = 1) {
  const prepare = vi.fn((sql: string) => ({
    bind: () => ({
      first: async () => (sql.includes("cache_versions") ? { version } : null),
      all: async () => ({ results: [] }),
    }),
  }));
  return { prepare, batch: vi.fn() } as unknown as D1Database;
}

beforeEach(() => {
  clearVersionedCache();
});

describe("versioned cache request isolation", () => {
  it("stores only resolved values, not pending promises", async () => {
    const db = fakeDb(1);
    let resolveLoad!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveLoad = resolve;
    });

    const first = versioned(db, "content", "site", () => pending);
    // Cache must not be readable as a shared Promise while load is in flight.
    const secondStart = Date.now();
    const secondPromise = versioned(db, "content", "site", async () => "from-second");

    resolveLoad("from-first");
    await expect(first).resolves.toBe("from-first");
    await expect(secondPromise).resolves.toBe("from-second");
    expect(Date.now() - secondStart).toBeGreaterThanOrEqual(0);

    // After resolution, later calls reuse plain data without calling load.
    let loads = 0;
    const cached = await versioned(db, "content", "site", async () => {
      loads += 1;
      return "should-not-run";
    });
    expect(cached).toBe("from-second");
    expect(loads).toBe(0);
  });

  it("does not poison the cache when load fails", async () => {
    const db = fakeDb(3);
    await expect(
      versioned(db, "content", "site", async () => {
        throw new Error("d1 unavailable");
      }),
    ).rejects.toThrow(/d1 unavailable/);

    const value = await versioned(db, "content", "site", async () => "recovered");
    expect(value).toBe("recovered");
  });

  it("reloads when the cache version advances", async () => {
    let version = 1;
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => (sql.includes("cache_versions") ? { version } : null),
        }),
      }),
    } as unknown as D1Database;

    expect(await versioned(db, "catalog", "published", async () => "v1")).toBe("v1");
    version = 2;
    expect(await versioned(db, "catalog", "published", async () => "v2")).toBe("v2");
  });

  it("handles concurrent independent loads without sharing I/O promises", async () => {
    const dbA = fakeDb(1);
    const dbB = fakeDb(1);
    const order: string[] = [];

    const [a, b] = await Promise.all([
      versioned(dbA, "content", "site", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("a-end");
        return { source: "A" };
      }),
      versioned(dbB, "content", "site", async () => {
        order.push("b-start");
        await new Promise((r) => setTimeout(r, 5));
        order.push("b-end");
        return { source: "B" };
      }),
    ]);

    expect(a.source).toBe("A");
    expect(b.source).toBe("B");
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });
});
