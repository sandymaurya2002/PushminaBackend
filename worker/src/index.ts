import { Hono, type MiddlewareHandler } from "hono";
import { ensureSchema } from "./db/schema";
import { readConfig, type Env } from "./env";
import { ApiError, notImplemented, serviceUnavailable } from "./lib/errors";
import { revalidateAfterWrite, revalidateStorefront } from "./lib/revalidate";
import { requireAdmin } from "./middleware/auth";
import { requestContext } from "./middleware/context";
import { cors } from "./middleware/cors";
import { securityHeaders } from "./middleware/security";
import { expireUnpaidOrders } from "./payments/service";
import { adminUserRoutes, adminAuditRoutes, adminRoleRoutes } from "./routes/admin/admins";
import { adminAuthRoutes } from "./routes/admin/auth";
import { adminCollectionRoutes } from "./routes/admin/collections";
import { adminContentRoutes } from "./routes/admin/content";
import { adminCustomerRoutes, adminLoginActivityRoutes } from "./routes/admin/customers";
import { adminDashboardRoutes, adminInventoryRoutes, adminReportRoutes } from "./routes/admin/dashboard";
import { adminContactRoutes, adminCouponRoutes, adminNewsletterRoutes } from "./routes/admin/marketing";
import { adminMediaRoutes } from "./routes/admin/media";
import { adminOrderRoutes } from "./routes/admin/orders";
import { adminPaymentRoutes } from "./routes/admin/payments";
import { adminProductRoutes } from "./routes/admin/products";
import { adminSeoRoutes } from "./routes/admin/seo";
import { adminTaxonomyRoutes } from "./routes/admin/taxonomy";
import { authRoutes } from "./routes/auth";
import { cartRoutes } from "./routes/cart";
import { catalogRoutes } from "./routes/catalog";
import { contentRoutes } from "./routes/content";
import { formRoutes } from "./routes/forms";
import { mediaRoutes } from "./routes/media";
import { orderRoutes } from "./routes/orders";
import { paymentRoutes } from "./routes/payments";
import { wishlistRoutes } from "./routes/wishlist";
import type { AppEnv } from "./types";

/** Admin modules from the Express app that have no D1 implementation yet. */
const UNSUPPORTED_ADMIN_MODULES = ["reviews", "notifications", "blog"];

const schemaGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const report = await ensureSchema(c.env.DB);
  if (!report.ok) {
    console.error("D1 schema mismatch", JSON.stringify(report));
    throw serviceUnavailable("SCHEMA_MISMATCH", "The service is being updated. Please try again shortly.");
  }
  await next();
};

const adminGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.path.startsWith("/api/v1/admin/auth/")) return next();
  return requireAdmin(c, next);
};

const admin = new Hono<AppEnv>();
admin.use("*", adminGuard);
admin.use("*", revalidateAfterWrite);
admin.route("/auth", adminAuthRoutes);
admin.route("/dashboard", adminDashboardRoutes);
admin.route("/reports", adminReportRoutes);
admin.route("/products", adminProductRoutes);
admin.route("/inventory", adminInventoryRoutes);
admin.route("/taxonomy", adminTaxonomyRoutes);
admin.route("/content/collections", adminCollectionRoutes);
admin.route("/content", adminContentRoutes);
admin.route("/collections", adminCollectionRoutes);
admin.route("/seo", adminSeoRoutes);
admin.route("/media", adminMediaRoutes);
admin.route("/orders", adminOrderRoutes);
admin.route("/payments", adminPaymentRoutes);
admin.route("/coupons", adminCouponRoutes);
admin.route("/customers", adminCustomerRoutes);
admin.route("/login-activity", adminLoginActivityRoutes);
admin.route("/contact", adminContactRoutes);
admin.route("/newsletter", adminNewsletterRoutes);
admin.route("/admins", adminUserRoutes);
admin.route("/roles", adminRoleRoutes);
admin.route("/audit", adminAuditRoutes);
for (const module of UNSUPPORTED_ADMIN_MODULES) {
  admin.all(`/${module}`, () => {
    throw notImplemented("This module is not available in the Cloudflare backend yet.");
  });
  admin.all(`/${module}/*`, () => {
    throw notImplemented("This module is not available in the Cloudflare backend yet.");
  });
}

const api = new Hono<AppEnv>();
api.use("*", schemaGate);
api.route("/admin", admin);
api.route("/auth", authRoutes);
api.route("/cart", cartRoutes);
api.route("/wishlist", wishlistRoutes);
api.use("/orders/*", revalidateAfterWrite);
api.use("/orders", revalidateAfterWrite);
api.route("/orders", orderRoutes);
api.route("/payments", paymentRoutes);
api.route("/content", contentRoutes);
api.route("/", formRoutes);
api.route("/", catalogRoutes);

export const app = new Hono<AppEnv>();
app.use("*", requestContext, securityHeaders, cors);

app.get("/", (c) => c.json({ success: true, data: { service: "pashmore-api", version: "v1" } }));
app.get("/health", async (c) => {
  try {
    const report = await ensureSchema(c.env.DB);
    const config = c.get("config");
    const methods = [...(config.razorpay ? ["razorpay"] : []), ...(config.codEnabled ? ["cod"] : [])];
    return c.json(
      {
        success: report.ok,
        data: {
          status: report.ok ? "ok" : "schema_mismatch",
          database: "d1",
          checkout: methods.length ? methods.join(",") : "disabled",
          email: config.resendApiKey ? "resend" : "disabled",
          schema: report,
        },
      },
      report.ok ? 200 : 503,
    );
  } catch (error) {
    console.error("health check failed", error);
    return c.json({ success: false, data: { status: "database_unreachable" } }, 503);
  }
});
app.route("/media", mediaRoutes);
app.route("/api/v1", api);

app.notFound((c) => c.json({ success: false, error: { code: "NOT_FOUND", message: "Route not found." } }, 404));

app.onError((error, c) => {
  if (error instanceof ApiError) {
    for (const [name, value] of Object.entries(error.headers ?? {})) c.header(name, value);
    return c.json({ success: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, error.status);
  }
  console.error("unhandled error", c.req.method, c.req.path, c.get("requestId"), error);
  return c.json({ success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again.", requestId: c.get("requestId") } }, 500);
});

/** Daily housekeeping: expired sessions, stale rate-limit windows, lockouts and old logs. */
export async function cleanup(env: Env, now = Date.now()): Promise<void> {
  const day = 86_400_000;
  const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  await env.DB.batch([
    // Rotated sessions are kept until expiry so refresh-token reuse is still detected.
    env.DB.prepare(`DELETE FROM sessions WHERE refresh_expires_at < ?`).bind(now - day),
    env.DB.prepare(`DELETE FROM rate_limits WHERE reset_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM login_attempts WHERE locked_until < ? AND updated_at < ?`).bind(now, now - day),
    env.DB.prepare(`DELETE FROM password_resets WHERE expires_at < ?`).bind(now - day),
    env.DB.prepare(`DELETE FROM login_events WHERE created_at < ?`).bind(sqlTime(now - 365 * day)),
    env.DB.prepare(`DELETE FROM payment_events WHERE received_at < ? AND status IN ('PROCESSED','IGNORED')`).bind(sqlTime(now - 180 * day)),
  ]);
}

/** Every 10 minutes: cancel online orders whose payment window lapsed (after checking the gateway). */
export async function expirePayments(env: Env, ctx: ExecutionContext): Promise<void> {
  const config = readConfig(env);
  const result = await expireUnpaidOrders({ db: env.DB, actorId: null, ip: null, userAgent: "cron", config, waitUntil: (promise) => ctx.waitUntil(promise) });
  if (result.checked) console.log(`[cron] payment expiry: checked=${result.checked} cancelled=${result.cancelled} paid=${result.paid}`);
  if (result.cancelled) await revalidateStorefront(config, ["products"]);
}

// Not exported: the runtime treats every named export of the entry module as a handler.
const EXPIRY_CRON = "*/10 * * * *";

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    if (controller.cron === EXPIRY_CRON) ctx.waitUntil(expirePayments(env, ctx));
    else ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
