import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

const ALLOWED_HEADERS = "Content-Type, Authorization, Idempotency-Key, X-Requested-With";
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const EXPOSED_HEADERS = "Content-Disposition, Retry-After, X-Request-Id";

function deny(message: string): Response {
  return new Response(JSON.stringify({ success: false, error: { code: "ORIGIN_DENIED", message } }), {
    status: 403,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Origin" },
  });
}

/**
 * Browser access is limited to the configured storefront and admin origins.
 * Requests without an Origin header (server-to-server, e.g. the Next.js
 * storefront's server) are not CORS requests and pass through; they still face
 * authentication. A disallowed Origin is rejected outright, which also blocks
 * cross-site form/fetch CSRF against cookie-authenticated endpoints.
 */
export const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("origin");
  if (!origin) {
    await next();
    return;
  }

  const { frontendOrigins, adminOrigins } = c.get("config");
  const path = new URL(c.req.url).pathname;
  const isAdminPath = path.startsWith("/api/v1/admin");
  const allowed = isAdminPath ? adminOrigins.includes(origin) : adminOrigins.includes(origin) || frontendOrigins.includes(origin);
  if (!allowed) return deny("Origin not allowed.");

  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": ALLOWED_METHODS,
        "Access-Control-Allow-Headers": ALLOWED_HEADERS,
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      },
    });
  }

  await next();
  c.res.headers.set("Access-Control-Allow-Origin", origin);
  c.res.headers.set("Access-Control-Allow-Credentials", "true");
  c.res.headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
  c.res.headers.append("Vary", "Origin");
};
