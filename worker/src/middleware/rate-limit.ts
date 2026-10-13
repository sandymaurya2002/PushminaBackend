import type { Context, MiddlewareHandler } from "hono";
import { tooManyRequests } from "../lib/errors";
import type { AppEnv } from "../types";

export interface RateLimitRule {
  /** Logical bucket name, e.g. "auth:login". */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Defaults to the client IP. */
  key?: (c: Context<AppEnv>) => string | Promise<string>;
}

/**
 * Fixed-window counter in D1. One atomic upsert per request; the window resets
 * in the same statement, so concurrent requests cannot both see a fresh window.
 */
export async function consume(db: D1Database, bucket: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfter: number }> {
  const now = Date.now();
  const resetAt = now + windowSeconds * 1000;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?1, 1, ?2)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
       RETURNING count, reset_at`,
    )
    .bind(bucket, resetAt, now)
    .first<{ count: number; reset_at: number }>();
  const count = row?.count ?? 1;
  const retryAfter = Math.max(1, Math.ceil(((row?.reset_at ?? resetAt) - now) / 1000));
  return { allowed: count <= limit, retryAfter };
}

export function rateLimit(rule: RateLimitRule): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = rule.key ? await rule.key(c) : c.get("clientIp");
    const { allowed, retryAfter } = await consume(c.env.DB, `${rule.name}:${key}`, rule.limit, rule.windowSeconds);
    if (!allowed) throw tooManyRequests(retryAfter);
    await next();
  };
}
