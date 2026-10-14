import { Hono } from "hono";
import { orderActor } from "../commerce/orders";
import { badRequest, serviceUnavailable, unauthorized } from "../lib/errors";
import { verifyWebhookSignature } from "../payments/razorpay";
import { handleWebhook } from "../payments/service";
import { sha256Hex } from "../lib/crypto";
import type { AppEnv } from "../types";

export const paymentRoutes = new Hono<AppEnv>();

/** Public status for the storefront checkout: which methods can take an order right now. */
paymentRoutes.get("/methods", (c) => {
  const config = c.get("config");
  return c.json({ success: true, data: { razorpay: Boolean(config.razorpay), cod: config.codEnabled, keyId: config.razorpay?.keyId ?? null } });
});

/**
 * Razorpay webhook (Dashboard → Settings → Webhooks). Subscribe to
 * payment.authorized, payment.captured, payment.failed, order.paid,
 * refund.processed and refund.failed. The raw body is verified against
 * RAZORPAY_WEBHOOK_SECRET before anything is parsed.
 */
paymentRoutes.post("/razorpay/webhook", async (c) => {
  const secret = c.get("config").razorpay?.webhookSecret;
  if (!secret) throw serviceUnavailable("WEBHOOK_NOT_CONFIGURED", "Webhooks are not configured.");
  const raw = await c.req.text();
  if (raw.length > 256 * 1024) throw badRequest("Payload too large.");
  const signature = c.req.header("x-razorpay-signature") ?? "";
  if (!(await verifyWebhookSignature(secret, raw, signature))) throw unauthorized("Invalid webhook signature.");

  let parsed: Parameters<typeof handleWebhook>[2];
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest("Invalid JSON.");
  }
  const eventId = c.req.header("x-razorpay-event-id")?.trim() || `sha256:${await sha256Hex(raw)}`;
  const result = await handleWebhook({ ...orderActor(c), actorId: null }, eventId.slice(0, 120), parsed, raw);
  return c.json({ success: true, data: { result } });
});
