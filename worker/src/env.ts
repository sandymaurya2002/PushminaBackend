export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;

  /** Comma-separated storefront origins allowed to call the API from a browser. */
  FRONTEND_ORIGIN?: string;
  /** Comma-separated admin dashboard origins. */
  ADMIN_ORIGIN?: string;
  /** Checkout stays off until payments are approved; only "true" enables COD orders. */
  ENABLE_COD_ORDERS?: string;
  ACCESS_TOKEN_TTL_SECONDS?: string;
  REFRESH_TOKEN_TTL_SECONDS?: string;
  ADMIN_REFRESH_TOKEN_TTL_SECONDS?: string;
  /** Absolute base for media URLs; defaults to the request origin. */
  MEDIA_PUBLIC_BASE_URL?: string;
  /** Shared secret a trusted gateway (the Render/Express proxy) sends to forward client IPs. */
  GATEWAY_SECRET?: string;
}

export interface Config {
  frontendOrigins: string[];
  adminOrigins: string[];
  checkoutEnabled: boolean;
  accessTtlMs: number;
  refreshTtlMs: number;
  adminRefreshTtlMs: number;
  mediaBaseUrl?: string;
  gatewaySecret?: string;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function seconds(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(Math.max(resolved, min), max) * 1000;
}

export function readConfig(env: Env): Config {
  return {
    frontendOrigins: list(env.FRONTEND_ORIGIN),
    adminOrigins: list(env.ADMIN_ORIGIN),
    checkoutEnabled: env.ENABLE_COD_ORDERS === "true",
    accessTtlMs: seconds(env.ACCESS_TOKEN_TTL_SECONDS, 900, 60, 3600),
    refreshTtlMs: seconds(env.REFRESH_TOKEN_TTL_SECONDS, 30 * 86400, 3600, 90 * 86400),
    adminRefreshTtlMs: seconds(env.ADMIN_REFRESH_TOKEN_TTL_SECONDS, 12 * 3600, 900, 7 * 86400),
    mediaBaseUrl: env.MEDIA_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || undefined,
    gatewaySecret: env.GATEWAY_SECRET?.trim() || undefined,
  };
}
