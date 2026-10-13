import type { Context } from "hono";
import { auditStatement } from "../lib/audit";
import { badRequest, conflict, isStockViolation, isUniqueViolation, notFound, serviceUnavailable, validationError } from "../lib/errors";
import { newId, parseJson, toIso, toRupees } from "../lib/util";
import type { MediaResolver } from "../catalog/model";
import type { AppEnv } from "../types";
import { COD_LIMIT_PAISE, computeTotals, loadCartLines, type ShippingMethod } from "./cart";

export const ORDER_STATUSES = ["PENDING", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PACKED", "CANCELLED"],
  PACKED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

export const CUSTOMER_CANCELLABLE: OrderStatus[] = ["PENDING", "CONFIRMED"];

/** The storefront vocabulary has no "packed"; it shows as "processing". */
const STOREFRONT_STATUS: Record<OrderStatus, string> = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  PACKED: "processing",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
};

export interface OrderRow {
  id: string;
  order_number: string;
  user_id: string;
  status: OrderStatus;
  payment_status: string;
  payment_method: string;
  shipping_name: string;
  shipping_email: string;
  shipping_phone: string;
  shipping_address_json: string;
  subtotal_paise: number;
  shipping_paise: number;
  tax_paise: number;
  total_paise: number;
  shipping_method: string;
  customer_note: string | null;
  admin_note: string | null;
  tracking_number: string | null;
  carrier: string | null;
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

export function orderItemDto(item: OrderItemRow, resolve: MediaResolver) {
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
    unitPrice: toRupees(item.unit_price_paise),
    quantity: item.quantity,
    lineTotal: toRupees(item.line_total_paise),
  };
}

export function orderDto(order: OrderRow, items: OrderItemRow[], resolve: MediaResolver, history?: HistoryRow[]) {
  const address = parseJson<Record<string, unknown>>(order.shipping_address_json, {});
  return {
    id: order.id,
    orderNumber: order.order_number,
    number: order.order_number,
    status: STOREFRONT_STATUS[order.status],
    fulfilmentStatus: order.status,
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method,
    placedAt: toIso(order.created_at),
    createdAt: toIso(order.created_at),
    updatedAt: toIso(order.updated_at),
    items: items.map((item) => orderItemDto(item, resolve)),
    totals: {
      subtotal: toRupees(order.subtotal_paise),
      discount: 0,
      shipping: toRupees(order.shipping_paise),
      tax: toRupees(order.tax_paise),
      total: toRupees(order.total_paise),
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    },
    shippingAddress: { ...address, fullName: order.shipping_name, email: order.shipping_email, phone: order.shipping_phone },
    shippingMethod: order.shipping_method,
    customerNote: order.customer_note,
    trackingNumber: order.tracking_number,
    carrier: order.carrier,
    canCancel: CUSTOMER_CANCELLABLE.includes(order.status),
    ...(history
      ? {
          history: history.map((entry) => ({
            id: entry.id,
            from: entry.from_status,
            to: entry.to_status,
            note: entry.note,
            changedBy: entry.changed_by_name ?? null,
            createdAt: toIso(entry.created_at),
          })),
        }
      : {}),
  };
}

export async function loadOrder(db: D1Database, orderIdOrNumber: string, userId?: string) {
  const [orders, items, history] = await db.batch([
    db
      .prepare(`SELECT * FROM orders WHERE (id = ?1 OR order_number = ?1) ${userId ? "AND user_id = ?2" : ""}`)
      .bind(...(userId ? [orderIdOrNumber, userId] : [orderIdOrNumber])),
    db.prepare(`SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.id = ?1 OR o.order_number = ?1 ORDER BY oi.rowid`).bind(orderIdOrNumber),
    db
      .prepare(
        `SELECT h.*, u.name AS changed_by_name FROM order_status_history h JOIN orders o ON o.id = h.order_id
           LEFT JOIN users u ON u.id = h.changed_by WHERE o.id = ?1 OR o.order_number = ?1 ORDER BY h.created_at, h.rowid`,
      )
      .bind(orderIdOrNumber),
  ]);
  const order = orders?.results[0] as OrderRow | undefined;
  if (!order) throw notFound("Order");
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
  idempotencyKey?: string;
}

/**
 * Places an order from the customer's bag in one atomic D1 batch. Stock is
 * decremented in the same batch; the stock CHECK constraint and the
 * products_stock_nonnegative trigger abort the whole batch if any line would
 * oversell, so two concurrent checkouts can never both take the last unit.
 */
export async function createOrder(c: Context<AppEnv>, input: CreateOrderInput): Promise<{ orderId: string; replayed: boolean }> {
  if (!c.get("config").checkoutEnabled) {
    throw serviceUnavailable("CHECKOUT_DISABLED", "Checkout is not open yet. Your bag has been saved.");
  }
  if (input.paymentMethod !== "COD") {
    throw validationError({ paymentMethod: "Online payment is not available yet. Choose cash on delivery." });
  }

  const db = c.env.DB;
  const auth = c.get("auth")!;
  if (input.idempotencyKey) {
    const existing = await db
      .prepare(`SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ?`)
      .bind(auth.userId, input.idempotencyKey)
      .first<{ id: string }>();
    if (existing) return { orderId: existing.id, replayed: true };
  }

  const lines = await loadCartLines(db, auth.userId);
  if (!lines.length) throw badRequest("Your bag is empty.");
  const problems = lines.filter((line) => line.issue);
  if (problems.length) {
    throw conflict(
      "CART_INVALID",
      "Some items in your bag are no longer available in the requested quantity.",
      Object.fromEntries(problems.map((line) => [line.key, line.issue === "UNAVAILABLE" ? "No longer available." : `Only ${Math.max(0, line.stock)} left.`])),
    );
  }
  const totals = computeTotals(lines, input.shippingMethod);
  if (totals.total > COD_LIMIT_PAISE) {
    throw validationError({ paymentMethod: `Cash on delivery is available for orders up to ₹${toRupees(COD_LIMIT_PAISE).toLocaleString("en-IN")}.` });
  }

  const address = { line1: input.address.line1, line2: input.address.line2 ?? null, city: input.address.city, state: input.address.state, postalCode: input.address.postalCode, country: input.address.country };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const orderId = newId();
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO orders (id, order_number, user_id, status, payment_status, payment_method, shipping_name, shipping_email, shipping_phone, shipping_address_json,
                               subtotal_paise, shipping_paise, tax_paise, total_paise, shipping_method, customer_note, idempotency_key, status_note, status_changed_by)
           VALUES (?, ?, ?, 'PENDING', 'UNPAID', 'COD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Order placed', ?)`,
        )
        .bind(
          orderId,
          orderNumber(),
          auth.userId,
          input.address.fullName,
          input.address.email,
          input.address.phone,
          JSON.stringify(address),
          totals.subtotal,
          totals.shipping,
          totals.tax,
          totals.total,
          input.shippingMethod,
          input.customerNote ?? null,
          input.idempotencyKey ?? null,
          auth.userId,
        ),
      db
        .prepare(`INSERT INTO order_status_history (id, order_id, from_status, to_status, note, changed_by) VALUES (?, ?, NULL, 'PENDING', 'Order placed', ?)`)
        .bind(newId(), orderId, auth.userId),
    ];

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
    statements.push(auditStatement(c, { action: "order.create", entityType: "order", targetId: orderId, metadata: { total: totals.total, lines: lines.length } }));

    try {
      await db.batch(statements);
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
      if (isStockViolation(error) || /NOT NULL constraint failed: inventory_movements/i.test(message)) {
        throw conflict("INSUFFICIENT_STOCK", "Some items sold out while you were checking out. Please review your bag.");
      }
      throw error;
    }
  }
  throw conflict("ORDER_NUMBER_EXHAUSTED", "Could not allocate an order number. Please try again.");
}

/**
 * Compare-and-set status change. The UPDATE only matches the status we read,
 * so concurrent changes cannot both apply, and the cancel trigger restocks
 * exactly once.
 */
export async function transitionOrder(
  c: Context<AppEnv>,
  order: OrderRow,
  to: OrderStatus,
  options: { note?: string | null; actorId: string; allowed?: OrderStatus[]; extra?: { trackingNumber?: string | null; carrier?: string | null } },
): Promise<void> {
  const allowed = options.allowed ?? TRANSITIONS[order.status];
  if (!allowed.includes(to)) {
    throw conflict("INVALID_TRANSITION", `An order that is ${order.status.toLowerCase()} cannot be moved to ${to.toLowerCase()}.`);
  }
  const db = c.env.DB;
  const result = await db.batch([
    db
      .prepare(
        `UPDATE orders SET status = ?, status_note = ?, status_changed_by = ?, updated_at = CURRENT_TIMESTAMP,
                tracking_number = COALESCE(?, tracking_number), carrier = COALESCE(?, carrier)
          WHERE id = ? AND status = ?`,
      )
      .bind(to, options.note ?? null, options.actorId, options.extra?.trackingNumber ?? null, options.extra?.carrier ?? null, order.id, order.status),
    auditStatement(c, { action: `order.status.${to.toLowerCase()}`, entityType: "order", targetId: order.id, metadata: { from: order.status, to, note: options.note } }),
  ]);
  // D1 counts trigger writes in `changes`, so only zero means the compare-and-set missed.
  if ((result[0]?.meta.changes ?? 0) === 0) {
    throw conflict("ORDER_CHANGED", "This order was updated by someone else. Reload and try again.");
  }
}
