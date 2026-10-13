import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cleanup } from "../src/index";
import { ADMIN_ORIGIN, call, registerCustomer, SHOP_ORIGIN, uniqueEmail, uniqueIp } from "./helpers";

describe("CORS", () => {
  it("allows the storefront and admin origins with credentials", async () => {
    const shop = await call("/api/v1/products", { origin: SHOP_ORIGIN });
    expect(shop.headers.get("access-control-allow-origin")).toBe(SHOP_ORIGIN);
    expect(shop.headers.get("access-control-allow-credentials")).toBe("true");
    const admin = await call("/api/v1/admin/auth/me", { origin: ADMIN_ORIGIN });
    expect(admin.headers.get("access-control-allow-origin")).toBe(ADMIN_ORIGIN);
  });

  it("answers preflight requests", async () => {
    const result = await call("/api/v1/auth/login", { method: "OPTIONS", origin: SHOP_ORIGIN, headers: { "access-control-request-method": "POST" } });
    expect(result.status).toBe(204);
    expect(result.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("rejects unknown origins and storefront origins on admin routes", async () => {
    expect((await call("/api/v1/products", { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/v1/admin/auth/login", { origin: SHOP_ORIGIN, body: { email: "a@b.co", password: "x" } })).status).toBe(403);
  });

  it("adds CORS headers to error responses too", async () => {
    const result = await call("/api/v1/auth/me", { origin: SHOP_ORIGIN });
    expect(result.status).toBe(401);
    expect(result.headers.get("access-control-allow-origin")).toBe(SHOP_ORIGIN);
  });
});

describe("security headers and errors", () => {
  it("sets hardening headers and no-store on API responses", async () => {
    const result = await call("/api/v1/auth/me");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("x-frame-options")).toBe("DENY");
    expect(result.headers.get("strict-transport-security")).toContain("max-age");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns structured JSON errors", async () => {
    const missing = await call("/api/v1/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  it("rejects malformed JSON, wrong content types and oversized bodies", async () => {
    const malformed = await call("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, rawBody: "{nope" });
    expect(malformed.status).toBe(400);
    expect(malformed.json.error?.message).toMatch(/not valid JSON/);

    const plain = await call("/api/v1/auth/login", { method: "POST", headers: { "content-type": "text/plain" }, rawBody: '{"email":"a@b.co","password":"x"}' });
    expect(plain.status).toBe(400);

    const huge = await call("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, rawBody: JSON.stringify({ email: "a@b.co", password: "x".repeat(300_000) }) });
    expect(huge.status).toBe(400);
  });

  it("validates field shapes with per-field messages", async () => {
    const result = await call("/api/v1/auth/login", { body: { email: "not-an-email", password: "" } });
    expect(result.status).toBe(422);
    expect(result.json.error?.details).toHaveProperty("email");
  });

  it("reports health with the schema check", async () => {
    const health = await call("/health");
    expect(health.status).toBe(200);
    expect(health.json.data).toMatchObject({ status: "ok", database: "d1" });
    expect(health.json.data.schema.ok).toBe(true);
  });
});

describe("rate limiting", () => {
  it("limits registrations per client IP with Retry-After", async () => {
    const ip = uniqueIp();
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await call("/api/v1/auth/register", { ip, body: { firstName: "Rate", lastName: "Limit", email: uniqueEmail(), password: "Pashmina2026!" } });
      statuses.push(result.status);
      retryAfter = result.headers.get("retry-after") ?? retryAfter;
    }
    expect(statuses.slice(0, 5).every((status) => status === 201)).toBe(true);
    expect(statuses[5]).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("ignores forwarded IPs from callers without the gateway secret", async () => {
    // Without the secret every request collapses onto the connecting IP, so spoofing X-Client-IP does not reset the limit.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await call("/api/v1/auth/register", {
        headers: { "x-gateway-secret": "wrong" },
        body: { firstName: "Spoof", lastName: "Er", email: uniqueEmail(), password: "Pashmina2026!" },
      });
      statuses.push(result.status);
    }
    expect(statuses).toContain(429);
  });
});

describe("housekeeping", () => {
  it("removes expired sessions and stale rate-limit windows", async () => {
    const { email } = await registerCustomer();
    await env.DB.prepare(`UPDATE sessions SET refresh_expires_at = 1 WHERE user_id = (SELECT id FROM users WHERE email = ?)`).bind(email).run();
    await env.DB.prepare(`INSERT INTO rate_limits (bucket, count, reset_at) VALUES ('stale', 1, 1) ON CONFLICT(bucket) DO UPDATE SET reset_at = 1`).run();
    await cleanup(env);
    const sessions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)`).bind(email).first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    expect(await env.DB.prepare(`SELECT 1 FROM rate_limits WHERE bucket = 'stale'`).first()).toBeNull();
  });
});
