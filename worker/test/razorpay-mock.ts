import { vi } from "vitest";
import { razorpayHmac, type RazorpayOrder, type RazorpayPayment, type RazorpayRefund } from "../src/payments/razorpay";

export const KEY_SECRET = "test-key-secret";
export const WEBHOOK_SECRET = "test-webhook-secret";

/**
 * An in-memory stand-in for the Razorpay REST API at https://razorpay.mock/v1.
 * The Worker under test shares the isolate with the tests, so stubbing the
 * global fetch intercepts its gateway calls. Signatures use the real HMAC.
 */
export function installRazorpayMock() {
  const orders = new Map<string, RazorpayOrder>();
  const payments = new Map<string, RazorpayPayment>();
  const refunds = new Map<string, RazorpayRefund>();
  const calls: string[] = [];
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_mock${Date.now().toString(36)}${(sequence += 1)}`;
  const original = globalThis.fetch;
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const missing = () => json(400, { error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } });
  const options = { failOrderCreate: false, declineRefunds: false };

  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.host !== "razorpay.mock") return original(input, init);
    const path = url.pathname.replace(/^\/v1/, "");
    calls.push(`${request.method} ${path}`);
    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, any>) : {};
    let match: RegExpMatchArray | null;

    if (request.method === "POST" && path === "/orders") {
      if (options.failOrderCreate) return json(500, { error: { code: "SERVER_ERROR", description: "Gateway down" } });
      const order: RazorpayOrder = { id: next("order"), amount: body.amount, amount_paid: 0, currency: body.currency, receipt: body.receipt, status: "created" };
      orders.set(order.id, order);
      return json(200, order);
    }
    if ((match = path.match(/^\/orders\/([^/]+)\/payments$/))) {
      if (!orders.has(match[1]!)) return missing();
      return json(200, { items: [...payments.values()].filter((payment) => payment.order_id === match![1]) });
    }
    if ((match = path.match(/^\/payments\/([^/]+)\/capture$/))) {
      const payment = payments.get(match[1]!);
      if (!payment) return missing();
      if (payment.status !== "authorized") return json(400, { error: { code: "BAD_REQUEST_ERROR", description: "This payment has already been captured" } });
      payment.status = "captured";
      payment.captured = true;
      return json(200, payment);
    }
    if ((match = path.match(/^\/payments\/([^/]+)\/refunds$/))) {
      return json(200, { items: [...refunds.values()].filter((refund) => refund.payment_id === match![1]) });
    }
    if ((match = path.match(/^\/payments\/([^/]+)\/refund$/))) {
      const payment = payments.get(match[1]!);
      if (!payment) return missing();
      if (options.declineRefunds) return json(400, { error: { code: "BAD_REQUEST_ERROR", description: "invalid request sent", metadata: {}, reason: "NA", source: "NA", step: "NA" } });
      if (payment.amount_refunded + body.amount > payment.amount) return json(400, { error: { code: "BAD_REQUEST_ERROR", description: "Refund amount exceeds payment" } });
      const refund: RazorpayRefund = { id: next("rfnd"), payment_id: payment.id, amount: body.amount, status: "processed", notes: body.notes, receipt: body.receipt };
      refunds.set(refund.id, refund);
      payment.amount_refunded += body.amount;
      payment.status = payment.amount_refunded >= payment.amount ? "refunded" : payment.status;
      return json(200, refund);
    }
    if ((match = path.match(/^\/payments\/([^/]+)$/))) {
      const payment = payments.get(match[1]!);
      return payment ? json(200, payment) : missing();
    }
    return json(404, { error: { code: "NOT_FOUND", description: `No mock for ${request.method} ${path}` } });
  });

  return {
    orders,
    payments,
    refunds,
    calls,
    options,
    restore: () => spy.mockRestore(),
    /** Records a payment at the "gateway" and returns what Checkout would hand the browser. */
    async pay(razorpayOrderId: string, input: { status?: RazorpayPayment["status"]; amount?: number; currency?: string; method?: string } = {}) {
      const order = orders.get(razorpayOrderId);
      if (!order) throw new Error(`unknown razorpay order ${razorpayOrderId}`);
      const status = input.status ?? "captured";
      const payment: RazorpayPayment = {
        id: next("pay"),
        order_id: razorpayOrderId,
        amount: input.amount ?? order.amount,
        amount_refunded: 0,
        currency: input.currency ?? order.currency,
        status,
        method: input.method ?? "upi",
        captured: status === "captured",
        error_code: status === "failed" ? "BAD_REQUEST_ERROR" : null,
        error_description: status === "failed" ? "Payment declined by bank" : null,
        created_at: Math.floor(Date.now() / 1000),
      };
      payments.set(payment.id, payment);
      return {
        payment,
        verify: {
          razorpayOrderId,
          razorpayPaymentId: payment.id,
          razorpaySignature: await razorpayHmac(KEY_SECRET, `${razorpayOrderId}|${payment.id}`),
        },
      };
    },
  };
}

export type RazorpayMock = ReturnType<typeof installRazorpayMock>;

/** A webhook delivery as Razorpay sends it: raw JSON body plus HMAC signature and event id headers. */
export async function webhookRequest(event: string, entities: { payment?: RazorpayPayment; refund?: RazorpayRefund }, eventId = `evt_${crypto.randomUUID()}`, secret = WEBHOOK_SECRET) {
  const payload: Record<string, unknown> = {};
  if (entities.payment) payload.payment = { entity: entities.payment };
  if (entities.refund) payload.refund = { entity: entities.refund };
  const rawBody = JSON.stringify({ entity: "event", event, contains: Object.keys(payload), payload, created_at: Math.floor(Date.now() / 1000) });
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": await razorpayHmac(secret, rawBody),
      "x-razorpay-event-id": eventId,
    },
  };
}
