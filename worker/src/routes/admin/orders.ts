import { Hono, type Context } from "hono";
import { z } from "zod";
import { hasPermission } from "../../auth/permissions";
import {
  loadOrder,
  orderActor,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  TRANSITIONS,
  transitionOrder,
  type HistoryRow,
  type OrderItemRow,
  type OrderRow,
  type OrderStatus,
} from "../../commerce/orders";
import { auditStatement } from "../../lib/audit";
import { conflict, forbidden } from "../../lib/errors";
import { csv, ok, paginated } from "../../lib/http";
import { likePattern, parseJson, toIso, toPaise, toRupees } from "../../lib/util";
import { CURRENCIES } from "../../commerce/currency";
import { body, money, query } from "../../lib/validation";
import { can, currentUser } from "../../middleware/auth";
import { requestRefund, syncOrderPayments, type PaymentRow, type RefundRow } from "../../payments/service";
import type { AppEnv } from "../../types";
import { resolverFor } from "../catalog";

type Row = OrderRow & { first_name: string | null; last_name: string | null; user_name: string | null; user_email: string | null };

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(120).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  paymentMethod: z.enum(["COD", "RAZORPAY"]).optional(),
  currency: z.enum(CURRENCIES).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  userId: z.string().max(64).optional(),
});

function filters(input: z.output<typeof listSchema>) {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (input.status) {
    where.push("o.status = ?");
    binds.push(input.status);
  }
  if (input.paymentStatus) {
    where.push("o.payment_status = ?");
    binds.push(input.paymentStatus);
  }
  if (input.paymentMethod) {
    where.push("o.payment_method = ?");
    binds.push(input.paymentMethod);
  }
  if (input.currency) {
    where.push("o.currency = ?");
    binds.push(input.currency);
  }
  if (input.userId) {
    where.push("o.user_id = ?");
    binds.push(input.userId);
  }
  if (input.q) {
    where.push("(o.order_number LIKE ? ESCAPE '\\' OR o.shipping_email LIKE ? ESCAPE '\\' OR o.shipping_name LIKE ? ESCAPE '\\' OR o.shipping_phone LIKE ? ESCAPE '\\' OR o.tracking_number LIKE ? ESCAPE '\\')");
    binds.push(...Array(5).fill(likePattern(input.q)));
  }
  if (input.from) {
    where.push("o.created_at >= ?");
    binds.push(`${input.from} 00:00:00`);
  }
  if (input.to) {
    where.push("o.created_at <= ?");
    binds.push(`${input.to} 23:59:59`);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

const SELECT = `SELECT o.*, u.first_name, u.last_name, u.name AS user_name, u.email AS user_email FROM orders o LEFT JOIN users u ON u.id = o.user_id`;

function userOf(row: Row) {
  if (!row.user_email) return null;
  const [first = "", ...rest] = (row.user_name ?? "").split(" ");
  return { id: row.user_id, firstName: row.first_name ?? first, lastName: row.last_name ?? rest.join(" "), email: row.user_email };
}

/** Which permission a status change needs. */
export function permissionFor(to: OrderStatus): string {
  if (to === "CANCELLED") return "orders.cancel";
  if (["PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"].includes(to)) return "orders.fulfil";
  return "orders.update";
}

export const adminOrderRoutes = new Hono<AppEnv>();

adminOrderRoutes.get("/", can("orders.view"), async (c) => {
  const input = query(c, listSchema);
  const { clause, binds } = filters(input);
  const db = c.env.DB;
  const [rows, total] = await db.batch([
    db.prepare(`${SELECT} ${clause} ORDER BY o.created_at DESC, o.rowid DESC LIMIT ? OFFSET ?`).bind(...binds, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM orders o ${clause}`).bind(...binds),
  ]);
  const orders = (rows?.results ?? []) as unknown as Row[];
  const items = orders.length
    ? (await db.prepare(`SELECT * FROM order_items WHERE order_id IN (${orders.map(() => "?").join(",")}) ORDER BY rowid`).bind(...orders.map((row) => row.id)).all<OrderItemRow>()).results
    : [];
  const resolve = resolverFor(c);
  return paginated(
    c,
    orders.map((row) => {
      const lines = items.filter((item) => item.order_id === row.id);
      return {
        id: row.id,
        orderNumber: row.order_number,
        email: row.shipping_email,
        phone: row.shipping_phone,
        status: row.status,
        currency: row.currency,
        total: toRupees(row.total_paise),
        refunded: toRupees(row.refunded_paise),
        placedAt: toIso(row.created_at),
        trackingNumber: row.tracking_number,
        shippingMethod: row.shipping_method,
        itemCount: lines.reduce((sum, item) => sum + item.quantity, 0),
        paymentStatus: row.payment_status,
        paymentMethod: row.payment_method,
        user: userOf(row),
        items: lines.map((item) => ({ id: item.id, name: item.product_name, quantity: item.quantity, imageUrl: item.image_url ? resolve(item.image_url) : null })),
      };
    }),
    Number((total?.results[0] as { n: number })?.n ?? 0),
    input.page,
    input.limit,
  );
});

adminOrderRoutes.get("/export/csv", can("orders.export"), async (c) => {
  const input = query(c, listSchema.omit({ page: true, limit: true }));
  const { clause, binds } = filters({ ...input, page: 1, limit: 5000 });
  const { results } = await c.env.DB.prepare(`${SELECT} ${clause} ORDER BY o.created_at DESC LIMIT 5000`).bind(...binds).all<Row>();
  await c.env.DB.batch([auditStatement(c, { action: "order.export", entityType: "order", metadata: { rows: results.length, filters: input } })]);
  return csv(
    c,
    `orders-${new Date().toISOString().slice(0, 10)}.csv`,
    results.map((row) => ({
      orderNumber: row.order_number,
      placedAt: toIso(row.created_at),
      status: row.status,
      paymentStatus: row.payment_status,
      paymentMethod: row.payment_method,
      currency: row.currency,
      name: row.shipping_name,
      email: row.shipping_email,
      phone: row.shipping_phone,
      city: parseJson<Record<string, string>>(row.shipping_address_json, {}).city ?? "",
      country: parseJson<Record<string, string>>(row.shipping_address_json, {}).country ?? "",
      subtotal: toRupees(row.subtotal_paise),
      discount: toRupees(row.discount_paise),
      couponCode: row.coupon_code ?? "",
      shipping: toRupees(row.shipping_paise),
      total: toRupees(row.total_paise),
      refunded: toRupees(row.refunded_paise),
      carrier: row.carrier ?? "",
      trackingNumber: row.tracking_number ?? "",
      paidAt: toIso(row.paid_at) ?? "",
      shippedAt: toIso(row.shipped_at) ?? "",
      deliveredAt: toIso(row.delivered_at) ?? "",
    })),
    [
      "orderNumber",
      "placedAt",
      "status",
      "paymentStatus",
      "paymentMethod",
      "currency",
      "name",
      "email",
      "phone",
      "city",
      "country",
      "subtotal",
      "discount",
      "couponCode",
      "shipping",
      "total",
      "refunded",
      "carrier",
      "trackingNumber",
      "paidAt",
      "shippedAt",
      "deliveredAt",
    ],
  );
});

export function paymentDto(row: PaymentRow) {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    method: row.method ?? (row.provider === "cod" ? "cod" : null),
    currency: row.currency,
    amount: toRupees(row.amount_paise),
    amountRefunded: toRupees(row.amount_refunded_paise),
    providerOrderId: row.provider_order_id,
    providerPaymentId: row.provider_payment_id,
    failureReason: row.failure_reason,
    errorCode: row.error_code,
    createdAt: toIso(row.created_at),
    authorizedAt: toIso(row.authorized_at),
    capturedAt: toIso(row.captured_at),
    failedAt: toIso(row.failed_at),
  };
}

/** Refunds are in the currency of their order (`order_currency` when joined, otherwise passed in). */
export function refundDto(row: RefundRow & { requested_by_name?: string | null; processed_by_name?: string | null; order_currency?: string | null }, currency?: string) {
  return {
    id: row.id,
    provider: row.provider,
    currency: currency ?? row.order_currency ?? "INR",
    amount: toRupees(row.amount_paise),
    reason: row.reason,
    notes: row.notes,
    status: row.status,
    providerRefundId: row.provider_refund_id,
    failureReason: row.failure_reason,
    createdAt: toIso(row.created_at),
    completedAt: toIso(row.completed_at),
    requestedBy: row.requested_by ? { id: row.requested_by, name: row.requested_by_name ?? "Unknown" } : null,
    processedBy: row.processed_by ? { id: row.processed_by, name: row.processed_by_name ?? "Unknown" } : null,
  };
}

function detailDto(order: Row | OrderRow, items: OrderItemRow[], history: HistoryRow[], payments: PaymentRow[], refunds: RefundRow[], resolve: (url: string) => string) {
  const address = parseJson<Record<string, string>>(order.shipping_address_json, {});
  const openRefund = refunds.some((refund) => refund.status === "REQUESTED" || refund.status === "PROCESSING");
  return {
    id: order.id,
    orderNumber: order.order_number,
    email: order.shipping_email,
    phone: order.shipping_phone,
    status: order.status,
    allowedTransitions: TRANSITIONS[order.status],
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method,
    currency: order.currency,
    pricingCountry: order.pricing_country,
    subtotal: toRupees(order.subtotal_paise),
    discount: toRupees(order.discount_paise),
    shippingFee: toRupees(order.shipping_paise),
    taxAmount: toRupees(order.tax_paise),
    total: toRupees(order.total_paise),
    refunded: toRupees(order.refunded_paise),
    refundable: ["PAID", "PARTIALLY_REFUNDED"].includes(order.payment_status) && !openRefund ? toRupees(order.total_paise - order.refunded_paise) : 0,
    couponCode: order.coupon_code,
    shippingAddress: { fullName: order.shipping_name, phone: order.shipping_phone, ...address },
    shippingMethod: order.shipping_method,
    giftMessage: null,
    customerNote: order.customer_note,
    adminNote: order.admin_note,
    trackingNumber: order.tracking_number,
    trackingUrl: order.tracking_url,
    carrier: order.carrier,
    estimatedDelivery: order.estimated_delivery,
    returnReason: order.return_reason,
    returnRequestedAt: toIso(order.return_requested_at),
    paymentExpiresAt: order.payment_expires_at ? new Date(order.payment_expires_at).toISOString() : null,
    placedAt: toIso(order.created_at),
    paidAt: toIso(order.paid_at),
    shippedAt: toIso(order.shipped_at),
    deliveredAt: toIso(order.delivered_at),
    cancelledAt: toIso(order.cancelled_at),
    user: "user_email" in order ? userOf(order) : null,
    items: items.map((item) => ({
      id: item.id,
      productId: item.product_id,
      slug: item.product_slug,
      name: item.product_name,
      imageUrl: item.image_url ? resolve(item.image_url) : null,
      sku: item.sku,
      colorName: item.color_name,
      sizeName: item.size_name,
      unitPrice: toRupees(item.unit_price_paise),
      quantity: item.quantity,
      lineTotal: toRupees(item.line_total_paise),
    })),
    payments: payments.map(paymentDto),
    refunds: refunds.map((refund) => refundDto(refund, order.currency)),
    statusHistory: history.map((entry) => ({
      id: entry.id,
      fromStatus: entry.from_status,
      toStatus: entry.to_status,
      note: entry.note,
      createdAt: toIso(entry.created_at),
      changedBy: entry.changed_by ? { id: entry.changed_by, name: entry.changed_by_name ?? "Unknown" } : null,
    })),
    invoice: null,
  };
}

async function loadDetail(c: Context<AppEnv>, orderId: string) {
  const db = c.env.DB;
  const { order, items, history } = await loadOrder(db, orderId);
  const [withUser, payments, refunds] = await db.batch([
    db.prepare(`${SELECT} WHERE o.id = ?`).bind(order.id),
    db.prepare(`SELECT * FROM payments WHERE order_id = ? ORDER BY created_at, rowid`).bind(order.id),
    db
      .prepare(
        `SELECT r.*, rq.name AS requested_by_name, pr.name AS processed_by_name FROM refunds r
           LEFT JOIN users rq ON rq.id = r.requested_by LEFT JOIN users pr ON pr.id = r.processed_by
          WHERE r.order_id = ? ORDER BY r.created_at, r.rowid`,
      )
      .bind(order.id),
  ]);
  return detailDto(
    ((withUser?.results[0] as Row | undefined) ?? order) as Row,
    items,
    history,
    (payments?.results ?? []) as unknown as PaymentRow[],
    (refunds?.results ?? []) as unknown as RefundRow[],
    resolverFor(c),
  );
}

adminOrderRoutes.get("/:id", can("orders.view"), async (c) => ok(c, await loadDetail(c, c.req.param("id"))));

const trackingFields = {
  trackingNumber: z.string().trim().max(100).optional(),
  carrier: z.string().trim().max(100).optional(),
  trackingUrl: z.string().trim().url().max(500).optional(),
  estimatedDelivery: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};

adminOrderRoutes.patch("/:id/status", can("orders.view"), async (c) => {
  const input = await body(c, z.object({ status: z.enum(ORDER_STATUSES), note: z.string().trim().max(500).optional(), ...trackingFields }));
  const auth = currentUser(c);
  const needed = permissionFor(input.status);
  if (!hasPermission(auth.adminRole, needed)) throw forbidden(`You need the ${needed} permission for this change.`);
  const { order } = await loadOrder(c.env.DB, c.req.param("id"));
  if (input.status === "SHIPPED" && !input.trackingNumber && !order.tracking_number) {
    throw conflict("TRACKING_REQUIRED", "Add the courier and tracking number before marking the order shipped.", { trackingNumber: "Required to ship." });
  }
  await transitionOrder(orderActor(c), order, input.status, {
    note: input.note ?? null,
    actorId: auth.userId,
    extra: { trackingNumber: input.trackingNumber, carrier: input.carrier, trackingUrl: input.trackingUrl, estimatedDelivery: input.estimatedDelivery },
  });
  return ok(c, await loadDetail(c, order.id));
});

adminOrderRoutes.patch("/:id", can("orders.update"), async (c) => {
  const input = await body(
    c,
    z.object({
      adminNote: z.string().trim().max(2000).nullable().optional(),
      trackingNumber: z.string().trim().max(100).nullable().optional(),
      carrier: z.string().trim().max(100).nullable().optional(),
      trackingUrl: z.string().trim().url().max(500).nullable().optional(),
      estimatedDelivery: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }),
  );
  const { order } = await loadOrder(c.env.DB, c.req.param("id"));
  const keep = <T>(value: T | undefined, current: T) => (value === undefined ? current : value);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE orders SET admin_note = ?, tracking_number = ?, carrier = ?, tracking_url = ?, estimated_delivery = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(
      keep(input.adminNote, order.admin_note),
      keep(input.trackingNumber, order.tracking_number),
      keep(input.carrier, order.carrier),
      keep(input.trackingUrl, order.tracking_url),
      keep(input.estimatedDelivery, order.estimated_delivery),
      order.id,
    ),
    auditStatement(c, { action: "order.update", entityType: "order", targetId: order.id, metadata: input }),
  ]);
  return ok(c, await loadDetail(c, order.id));
});

/** Raises a refund request (full by default) for approval on the Refunds page. */
adminOrderRoutes.post("/:id/refund", can("refunds.create"), async (c) => {
  const input = await body(c, z.object({ amount: money.positive().optional(), reason: z.string().trim().min(3, "Give a reason for the refund.").max(500) }));
  const { order } = await loadOrder(c.env.DB, c.req.param("id"));
  await requestRefund(orderActor(c), order.id, input.amount === undefined ? null : toPaise(input.amount), input.reason);
  return ok(c, await loadDetail(c, order.id));
});

/** Re-checks the order's payments with Razorpay, e.g. when a customer says they paid but the order still shows unpaid. */
adminOrderRoutes.post("/:id/payments/sync", can("payments.sync"), async (c) => {
  const { order } = await loadOrder(c.env.DB, c.req.param("id"));
  if (order.payment_method !== "RAZORPAY") throw conflict("NOT_ONLINE_PAYMENT", "Only online payments can be re-checked.");
  const outcomes = await syncOrderPayments(orderActor(c), order.id, "admin-sync");
  return ok(c, { outcomes, order: await loadDetail(c, order.id) });
});
