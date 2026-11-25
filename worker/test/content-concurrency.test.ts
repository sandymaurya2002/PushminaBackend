import { beforeEach, describe, expect, it } from "vitest";
import { clearVersionedCache } from "../src/db/versioned";
import { call } from "./helpers";

beforeEach(() => {
  clearVersionedCache();
});

describe("content redirects and seo under concurrent load", () => {
  it("serves /content/redirects repeatedly without 500s", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => call("/api/v1/content/redirects")),
    );
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.json.success).toBe(true);
      expect(Array.isArray(result.json.data)).toBe(true);
    }
  });

  it("serves /content/seo repeatedly without 500s", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => call("/api/v1/content/seo?path=/")),
    );
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.json.success).toBe(true);
    }
  });

  it("interleaves redirects and seo like independent Worker invocations", async () => {
    const jobs = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0
        ? call("/api/v1/content/redirects")
        : call("/api/v1/content/seo?path=/collections/shawls"),
    );
    const results = await Promise.all(jobs);
    expect(results.every((result) => result.status === 200 && result.json.success)).toBe(true);
  });
});
