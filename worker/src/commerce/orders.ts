import type { Context } from "hono";
import type { MediaResolver } from "../catalog/model";
import { loadCommerceRules } from "../content/settings";
import { orderConfirmedMail, orderStatusMail, sendMail } from "../email/mailer";
import type { Config } from "../env";
import { actorAuditStatement, actorFrom, type Actor } from "../lib/audit";
import { badRequest, conflict, isStockViolation, isUniqueViolation, notFound, serviceUnavailable, validationError } from "../lib/errors";
import { newId, parseJson, toIso, toRupees } from "../lib/util";
import type { AppEnv } from "../types";
import { applyCoupon, computeTotals, loadCartLines, type ShippingMethod } from "./cart";
import { currencyForDestination, currencyOf, formatMoney, toMajor, type Currency } from "./currency";

export const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
  "PAID",
  "PROCESSING",
  "PACKED",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "RETURN_REQUESTED",
  "RETURNED",
  "REFUND_PENDING",
  "REFUNDED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ["UNPAID", "PENDING", "PAID", "FAILED", "REFUND_PENDING", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Moves an admin may make by hand. Payment states (PAYMENT_*, PAID) and refund
 * states (REFUND_PENDING, REFUNDED) are only ever set by verified gateway
 * events and the refund workflow, never directly.
 */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ["PROCESSING", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "PACKED", "CANCELLED"],
  PAYMENT_PENDING: ["CANCELLED"],
  PAYMENT_FAILED: ["CANCELLED"],
  PAID: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["PACKED", "CANCELLED"],
  PACKED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["OUT_FOR_DELIVERY", "DELIVERED", "RETURNED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "RETURNED"],
  DELIVERED: ["RETURN_REQUESTED"],
  RETURN_REQUESTED: ["RETURNED", "DELIVERED"],
  RETURNED: [],
  CANCELLED: [],
  REFUND_PENDING: [],
  REFUNDED: [],
};

export const CUSTOMER_CANCELLABLE: OrderStatus[] = ["PENDING", "CONFIRMED", "PAYMENT_PENDING", "PAYMENT_FAILED", "PAID", "PROCESSING"];
export const AWAITING_PAYMENT: OrderStatus[] = ["PAYMENT_PENDING", "PAYMENT_FAILED"];
export const PAID_STATES: PaymentStatus[] = ["PAID", "PARTIALLY_REFUNDED"];

/** Online payment methods the storefront may name; all are taken through Razorpay Checkout. */
export const ONLINE_METHODS = ["RAZORPAY", "UPI", "CARD", "NETBANKING", "WALLET"] as const;

export interface OrderRow {
  id: string;
  order_number: string;
  user_id: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  payment_method: "COD" | "RAZORPAY";
  /** Every *_paise amount on the order (and its items, payments, refunds) is in minor units of this currency. */
  currency: Currency;
  pricing_country: string | null;
  shipping_name: string;
  shipping_email: string;
  shipping_phone: string;
  shipping_address_json: string;
  subtotal_paise: number;
  shipping_paise: number;
  tax_paise: number;
  discount_paise: number;
  total_paise: number;
  refunded_paise: number;
  coupon_code: string | null;
  shipping_method: string;
  customer_note: string | null;
  admin_note: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  carrier: string | null;
  estimated_delivery: string | null;
  payment_expires_at: number | null;
  return_reason: string | null;
  return_requested_at: string | null;
  paid_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  product_slug: string;
  product_name: string;
  variant_id: string;
  sku: string | null;
  variant_label: string | null;
  color_name: string | null;
  size_name: string | null;
  image_url: string | null;
  quantity: number;
  unit_price_paise: number;
  line_total_paise: number;
}

export interface HistoryRow {
  id: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  changed_by: string | null;
  changed_by_name?: string | null;
  created_at: string;
}

export function orderItemDto(item: OrderItemRow, resolve: MediaResolver, currency: Currency = "INR") {
  return {
    id: item.id,
    productId: item.product_id,
    productSlug: item.product_slug,
    name: item.product_name,
    variantId: item.variant_id || null,
    sku: item.sku,
    color: item.color_name,
    size: item.size_name,
    variantLabel: item.variant_label,
    image: item.image_url ? { url: resolve(item.image_url), alt: item.product_name } : null,
    imageUrl: item.image_url ? resolve(item.image_url) : null,
    unitPrice: toMajor(item.unit_price_paise),
    quantity: item.quantity,
    lineTotal: toMajor(item.line_total_paise),
    currency,
  };
}

export function deliveredDaysAgo(order: OrderRow): number | null {
  const delivered = toIso(order.delivered_at);
  return delivered ? (Date.now() - Date.parse(delivered)) / 86_400_000 : null;
}

export function canRequestReturn(order: OrderRow, returnWindowDays: number): boolean {
  const days = deliveredDaysAgo(order);
  return order.status === "DELIVERED" && PAID_STATES.includes(order.payment_status) && days !== null && days <= returnWindowDays;
}

/** Storefront shape. `status` is the lower-case lifecycle state. */
export function orderDto(order: OrderRow, items: OrderItemRow[], resolve: MediaResolver, history?: HistoryRow[], options: { returnWindowDays?: number } = {}) {
  const address = parseJson<Record<string, unknown>>(order.shipping_address_json, {});
  const awaitingPayment = order.payment_method === "RAZORPAY" && AWAITING_PAYMENT.includes(order.status);
  const currency = currencyOf(order.currency);
  return {
    id: order.id,
    orderNumber: order.order_number,
    number: order.order_number,
    status: order.status.toLowerCase(),
    fulfilmentStatus: order.status,
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method,
    placedAt: toIso(order.created_at),
    createdAt: toIso(order.created_at),
    updatedAt: toIso(order.updated_at),
    paidAt: toIso(order.paid_at),
    shippedAt: toIso(order.shipped_at),
    deliveredAt: toIso(order.delivered_at),
    cancelledAt: toIso(order.cancelled_at),
    currency,
    items: items.map((item) => orderItemDto(item, resolve, currency)),
    totals: {
      subtotal: toMajor(order.subtotal_paise),
      discount: toMajor(order.discount_paise),
      shipping: toMajor(order.shipping_paise),
      tax: toMajor(order.tax_paise),
      total: toMajor(order.total_paise),
      refunded: toMajor(order.refunded_paise),
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    },
    couponCode: order.coupon_code,
    shippingAddress: { ...address, fullName: order.shipping_name, email: order.shipping_email, phone: order.shipping_phone },
    shippingMethod: order.shipping_method,
    customerNote: order.customer_note,
    trackingNumber: order.tracking_number,
    trackingUrl: order.tracking_url,
    carrier: order.carrier,
    estimatedDelivery: order.estimated_delivery,
    returnReason: order.return_reason,
    canCancel: CUSTOMER_CANCELLABLE.includes(order.status),
    canReturn: options.returnWindowDays !== undefined ? canRequestReturn(order, options.returnWindowDays) : false,
    awaitingPayment,
    paymentExpiresAt: awaitingPayment && order.payment_expires_at ? new Date(order.payment_expires_at).toISOString() : null,
    ...(history
      ? {
          // Notes are left out: staff use them for internal remarks.
          history: history.map((entry) => ({
            id: entry.id,
            from: entry.from_status?.toLowerCase() ?? null,
            to: entry.to_status.toLowerCase(),
            createdAt: toIso(entry.created_at),
          })),
        }
      : {}),
  };
}

export async function loadOrder(db: D1Database, orderIdOrNumber: string, userId?: string) {
  const order = await db
    .prepare(`SELECT * FROM orders WHERE (id = ?1 OR order_number = ?1) ${userId ? "AND user_id = ?2" : ""}`)
    .bind(...(userId ? [orderIdOrNumber, userId] : [orderIdOrNumber]))
    .first<OrderRow>();
  if (!order) throw notFound("Order");
  const [items, history] = await db.batch([
    db.prepare(`SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid`).bind(order.id),
    db
      .prepare(
        `SELECT h.*, u.name AS changed_by_name FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.order_id = ? ORDER BY h.created_at, h.rowid`,
      )
      .bind(order.id),
  ]);
  return { order, items: (items?.results ?? []) as unknown as OrderItemRow[], history: (history?.results ?? []) as unknown as HistoryRow[] };
}

function orderNumber(): string {
  const digits = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return `PSH-${String(digits).padStart(6, "0")}`;
}

export interface CreateOrderInput {
  address: { fullName: string; email: string; phone: string; line1: string; line2?: string | null; city: string; state: string; postalCode: string; country: string };
  shippingMethod: ShippingMethod;
  paymentMethod: string;
  customerNote?: string;
  couponCode?: string | null;
  idempotencyKey?: string;
  /** The currency the customer was shown; a mismatch means prices changed under them. */
  currency?: Currency;
}

/**
 * Places an order from the customer's bag in one atomic D1 batch: prices,
 * discount and totals are recomputed here from the database, and stock is
 * decremented in the same batch. The stock CHECK constraint and the
 * products_stock_nonnegative trigger abort the whole batch if any line would
 * oversell, so two concurrent checkouts can never both take the last unit.
 *
 * The order is priced in the currency of its destination (INR for India, USD
 * elsewhere), which must also be the shopper's current region, so the prices
 * charged are the ones they were shown. Amounts are snapshotted on the order,
 * so later price edits never change it.
 *
 * Online orders start as PAYMENT_PENDING and hold their stock until paid or
 * until the payment window lapses (see payments/service expireUnpaidOrders).
 */
export async function createOrder(c: Context<AppEnv>, input: CreateOrderInput): Promise<{ orderId: string; replayed: boolean }> {
  const config = c.get("config");
  if (!config.checkoutEnabled) {
    throw serviceUnavailable("CHECKOUT_DISABLED", "Checkout is not open yet. Your bag has been saved.");
  }
  const method: "COD" | "RAZORPAY" = input.paymentMethod === "COD" ? "COD" : "RAZORPAY";
  if (method === "COD" && !config.codEnabled) throw validationError({ paymentMethod: "Cash on delivery isn't available. Please pay online." });
  if (method === "RAZORPAY" && !config.razorpay) throw validationError({ paymentMethod: "Online payment isn't available right now. Please choose cash on delivery." });

  const db = c.env.DB;
  const auth = c.get("auth")!;
  const currency = currencyForDestination(input.address.country);
  if (input.idempotencyKey) {
    const existing = await db
      .prepare(`SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ?`)
      .bind(auth.userId, input.idempotencyKey)
      .first<{ id: string }>();
    if (existing) return { orderId: existing.id, replayed: true };
  }
  if (currency !== c.get("currency")) {
    throw conflict(
      "REGION_MISMATCH",
      currency === "INR"
        ? "Orders delivered in India are priced in Indian Rupees. Switch your shopping region to India to review your bag in ₹ before paying."
        : "Orders delivered outside India are priced in US Dollars. Switch your shopping region to review your bag in $ before paying.",
      { country: "Your delivery country does not match your shopping region.", currency },
    );
  }
  if (input.currency && input.currency !== currency) {
    throw conflict("CURRENCY_CHANGED", "Your bag's currency changed. Please review your order before paying.", { currency });
  }
  if (method === "COD" && currency !== "INR") throw validationError({ paymentMethod: "Cash on delivery is available in India only. Please pay online." });

  const [lines, rules, storedCoupon] = await Promise.all([
    loadCartLines(db, auth.userId, currency),
    loadCommerceRules(db, currency),
    db.prepare(`SELECT code FROM cart_coupons WHERE user_id = ?`).bind(auth.userId).first<{ code: string }>(),
  ]);
  if (!lines.length) throw badRequest("Your bag is empty.");
  const problems = lines.filter((line) => line.issue);
  if (problems.length) {
    throw conflict(
      "CART_INVALID",
      "Some items in your bag are no longer available in the requested quantity.",
      Object.fromEntries(
        problems.map((line) => [
          line.key,
          line.issue === "UNAVAILABLE" ? "No longer available." : line.issue === "REGION_UNAVAILABLE" ? "Not available in your region." : `Only ${Math.max(0, line.stock)} left.`,
        ]),
      ),
    );
  }

  const couponCode = input.couponCode === undefined ? storedCoupon?.code : input.couponCode;
  const applied = await applyCoupon(db, couponCode, lines, auth.userId, currency);
  if (applied.problem) throw conflict(applied.problem.code, applied.problem.message, { couponCode: applied.problem.message });

  const totals = computeTotals(lines, rules, input.shippingMethod, applied.discountPaise);
  if (totals.total <= 0) throw badRequest("This order has nothing to pay for.");
  if (method === "COD" && totals.total > rules.codLimitPaise) {
    throw validationError({ paymentMethod: `Cash on delivery is available for orders up to ₹${toRupees(rules.codLimitPaise).toLocaleString("en-IN")}.` });
  }

  const address = { line1: input.address.line1, line2: input.address.line2 ?? null, city: input.address.city, state: input.address.state, postalCode: input.address.postalCode, country: input.address.country };
  const initialStatus: OrderStatus = method === "COD" ? "PENDING" : "PAYMENT_PENDING";
  const paymentStatus: PaymentStatus = method === "COD" ? "UNPAID" : "PENDING";
  const expiresAt = method === "RAZORPAY" ? Date.now() + rules.paymentWindowMinutes * 60_000 : null;
  const placedNote = method === "COD" ? "Order placed (cash on delivery)" : "Order placed, awaiting payment";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const orderId = newId();
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO orders (id, order_number, user_id, status, payment_status, payment_method, shipping_name, shipping_email, shipping_phone, shipping_address_json,
                               subtotal_paise, shipping_paise, tax_paise, discount_paise, total_paise, coupon_code, shipping_method, customer_note, idempotency_key,
                               payment_expires_at, status_note, status_changed_by, currency, pricing_country)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          orderId,
          orderNumber(),
          auth.userId,
          initialStatus,
          paymentStatus,
          method,
          input.address.fullName,
          input.address.email,
          input.address.phone,
          JSON.stringify(address),
          totals.subtotal,
          totals.shipping,
          totals.tax,
          totals.discount,
          totals.total,
          applied.coupon?.code ?? null,
          input.shippingMethod,
          input.customerNote ?? null,
          input.idempotencyKey ?? null,
          expiresAt,
          placedNote,
          auth.userId,
          currency,
          c.get("country"),
        ),
      db
        .prepare(`INSERT INTO order_status_history (id, order_id, from_status, to_status, note, changed_by) VALUES (?, ?, NULL, ?, ?, ?)`)
        .bind(newId(), orderId, initialStatus, placedNote, auth.userId),
    ];

    if (applied.coupon) {
      // The per-customer trigger and the used_count CHECK abort the batch if the code ran out meanwhile.
      statements.push(
        db
          .prepare(`INSERT INTO coupon_redemptions (id, coupon_id, order_id, user_id, discount_paise) VALUES (?, ?, ?, ?, ?)`)
          .bind(newId(), applied.coupon.id, orderId, auth.userId, totals.discount),
      );
    }

    for (const line of lines) {
      statements.push(
        db
          .prepare(
            `INSERT INTO order_items (id, order_id, product_id, product_slug, product_name, variant_id, sku, variant_label, color_name, size_name, image_url,
                                      quantity, unit_price_paise, line_total_paise)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            newId(),
            orderId,
            line.productId,
            line.productSlug,
            line.name,
            line.storedVariantId,
            line.sku,
            [line.color, line.size].filter(Boolean).join(" / ") || null,
            line.color,
            line.size,
            line.imageUrl,
            line.quantity,
            line.unitPricePaise,
            line.unitPricePaise * line.quantity,
          ),
      );
      if (line.storedVariantId) {
        // An inactive variant or unpublished product forces stock to -1, which the CHECK rejects.
        statements.push(
          db
            .prepare(
              `UPDATE product_variants
                  SET stock = CASE WHEN is_active = 1 AND (SELECT status FROM products WHERE id = product_variants.product_id) = 'PUBLISHED' THEN stock - ?1 ELSE -1 END,
                      updated_at = CURRENT_TIMESTAMP
                WHERE id = ?2`,
            )
            .bind(line.quantity, line.storedVariantId),
        );
        // product_id is NOT NULL: a vanished variant makes this insert (and the batch) fail.
        statements.push(
          db
            .prepare(
              `INSERT INTO inventory_movements (id, product_id, variant_id, delta, reason, reference_id, actor_id)
               VALUES (?, (SELECT product_id FROM product_variants WHERE id = ?2), ?2, ?, 'ORDER', ?, ?)`,
            )
            .bind(newId(), line.storedVariantId, -line.quantity, orderId, auth.userId),
        );
      } else {
        statements.push(
          db
            .prepare(`UPDATE products SET stock = CASE WHEN status = 'PUBLISHED' THEN stock - ?1 ELSE -1 END, updated_at = CURRENT_TIMESTAMP WHERE id = ?2`)
            .bind(line.quantity, line.productId),
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO inventory_movements (id, product_id, variant_id, delta, reason, reference_id, actor_id)
               VALUES (?, (SELECT id FROM products WHERE id = ?), NULL, ?, 'ORDER', ?, ?)`,
            )
            .bind(newId(), line.productId, -line.quantity, orderId, auth.userId),
        );
      }
      statements.push(db.prepare(`UPDATE products SET sold_count = sold_count + ? WHERE id = ?`).bind(line.quantity, line.productId));
    }

    statements.push(db.prepare(`DELETE FROM cart_items WHERE user_id = ?`).bind(auth.userId));
    statements.push(db.prepare(`DELETE FROM cart_coupons WHERE user_id = ?`).bind(auth.userId));
    statements.push(
      actorAuditStatement(actorFrom(c), {
        action: "order.create",
        entityType: "order",
        targetId: orderId,
        metadata: { total: totals.total, currency, lines: lines.length, method, coupon: applied.coupon?.code ?? null },
      }),
    );

    try {
      await db.batch(statements);
      if (method === "COD") c.executionCtx.waitUntil(notifyOrderConfirmed(config, db, orderId));
      return { orderId, replayed: false };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (isUniqueViolation(error) && /order_number/.test(message)) continue;
      if (isUniqueViolation(error) && input.idempotencyKey) {
        const existing = await db
          .prepare(`SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ?`)
          .bind(auth.userId, input.idempotencyKey)
          .first<{ id: string }>();
        if (existing) return { orderId: existing.id, replayed: true };
      }
      if (/Coupon limit reached/i.test(message)) throw conflict("COUPON_LIMIT_REACHED", "You've already used this code.", { couponCode: "You've already used this code." });
      if (/CHECK constraint failed: .*(used_count|usage_limit)/i.test(message) || /CHECK constraint failed: coupons/i.test(message)) {
        throw conflict("COUPON_EXHAUSTED", "That code has just been fully redeemed.", { couponCode: "That code has just been fully redeemed." });
      }
      if (isStockViolation(error) || /NOT NULL constraint failed: inventory_movements/i.test(message)) {
        throw conflict("INSUFFICIENT_STOCK", "Some items sold out while you were checking out. Please review your bag.");
      }
      throw error;
    }
  }
  throw conflict("ORDER_NUMBER_EXHAUSTED", "Could not allocate an order number. Please try again.");
}

/**
 * Raises a refund for whatever has been paid and not yet refunded, but only if
 * the order is marked REFUND_PENDING and no refund is already open (the
 * partial unique index makes the second of two racing inserts fail).
 */
export function refundRequestStatement(db: D1Database, orderId: string, reason: string, actorId: string | null): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO refunds (id, order_id, payment_id, provider, amount_paise, reason, status, requested_by)
       SELECT ?1, o.id,
              (SELECT p.id FROM payments p WHERE p.order_id = o.id AND p.status IN ('CAPTURED','PARTIALLY_REFUNDED')
                ORDER BY p.captured_at DESC, p.rowid DESC LIMIT 1),
              CASE WHEN o.payment_method = 'RAZORPAY' THEN 'razorpay' ELSE 'manual' END,
              o.total_paise - o.refunded_paise, ?2, 'REQUESTED', ?3
         FROM orders o
        WHERE o.id = ?4 AND o.payment_status = 'REFUND_PENDING' AND o.total_paise > o.refunded_paise
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id AND r.status IN ('REQUESTED','PROCESSING'))`,
    )
    .bind(newId(), reason, actorId, orderId);
}

export interface TransitionOptions {
  note?: string | null;
  actorId: string | null;
  allowed?: OrderStatus[];
  extra?: { trackingNumber?: string | null; carrier?: string | null; trackingUrl?: string | null; estimatedDelivery?: string | null; returnReason?: string | null };
}

/**
 * Compare-and-set status change. The UPDATE only matches the status we read,
 * so concurrent changes cannot both apply; restocking happens in triggers on
 * the transition itself, so it happens exactly once. Cancelling or receiving
 * back a paid order raises a refund request in the same transaction.
 */
export async function transitionOrder(actor: Actor & { config?: Config; waitUntil?: (promise: Promise<unknown>) => void }, order: OrderRow, to: OrderStatus, options: TransitionOptions): Promise<void> {
  const allowed = options.allowed ?? TRANSITIONS[order.status];
  if (!allowed.includes(to)) {
    throw conflict("INVALID_TRANSITION", `An order that is ${label(order.status)} cannot be moved to ${label(to)}.`);
  }
  const db = actor.db;
  const needsRefund = (to === "CANCELLED" || to === "RETURNED") && PAID_STATES.includes(order.payment_status) && order.total_paise > order.refunded_paise;
  const extra = options.extra ?? {};
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE orders
            SET status = ?1, status_note = ?2, status_changed_by = ?3, updated_at = CURRENT_TIMESTAMP,
                tracking_number = COALESCE(?4, tracking_number), carrier = COALESCE(?5, carrier),
                tracking_url = COALESCE(?6, tracking_url), estimated_delivery = COALESCE(?7, estimated_delivery),
                return_reason = COALESCE(?8, return_reason),
                shipped_at = CASE WHEN ?1 = 'SHIPPED' THEN CURRENT_TIMESTAMP ELSE shipped_at END,
                delivered_at = CASE WHEN ?1 = 'DELIVERED' AND delivered_at IS NULL THEN CURRENT_TIMESTAMP ELSE delivered_at END,
                cancelled_at = CASE WHEN ?1 = 'CANCELLED' THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
                return_requested_at = CASE WHEN ?1 = 'RETURN_REQUESTED' THEN CURRENT_TIMESTAMP ELSE return_requested_at END,
                payment_expires_at = CASE WHEN ?1 = 'CANCELLED' THEN NULL ELSE payment_expires_at END,
                payment_status = CASE
                  WHEN ?9 = 1 THEN 'REFUND_PENDING'
                  WHEN ?1 = 'CANCELLED' AND payment_status = 'PENDING' THEN 'UNPAID'
                  ELSE payment_status END
          WHERE id = ?10 AND status = ?11`,
      )
      .bind(
        to,
        options.note ?? null,
        options.actorId,
        extra.trackingNumber ?? null,
        extra.carrier ?? null,
        extra.trackingUrl ?? null,
        extra.estimatedDelivery ?? null,
        extra.returnReason ?? null,
        needsRefund ? 1 : 0,
        order.id,
        order.status,
      ),
  ];
  if (to === "CANCELLED") {
    statements.push(
      db.prepare(`UPDATE payments SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'CREATED'`).bind(order.id),
    );
  }
  if (needsRefund) {
    statements.push(refundRequestStatement(db, order.id, to === "CANCELLED" ? "Order cancelled" : "Order returned", options.actorId));
    statements.push(
      db
        .prepare(
          `UPDATE orders SET status = 'REFUND_PENDING', status_note = 'Refund requested', status_changed_by = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = ? AND payment_status = 'REFUND_PENDING'`,
        )
        .bind(options.actorId, order.id, to),
    );
  }
  statements.push(
    actorAuditStatement(actor, { action: `order.status.${to.toLowerCase()}`, entityType: "order", targetId: order.id, metadata: { from: order.status, to, note: options.note } }),
  );
  const result = await db.batch(statements);
  // D1 counts trigger writes in `changes`, so only zero means the compare-and-set missed.
  if ((result[0]?.meta.changes ?? 0) === 0) {
    throw conflict("ORDER_CHANGED", "This order was updated by someone else. Reload and try again.");
  }
  if (actor.config && actor.waitUntil) actor.waitUntil(notifyStatus(actor.config, db, order.id, to));
}

const label = (status: string) => status.toLowerCase().replace(/_/g, " ");

export function orderLink(config: Config, order: Pick<OrderRow, "id">): string {
  return `${config.storefrontUrl}/account/orders/${order.id}`;
}

export async function notifyOrderConfirmed(config: Config, db: D1Database, orderId: string): Promise<void> {
  const order = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first<OrderRow>();
  if (!order) return;
  await sendMail(
    config,
    orderConfirmedMail({
      to: order.shipping_email,
      name: order.shipping_name,
      orderNumber: order.order_number,
      total: formatMoney(order.total_paise, currencyOf(order.currency)),
      link: orderLink(config, order),
      paymentMethod: order.payment_method,
    }),
  );
}

export async function notifyStatus(config: Config, db: D1Database, orderId: string, status: string): Promise<void> {
  const order = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first<OrderRow>();
  if (!order) return;
  const mail = orderStatusMail({
    to: order.shipping_email,
    name: order.shipping_name,
    orderNumber: order.order_number,
    total: formatMoney(order.total_paise, currencyOf(order.currency)),
    link: orderLink(config, order),
    status,
    trackingNumber: order.tracking_number,
    carrier: order.carrier,
    trackingUrl: order.tracking_url,
  });
  if (mail) await sendMail(config, mail);
}

/** Request-scoped actor plus what transitionOrder needs to send notifications. */
export function orderActor(c: Context<AppEnv>) {
  return { ...actorFrom(c), config: c.get("config"), waitUntil: (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise) };
}
