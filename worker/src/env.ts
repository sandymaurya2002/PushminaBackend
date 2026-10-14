export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;

  /** Comma-separated storefront origins allowed to call the API from a browser. */
  FRONTEND_ORIGIN?: string;
  /** Comma-separated admin dashboard origins. */
  ADMIN_ORIGIN?: string;
  /** Cash on delivery stays off unless this is "true". */
  ENABLE_COD_ORDERS?: string;
  ACCESS_TOKEN_TTL_SECONDS?: string;
  REFRESH_TOKEN_TTL_SECONDS?: string;
  ADMIN_REFRESH_TOKEN_TTL_SECONDS?: string;
  /** Absolute base for media URLs; defaults to the request origin. */
  MEDIA_PUBLIC_BASE_URL?: string;
  /** Shared secret a trusted gateway (the Render/Express proxy) sends to forward client IPs. */
  GATEWAY_SECRET?: string;

  /** Razorpay credentials (secrets). Online payment is offered only when both keys are set. */
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  /** Override of https://api.razorpay.com/v1, for tests only. */
  RAZORPAY_API_BASE?: string;

  /** Transactional email through Resend (secret). Without it emails are skipped. */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  /** Logs outgoing email bodies (including reset links) instead of dropping them. Local development only. */
  EMAIL_DEV_LOG?: string;

  /** Public storefront base URL used in emails (e.g. https://www.pashmore.com). */
  STOREFRONT_URL?: string;
  /** Shared with the storefront's /api/revalidate so admin edits purge its page cache at once (secret). */
  REVALIDATE_SECRET?: string;
}

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret?: string;
  apiBase: string;
}

export interface Config {
  frontendOrigins: string[];
  adminOrigins: string[];
  codEnabled: boolean;
  razorpay?: RazorpayConfig;
  /** True when at least one payment method can take an order. */
  checkoutEnabled: boolean;
  accessTtlMs: number;
  refreshTtlMs: number;
  adminRefreshTtlMs: number;
  mediaBaseUrl?: string;
  gatewaySecret?: string;
  resendApiKey?: string;
  mailFrom: string;
  emailDevLog: boolean;
  storefrontUrl: string;
  revalidateSecret?: string;
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

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function readConfig(env: Env): Config {
  const frontendOrigins = list(env.FRONTEND_ORIGIN);
  const keyId = trimmed(env.RAZORPAY_KEY_ID);
  const keySecret = trimmed(env.RAZORPAY_KEY_SECRET);
  const razorpay =
    keyId && keySecret
      ? {
          keyId,
          keySecret,
          webhookSecret: trimmed(env.RAZORPAY_WEBHOOK_SECRET),
          apiBase: (trimmed(env.RAZORPAY_API_BASE) ?? "https://api.razorpay.com/v1").replace(/\/+$/, ""),
        }
      : undefined;
  const codEnabled = env.ENABLE_COD_ORDERS === "true";
  return {
    frontendOrigins,
    adminOrigins: list(env.ADMIN_ORIGIN),
    codEnabled,
    razorpay,
    checkoutEnabled: codEnabled || Boolean(razorpay),
    accessTtlMs: seconds(env.ACCESS_TOKEN_TTL_SECONDS, 900, 60, 3600),
    refreshTtlMs: seconds(env.REFRESH_TOKEN_TTL_SECONDS, 30 * 86400, 3600, 90 * 86400),
    adminRefreshTtlMs: seconds(env.ADMIN_REFRESH_TOKEN_TTL_SECONDS, 12 * 3600, 900, 7 * 86400),
    mediaBaseUrl: env.MEDIA_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || undefined,
    gatewaySecret: trimmed(env.GATEWAY_SECRET),
    resendApiKey: trimmed(env.RESEND_API_KEY),
    mailFrom: trimmed(env.MAIL_FROM) ?? "Pashmore <orders@pashmore.com>",
    emailDevLog: env.EMAIL_DEV_LOG === "true",
    storefrontUrl: (trimmed(env.STOREFRONT_URL) ?? frontendOrigins[0] ?? "https://www.pashmore.com").replace(/\/+$/, ""),
    revalidateSecret: trimmed(env.REVALIDATE_SECRET),
  };
}
