import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const headers = c.res.headers;
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("X-Request-Id", c.get("requestId") ?? "");
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  }
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
};
