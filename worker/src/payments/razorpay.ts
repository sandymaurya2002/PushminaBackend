import type { Currency } from "../commerce/currency";
import type { RazorpayConfig } from "../env";
import { timingSafeEqual } from "../lib/crypto";

/**
 * Minimal Razorpay REST client (https://razorpay.com/docs/api). Test-mode keys
 * (rzp_test_…) talk to the sandbox; nothing here distinguishes the two.
 */

export interface RazorpayOrder {
  id: string;
  amount: number;
  amount_paid: number;
  currency: string;
  receipt: string | null;
  status: "created" | "attempted" | "paid";
}

export interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  amount_refunded: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  method: string | null;
  captured: boolean;
  error_code: string | null;
  error_description: string | null;
  created_at: number;
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: "pending" | "processed" | "failed";
  notes?: Record<string, string> | unknown[];
  receipt?: string | null;
}

export class RazorpayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RazorpayError";
  }
}

const encoder = new TextEncoder();
const TIMEOUT_MS = 12_000;

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyHmac(secret: string, message: string, signature: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = await hmacHex(secret, message);
  return timingSafeEqual(encoder.encode(expected), encoder.encode(signature.toLowerCase()));
}

/** Checkout handler signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyCheckoutSignature(config: RazorpayConfig, orderId: string, paymentId: string, signature: string): Promise<boolean> {
  return verifyHmac(config.keySecret, `${orderId}|${paymentId}`, signature);
}

/** Webhook signature: HMAC_SHA256(raw body, webhook secret). */
export function verifyWebhookSignature(secret: string, rawBody: string, signature: string): Promise<boolean> {
  return verifyHmac(secret, rawBody, signature);
}

export { hmacHex as razorpayHmac };

async function call<T>(config: RazorpayConfig, method: "GET" | "POST", path: string, payload?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${btoa(`${config.keyId}:${config.keySecret}`)}`,
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new RazorpayError(0, "GATEWAY_UNREACHABLE", `Razorpay could not be reached: ${(error as Error)?.name ?? "error"}`);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; description?: string } } | null)?.error;
    throw new RazorpayError(response.status, error?.code ?? "GATEWAY_ERROR", error?.description ?? `Razorpay returned HTTP ${response.status}`);
  }
  return data as T;
}

/** `amountPaise` is in minor units of `currency` (USD needs international payments enabled on the Razorpay account). */
export function createRazorpayOrder(config: RazorpayConfig, input: { amountPaise: number; currency: Currency; receipt: string; notes: Record<string, string> }) {
  return call<RazorpayOrder>(config, "POST", "/orders", {
    amount: input.amountPaise,
    currency: input.currency,
    receipt: input.receipt.slice(0, 40),
    notes: input.notes,
  });
}

export function fetchPayment(config: RazorpayConfig, paymentId: string) {
  return call<RazorpayPayment>(config, "GET", `/payments/${encodeURIComponent(paymentId)}`);
}

export async function fetchOrderPayments(config: RazorpayConfig, orderId: string) {
  const result = await call<{ items: RazorpayPayment[] }>(config, "GET", `/orders/${encodeURIComponent(orderId)}/payments`);
  return result.items ?? [];
}

export function capturePayment(config: RazorpayConfig, paymentId: string, amountPaise: number, currency: Currency) {
  return call<RazorpayPayment>(config, "POST", `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency });
}

export function createRefund(config: RazorpayConfig, paymentId: string, input: { amountPaise: number; receipt: string; notes: Record<string, string> }) {
  return call<RazorpayRefund>(config, "POST", `/payments/${encodeURIComponent(paymentId)}/refund`, {
    amount: input.amountPaise,
    speed: "normal",
    receipt: input.receipt.slice(0, 40),
    notes: input.notes,
  });
}

export async function fetchPaymentRefunds(config: RazorpayConfig, paymentId: string) {
  const result = await call<{ items: RazorpayRefund[] }>(config, "GET", `/payments/${encodeURIComponent(paymentId)}/refunds`);
  return result.items ?? [];
}
