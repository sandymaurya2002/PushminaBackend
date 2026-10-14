import { Hono, type Context } from "hono";
import { z } from "zod";
import { MAX_LINE_QUANTITY, SHIPPING_METHODS } from "../commerce/cart";
import { CURRENCIES } from "../commerce/currency";
import {
  canRequestReturn,
  createOrder,
  CUSTOMER_CANCELLABLE,
  loadOrder,
  ONLINE_METHODS,
  orderActor,
  orderDto,
  transitionOrder,
  type OrderItemRow,
  type OrderRow,
} from "../commerce/orders";
import { loadCommerceRules } from "../content/settings";
import { badRequest, conflict, notFound, validationError } from "../lib/errors";
import { created, ok, paginated } from "../lib/http";
import { addressFields, body, email, id, query, withAddressRules } from "../lib/validation";
import { currentUser, requireCustomer } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { fetchPayment, verifyCheckoutSignature } from "../payments/razorpay";
import { checkoutPayload, recordGatewayPayment, reopenForPayment, requireRazorpay, syncOrderPayments } from "../payments/service";
import type { AppEnv } from "../types";
import { resolverFor } from "./catalog";

const shippingAddress = z
  .object({
    ...addressFields,
    fullName: z.string().trim().min(2, "Please enter your full name.").max(120),
    /** Defaults to the account's email: order updates always reach the customer. */
    email: z.preprocess((value) => (value === "" ? undefined : value), email.optional()),
    line1: z.string().trim().min(4, "Please enter your address.").max(200),
    city: z.string().trim().min(2, "Please enter your city.").max(80),
  })
  .superRefine(withAddressRules);

const createSchema = z
  .object({
    address: shippingAddress.optional(),
    addressId: id.optional(),
    shippingMethod: z.enum(SHIPPING_METHODS).default("standard"),
    paymentMethod: z.enum(["COD", ...ONLINE_METHODS]).default("RAZORPAY"),
    couponCode: z.string().trim().max(40).nullable().optional(),
    customerNote: z.string().trim().max(1000).optional(),
    /** The currency the customer saw at checkout; the order is refused if it no longer applies. */
    currency: z.enum(CURRENCIES).optional(),
  })
  .refine((value) => value.address || value.addressId, { message: "Please choose a delivery address.", path: ["address"] });

const verifySchema = z.object({
  razorpayOrderId: z.string().trim().regex(/^order_[A-Za-z0-9]{6,40}$/),
  razorpayPaymentId: z.string().trim().regex(/^pay_[A-Za-z0-9]{6,40}$/),
  razorpaySignature: z.string().trim().regex(/^[a-f0-9]{64}$/i),
});

async function customerDto(c: Context<AppEnv>, orderId: string) {
  const [{ order, items, history }, rules] = await Promise.all([loadOrder(c.env.DB, orderId, currentUser(c).userId), loadCommerceRules(c.env.DB)]);
  return orderDto(order, items, resolverFor(c), history, { returnWindowDays: rules.returnWindowDays });
}

export const orderRoutes = new Hono<AppEnv>();

orderRoutes.post("/track", rateLimit({ name: "order-track", limit: 10, windowSeconds: 600 }), async (c) => {
  const input = await body(c, z.object({ orderNumber: z.string().trim().toUpperCase().regex(/^PSH-\d{6}$/, "Order numbers look like PSH-104287."), email }));
  const row = await c.env.DB.prepare(`SELECT id FROM orders WHERE order_number = ? AND shipping_email = ? COLLATE NOCASE`).bind(input.orderNumber, input.email).first<{ id: string }>();
  if (!row) throw notFound("Order");
  const { order, items, history } = await loadOrder(c.env.DB, row.id);
  const dto = orderDto(order, items, resolverFor(c), history);
  return ok(c, {
    orderNumber: dto.orderNumber,
    status: dto.status,
    placedAt: dto.placedAt,
    items: dto.items.map(({ name, quantity }) => ({ name, quantity })),
    trackingNumber: dto.trackingNumber,
    trackingUrl: dto.trackingUrl,
    carrier: dto.carrier,
    estimatedDelivery: dto.estimatedDelivery,
    shippedAt: dto.shippedAt,
    deliveredAt: dto.deliveredAt,
    history: (dto.history ?? []).map(({ to, createdAt }) => ({ status: to, createdAt })),
  });
});

orderRoutes.use("*", requireCustomer);

const customerLimit = (name: string, limit: number) => rateLimit({ name, limit, windowSeconds: 600, key: (c) => c.get("auth")?.userId ?? c.get("clientIp") });

orderRoutes.post("/", customerLimit("order-create", 10), async (c) => {
  const input = await body(c, createSchema);
  const auth = currentUser(c);
  let address = input.address ? { ...input.address, email: input.address.email ?? auth.email } : undefined;
  if (!address && input.addressId) {
    const saved = await c.env.DB.prepare(`SELECT * FROM addresses WHERE id = ? AND user_id = ?`)
      .bind(input.addressId, auth.userId)
      .first<{ full_name: string; phone: string; line1: string; line2: string | null; city: string; state: string; postal_code: string; country: string }>();
    if (!saved) throw validationError({ addressId: "That address could not be found." });
    address = { fullName: saved.full_name, email: auth.email, phone: saved.phone, line1: saved.line1, line2: saved.line2, city: saved.city, state: saved.state, postalCode: saved.postal_code, country: saved.country };
  }
  const idempotencyKey = c.req.header("idempotency-key")?.trim();
  const { orderId, replayed } = await createOrder(c, {
    address: address!,
    shippingMethod: input.shippingMethod,
    paymentMethod: input.paymentMethod,
    couponCode: input.couponCode,
    customerNote: input.customerNote,
    currency: input.currency,
    idempotencyKey: idempotencyKey && /^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey) ? idempotencyKey : undefined,
  });

  const { order } = await loadOrder(c.env.DB, orderId, auth.userId);
  let payment = null;
  if (order.payment_method === "RAZORPAY" && (order.status === "PAYMENT_PENDING" || order.status === "PAYMENT_FAILED")) {
    try {
      payment = await checkoutPayload(orderActor(c), order);
    } catch (error) {
      if (!replayed) await abandonOrder(c, order);
      throw error;
    }
  }
  const dto = { ...(await customerDto(c, orderId)), payment };
  return replayed ? ok(c, dto, { replayed: true }) : created(c, dto);
});

/** The gateway could not start a payment: release the stock and put the pieces back in the bag. */
async function abandonOrder(c: Context<AppEnv>, order: OrderRow) {
  const db = c.env.DB;
  await db
    .prepare(
      `INSERT INTO cart_items (user_id, product_id, variant_id, quantity)
       SELECT ?1, product_id, variant_id, MIN(SUM(quantity), ${MAX_LINE_QUANTITY}) FROM order_items WHERE order_id = ?2 GROUP BY product_id, variant_id
       ON CONFLICT(user_id, product_id, variant_id) DO NOTHING`,
    )
    .bind(order.user_id, order.id)
    .run();
  await transitionOrder(orderActor(c), order, "CANCELLED", { note: "Payment could not be started", actorId: null, allowed: ["CANCELLED"] }).catch(() => undefined);
}

orderRoutes.get("/", async (c) => {
  const input = query(c, z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(10) }));
  const db = c.env.DB;
  const userId = currentUser(c).userId;
  const [orders, total] = await db.batch([
    db.prepare(`SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).bind(userId, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE user_id = ?`).bind(userId),
  ]);
  const rows = (orders?.results ?? []) as unknown as OrderRow[];
  const items = rows.length
    ? (await db.prepare(`SELECT * FROM order_items WHERE order_id IN (${rows.map(() => "?").join(",")}) ORDER BY rowid`).bind(...rows.map((row) => row.id)).all<OrderItemRow>()).results
    : [];
  const resolve = resolverFor(c);
  const rules = await loadCommerceRules(db);
  return paginated(
    c,
    rows.map((row) => orderDto(row, items.filter((item) => item.order_id === row.id), resolve, undefined, { returnWindowDays: rules.returnWindowDays })),
    Number((total?.results[0] as { n: number })?.n ?? 0),
    input.page,
    input.limit,
  );
});

orderRoutes.get("/:id", async (c) => ok(c, await customerDto(c, c.req.param("id"))));

/** Starts (or retries) online payment for an order that is awaiting it. */
orderRoutes.post("/:id/pay", customerLimit("order-pay", 20), async (c) => {
  const { order } = await loadOrder(c.env.DB, c.req.param("id"), currentUser(c).userId);
  const ops = orderActor(c);
  const reopened = await reopenForPayment(ops, order);
  return ok(c, await checkoutPayload(ops, reopened));
});

/**
 * Called with what Razorpay Checkout hands the browser. The signature proves
 * the ids came from Razorpay, and the payment is then fetched from Razorpay's
 * API, so the order is only marked paid on the gateway's own word.
 */
orderRoutes.post("/:id/payment/verify", customerLimit("order-verify", 30), async (c) => {
  const input = await body(c, verifySchema);
  const razorpay = requireRazorpay(c.get("config"));
  const { order } = await loadOrder(c.env.DB, c.req.param("id"), currentUser(c).userId);
  const owned = await c.env.DB.prepare(`SELECT 1 AS ok FROM payments WHERE order_id = ? AND provider_order_id = ?`).bind(order.id, input.razorpayOrderId).first();
  if (!owned) throw badRequest("This payment does not belong to this order.");
  if (!(await verifyCheckoutSignature(razorpay, input.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature))) {
    throw conflict("PAYMENT_SIGNATURE_INVALID", "We couldn't verify this payment. If money left your account, it will be reconciled automatically.");
  }
  const payment = await fetchPayment(razorpay, input.razorpayPaymentId).catch(() => null);
  if (!payment || payment.order_id !== input.razorpayOrderId) {
    throw conflict("PAYMENT_NOT_CONFIRMED", "Your payment is still being confirmed. This page will update shortly.");
  }
  const outcome = await recordGatewayPayment(orderActor(c), order.id, payment, "checkout");
  return ok(c, { outcome, order: await customerDto(c, order.id) });
});

/** Re-checks the order's payments with Razorpay (used while a payment is pending or after a closed checkout). */
orderRoutes.post("/:id/payment/sync", customerLimit("order-sync", 30), async (c) => {
  const { order } = await loadOrder(c.env.DB, c.req.param("id"), currentUser(c).userId);
  if (order.payment_method === "RAZORPAY" && c.get("config").razorpay) await syncOrderPayments(orderActor(c), order.id, "customer-sync");
  return ok(c, await customerDto(c, order.id));
});

orderRoutes.post("/:id/cancel", customerLimit("order-cancel", 10), async (c) => {
  const input = await body(c, z.object({ reason: z.string().trim().max(500).optional() }));
  const auth = currentUser(c);
  const { order } = await loadOrder(c.env.DB, c.req.param("id"), auth.userId);
  await transitionOrder(orderActor(c), order, "CANCELLED", {
    note: input.reason ? `Cancelled by customer: ${input.reason}` : "Cancelled by customer",
    actorId: auth.userId,
    allowed: CUSTOMER_CANCELLABLE.includes(order.status) ? ["CANCELLED"] : [],
  });
  return ok(c, await customerDto(c, order.id));
});

orderRoutes.post("/:id/return", customerLimit("order-return", 10), async (c) => {
  const input = await body(c, z.object({ reason: z.string().trim().min(3, "Please tell us why you're returning it.").max(1000) }));
  const auth = currentUser(c);
  const [{ order }, rules] = await Promise.all([loadOrder(c.env.DB, c.req.param("id"), auth.userId), loadCommerceRules(c.env.DB)]);
  if (!canRequestReturn(order, rules.returnWindowDays)) {
    throw conflict(
      "RETURN_NOT_ALLOWED",
      order.status === "DELIVERED" ? `Returns are accepted within ${rules.returnWindowDays} days of delivery.` : "Only delivered orders can be returned.",
    );
  }
  await transitionOrder(orderActor(c), order, "RETURN_REQUESTED", {
    note: `Return requested: ${input.reason}`.slice(0, 500),
    actorId: auth.userId,
    allowed: ["RETURN_REQUESTED"],
    extra: { returnReason: input.reason },
  });
  return ok(c, await customerDto(c, order.id));
});
