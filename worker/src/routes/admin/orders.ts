import { Hono, type Context } from "hono";
import { z } from "zod";
import { hasPermission } from "../../auth/permissions";
import { loadOrder, ORDER_STATUSES, TRANSITIONS, transitionOrder, type HistoryRow, type OrderItemRow, type OrderRow } from "../../commerce/orders";
import { auditStatement } from "../../lib/audit";
import { forbidden, notImplemented } from "../../lib/errors";
import { csv, ok, paginated } from "../../lib/http";
import { likePattern, parseJson, toIso, toRupees } from "../../lib/util";
import { body, query } from "../../lib/validation";
import { can, currentUser } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import { resolverFor } from "../catalog";

type Row = OrderRow & { first_name: string | null; last_name: string | null; user_name: string | null; user_email: string | null };

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(120).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(["UNPAID", "PAID", "REFUNDED"]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
  if (input.userId) {
    where.push("o.user_id = ?");
    binds.push(input.userId);
  }
  if (input.q) {
    where.push("(o.order_number LIKE ? ESCAPE '\\' OR o.shipping_email LIKE ? ESCAPE '\\' OR o.shipping_name LIKE ? ESCAPE '\\' OR o.shipping_phone LIKE ? ESCAPE '\\')");
    binds.push(...Array(4).fill(likePattern(input.q)));
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
        total: toRupees(row.total_paise),
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
  const input = query(c, listSchema.omit({ page: true, limit: true }).extend({ page: z.literal(1).default(1), limit: z.literal(5000).default(5000) }));
  const { clause, binds } = filters(input);
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
      name: row.shipping_name,
      email: row.shipping_email,
      phone: row.shipping_phone,
      city: parseJson<Record<string, string>>(row.shipping_address_json, {}).city ?? "",
      subtotal: toRupees(row.subtotal_paise),
      shipping: toRupees(row.shipping_paise),
      total: toRupees(row.total_paise),
      trackingNumber: row.tracking_number ?? "",
    })),
    ["orderNumber", "placedAt", "status", "paymentStatus", "paymentMethod", "name", "email", "phone", "city", "subtotal", "shipping", "total", "trackingNumber"],
  );
});

function detailDto(order: Row | OrderRow, items: OrderItemRow[], history: HistoryRow[], resolve: (url: string) => string) {
  const address = parseJson<Record<string, string>>(order.shipping_address_json, {});
  return {
    id: order.id,
    orderNumber: order.order_number,
    email: order.shipping_email,
    phone: order.shipping_phone,
    status: order.status,
    allowedTransitions: TRANSITIONS[order.status],
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method,
    subtotal: toRupees(order.subtotal_paise),
    discount: 0,
    shippingFee: toRupees(order.shipping_paise),
    taxAmount: toRupees(order.tax_paise),
    total: toRupees(order.total_paise),
    couponCode: null,
    shippingAddress: { fullName: order.shipping_name, phone: order.shipping_phone, ...address },
    shippingMethod: order.shipping_method,
    giftMessage: null,
    customerNote: order.customer_note,
    adminNote: order.admin_note,
    trackingNumber: order.tracking_number,
    carrier: order.carrier,
    estimatedDelivery: null,
    placedAt: toIso(order.created_at),
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
    payments: [],
    refunds: [],
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
  const { order, items, history } = await loadOrder(c.env.DB, orderId);
  const user = await c.env.DB.prepare(`${SELECT} WHERE o.id = ?`).bind(order.id).first<Row>();
  return detailDto(user ?? order, items, history, resolverFor(c));
}

adminOrderRoutes.get("/:id", can("orders.view"), async (c) => ok(c, await loadDetail(c, c.req.param("id"))));

adminOrderRoutes.patch("/:id/status", can("orders.update"), async (c) => {
  const input = await body(
    c,
    z.object({
      status: z.enum(ORDER_STATUSES),
      note: z.string().trim().max(500).optional(),
      trackingNumber: z.string().trim().max(100).optional(),
      carrier: z.string().trim().max(100).optional(),
    }),
  );
  const auth = currentUser(c);
  const needed = input.status === "CANCELLED" ? "orders.cancel" : ["PACKED", "SHIPPED", "DELIVERED"].includes(input.status) ? "orders.fulfil" : "orders.update";
  if (!hasPermission(auth.adminRole, needed)) throw forbidden(`You need the ${needed} permission for this change.`);
  const { order } = await loadOrder(c.env.DB, c.req.param("id"));
  await transitionOrder(c, order, input.status, { note: input.note ?? null, actorId: auth.userId, extra: { trackingNumber: input.trackingNumber, carrier: input.carrier } });
  return ok(c, await loadDetail(c, order.id));
});

adminOrderRoutes.patch("/:id", can("orders.update"), async (c) => {
  const input = await body(
    c,
    z.object({
      adminNote: z.string().trim().max(2000).nullable().optional(),
      trackingNumber: z.string().trim().max(100).nullable().optional(),
      carrier: z.string().trim().max(100).nullable().optional(),
    }),
  );
  const { order } = await loadOrder(c.env.DB, c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE orders SET admin_note = ?, tracking_number = ?, carrier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(
      input.adminNote === undefined ? order.admin_note : input.adminNote,
      input.trackingNumber === undefined ? order.tracking_number : input.trackingNumber,
      input.carrier === undefined ? order.carrier : input.carrier,
      order.id,
    ),
    auditStatement(c, { action: "order.update", entityType: "order", targetId: order.id, metadata: input }),
  ]);
  return ok(c, await loadDetail(c, order.id));
});

adminOrderRoutes.post("/:id/refund", () => {
  throw notImplemented("Refunds require a payment provider, which is not enabled yet.");
});
