import { Hono } from "hono";
import { z } from "zod";
import { CURRENCIES } from "../../commerce/currency";
import { ORDER_STATUSES } from "../../commerce/orders";
import { auditStatement } from "../../lib/audit";
import { badRequest } from "../../lib/errors";
import { csv, ok, paginated } from "../../lib/http";
import { likePattern, toIso, toRupees } from "../../lib/util";
import { query } from "../../lib/validation";
import { can } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import { resolverFor } from "../catalog";

type Count = { n: number };
type Sum = { n: number; total: number };

function first<T>(result: D1Result | undefined): T {
  return (result?.results[0] ?? {}) as T;
}

function change(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

const LOW_STOCK = `p.stock > 0 AND p.stock <= COALESCE(p.low_stock_threshold, 6)`;
/** Orders that count as sales: placed and not abandoned at payment or cancelled. */
const BOOKED = `status NOT IN ('CANCELLED','PAYMENT_PENDING','PAYMENT_FAILED')`;
const DAY_MS = 86_400_000;
const sqlTime = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

const rangeSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  /** Money figures are reported for one currency at a time; rupees and dollars are never added together. */
  currency: z.enum(CURRENCIES).default("INR"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Either the last `days` days, or an explicit inclusive `from`–`to` date range (UTC). */
function resolveRange(input: z.output<typeof rangeSchema>) {
  if (input.from || input.to) {
    const end = input.to ? new Date(`${input.to}T23:59:59Z`) : new Date();
    const start = input.from ? new Date(`${input.from}T00:00:00Z`) : new Date(end.getTime() - 30 * DAY_MS);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) throw badRequest("Choose a valid date range.");
    const days = Math.min(366, Math.max(1, Math.ceil((end.getTime() - start.getTime()) / DAY_MS)));
    return { start, end, days };
  }
  const end = new Date();
  return { start: new Date(end.getTime() - input.days * DAY_MS), end, days: input.days };
}

function countByStatus(result: D1Result | undefined): Record<(typeof ORDER_STATUSES)[number], number> {
  const counts = Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0])) as Record<(typeof ORDER_STATUSES)[number], number>;
  for (const row of (result?.results ?? []) as Array<{ status: string; n: number }>) {
    if (row.status in counts) counts[row.status as (typeof ORDER_STATUSES)[number]] = row.n;
  }
  return counts;
}

export const adminDashboardRoutes = new Hono<AppEnv>();

adminDashboardRoutes.get("/", can("dashboard.view"), async (c) => {
  const input = query(c, rangeSchema);
  const currency = input.currency;
  const { start, end, days } = resolveRange(input);
  const db = c.env.DB;
  const from = sqlTime(start);
  const to = sqlTime(end);
  const previousFrom = sqlTime(new Date(start.getTime() - (end.getTime() - start.getTime())));
  const inRange = `created_at >= ? AND created_at <= ?`;
  const inCurrency = `currency = '${currency}'`;

  const [
    users,
    newUsers,
    products,
    published,
    orders,
    ordersInRange,
    revenue,
    previous,
    paid,
    pending,
    failed,
    refunds,
    pendingRefunds,
    lowStock,
    outOfStock,
    chart,
    recent,
    recentItems,
    trending,
    top,
    statuses,
    registrations,
    subscribers,
    enquiries,
  ] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'CUSTOMER' AND deleted_at IS NULL`),
    db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'CUSTOMER' AND deleted_at IS NULL AND ${inRange}`).bind(from, to),
    db.prepare(`SELECT COUNT(*) AS n FROM products WHERE status <> 'ARCHIVED'`),
    db.prepare(`SELECT COUNT(*) AS n FROM products WHERE status = 'PUBLISHED'`),
    db.prepare(`SELECT COUNT(*) AS n FROM orders`),
    db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE ${inRange}`).bind(from, to),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total FROM orders WHERE ${BOOKED} AND ${inCurrency} AND ${inRange}`).bind(from, to),
    db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total FROM orders WHERE ${BOOKED} AND ${inCurrency} AND created_at >= ? AND created_at < ?`)
      .bind(previousFrom, from),
    db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total FROM orders
          WHERE payment_status IN ('PAID','PARTIALLY_REFUNDED','REFUND_PENDING','REFUNDED') AND ${inCurrency} AND ${inRange}`,
      )
      .bind(from, to),
    db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total FROM orders WHERE payment_status IN ('UNPAID','PENDING') AND status <> 'CANCELLED' AND ${inCurrency} AND ${inRange}`)
      .bind(from, to),
    db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total FROM orders WHERE (payment_status = 'FAILED' OR status = 'PAYMENT_FAILED') AND ${inCurrency} AND ${inRange}`)
      .bind(from, to),
    db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(r.amount_paise), 0) AS total FROM refunds r JOIN orders o ON o.id = r.order_id
          WHERE r.status = 'COMPLETED' AND o.${inCurrency} AND r.completed_at >= ? AND r.completed_at <= ?`,
      )
      .bind(from, to),
    db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(r.amount_paise), 0) AS total FROM refunds r JOIN orders o ON o.id = r.order_id
        WHERE r.status IN ('REQUESTED','PROCESSING','FAILED') AND o.${inCurrency}`,
    ),
    db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE p.status = 'PUBLISHED' AND ${LOW_STOCK}`),
    db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE p.status = 'PUBLISHED' AND p.stock = 0`),
    db
      .prepare(
          `SELECT date(created_at) AS day, currency, COUNT(*) AS orders, COALESCE(SUM(total_paise), 0) AS revenue FROM orders WHERE ${BOOKED} AND ${inCurrency} AND ${inRange} GROUP BY day ORDER BY day`,
        )
      .bind(from, to),
    db.prepare(`SELECT id, order_number, shipping_email, status, payment_status, payment_method, currency, total_paise, created_at FROM orders ORDER BY created_at DESC, rowid DESC LIMIT 8`),
    db.prepare(
      `SELECT oi.order_id, oi.product_name, oi.quantity FROM order_items oi
        WHERE oi.order_id IN (SELECT id FROM orders ORDER BY created_at DESC, rowid DESC LIMIT 8) ORDER BY oi.rowid`,
    ),
    db.prepare(
      `SELECT p.slug, p.name, p.price_paise, p.price_usd_cents,
              (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY i.is_primary DESC, i.sort_order LIMIT 1) AS image_url
         FROM products p WHERE p.status = 'PUBLISHED'
        ORDER BY json_extract(p.product_json, '$.trendingOrder') IS NULL, json_extract(p.product_json, '$.trendingOrder'), p.popularity DESC, p.sold_count DESC
        LIMIT 6`,
    ),
    db
      .prepare(
        `SELECT oi.product_id, MAX(oi.product_name) AS name, SUM(oi.quantity) AS units, SUM(oi.line_total_paise) AS revenue
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.${BOOKED} AND o.${inCurrency} AND o.created_at >= ? AND o.created_at <= ?
          GROUP BY oi.product_id ORDER BY units DESC, revenue DESC LIMIT 5`,
      )
      .bind(from, to),
    db.prepare(`SELECT status, COUNT(*) AS n FROM orders WHERE ${inRange} GROUP BY status`).bind(from, to),
    db.prepare(`SELECT id, name, first_name, last_name, email, created_at FROM users WHERE role = 'CUSTOMER' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 6`),
    db.prepare(`SELECT COUNT(*) AS n FROM newsletter_subscribers WHERE status = 'SUBSCRIBED'`),
    db.prepare(`SELECT COUNT(*) AS n FROM contact_submissions WHERE status = 'NEW'`),
  ]);

  const range = first<Sum>(revenue);
  const before = first<Sum>(previous);
  const refunded = first<Sum>(refunds);
  const byDay = new Map(((chart?.results ?? []) as Array<{ day: string; orders: number; revenue: number }>).map((row) => [row.day, row]));
  const series: Array<{ date: string; revenue: number; orders: number }> = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(end.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
    const row = byDay.get(date);
    series.push({ date, revenue: toRupees(row?.revenue ?? 0), orders: row?.orders ?? 0 });
  }
  const items = (recentItems?.results ?? []) as Array<{ order_id: string; product_name: string; quantity: number }>;
  const resolve = resolverFor(c);
  const statusCounts = countByStatus(statuses);

  return ok(c, {
    range: { days, since: start.toISOString(), until: end.toISOString() },
    currency,
    totals: {
      users: first<Count>(users).n ?? 0,
      newUsers: first<Count>(newUsers).n ?? 0,
      products: first<Count>(products).n ?? 0,
      publishedProducts: first<Count>(published).n ?? 0,
      orders: first<Count>(orders).n ?? 0,
      ordersInRange: first<Count>(ordersInRange).n ?? 0,
      subscribers: first<Count>(subscribers).n ?? 0,
    },
    revenue: {
      gross: toRupees(range.total ?? 0),
      refunded: toRupees(refunded.total ?? 0),
      net: toRupees((range.total ?? 0) - (refunded.total ?? 0)),
      changePercent: change(range.total ?? 0, before.total ?? 0),
      averageOrderValue: range.n ? toRupees(Math.round(range.total / range.n)) : 0,
      ordersChangePercent: change(range.n ?? 0, before.n ?? 0),
    },
    payments: {
      successful: first<Sum>(paid).n ?? 0,
      successfulAmount: toRupees(first<Sum>(paid).total ?? 0),
      pending: first<Sum>(pending).n ?? 0,
      pendingAmount: toRupees(first<Sum>(pending).total ?? 0),
      failed: first<Sum>(failed).n ?? 0,
      failedAmount: toRupees(first<Sum>(failed).total ?? 0),
      refunded: refunded.n ?? 0,
      refundCount: refunded.n ?? 0,
      refundAmount: toRupees(refunded.total ?? 0),
      pendingRefunds: first<Sum>(pendingRefunds).n ?? 0,
      pendingRefundAmount: toRupees(first<Sum>(pendingRefunds).total ?? 0),
    },
    fulfilment: {
      statusCounts,
      awaitingFulfilment: statusCounts.PENDING + statusCounts.CONFIRMED + statusCounts.PAID + statusCounts.PROCESSING,
      packed: statusCounts.PACKED,
      inTransit: statusCounts.SHIPPED + statusCounts.OUT_FOR_DELIVERY,
      delivered: statusCounts.DELIVERED,
      cancelled: statusCounts.CANCELLED,
      returnRequested: statusCounts.RETURN_REQUESTED,
      returned: statusCounts.RETURNED,
      refundPending: statusCounts.REFUND_PENDING,
      refunded: statusCounts.REFUNDED,
    },
    alerts: {
      lowStock: first<Count>(lowStock).n ?? 0,
      outOfStock: first<Count>(outOfStock).n ?? 0,
      pendingReviews: 0,
      newContactSubmissions: first<Count>(enquiries).n ?? 0,
      pendingRefunds: first<Sum>(pendingRefunds).n ?? 0,
      returnRequests: statusCounts.RETURN_REQUESTED,
    },
    chart: series,
    recentOrders: (
      (recent?.results ?? []) as Array<{
        id: string;
        order_number: string;
        shipping_email: string;
        status: string;
        payment_status: string;
        payment_method: string;
        currency: string;
        total_paise: number;
        created_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      email: row.shipping_email,
      status: row.status,
      paymentStatus: row.payment_status,
      paymentMethod: row.payment_method,
      currency: row.currency,
      total: toRupees(row.total_paise),
      placedAt: toIso(row.created_at),
      items: items.filter((item) => item.order_id === row.id).map((item) => ({ name: item.product_name, quantity: item.quantity })),
    })),
    recentRegistrations: ((registrations?.results ?? []) as Array<{ id: string; name: string | null; first_name: string | null; last_name: string | null; email: string; created_at: string }>).map(
      (row) => ({
        id: row.id,
        name: [row.first_name, row.last_name].filter(Boolean).join(" ") || row.name || row.email,
        email: row.email,
        createdAt: toIso(row.created_at),
      }),
    ),
    recentNotifications: [],
    trendingProducts: ((trending?.results ?? []) as Array<{ slug: string; name: string; price_paise: number; price_usd_cents: number | null; image_url: string | null }>).map((row) => ({
      slug: row.slug,
      name: row.name,
      price: toRupees(row.price_paise),
      priceUsd: row.price_usd_cents === null ? null : toRupees(row.price_usd_cents),
      primaryImage: row.image_url ? { url: resolve(row.image_url) } : null,
    })),
    topProducts: ((top?.results ?? []) as Array<{ product_id: string; name: string; units: number; revenue: number }>).map((row) => ({
      productId: row.product_id,
      name: row.name,
      unitsSold: row.units,
      revenue: toRupees(row.revenue),
    })),
  });
});

/** Sidebar badges: order counts per status, plus stock, refund and enquiry alerts. */
adminDashboardRoutes.get("/order-stats", can("dashboard.view"), async (c) => {
  const db = c.env.DB;
  const [statuses, lowStock, refunds, enquiries] = await db.batch([
    db.prepare(`SELECT status, COUNT(*) AS n FROM orders GROUP BY status`),
    db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE p.status = 'PUBLISHED' AND (p.stock = 0 OR ${LOW_STOCK})`),
    db.prepare(`SELECT COUNT(*) AS n FROM refunds WHERE status IN ('REQUESTED','FAILED')`),
    db.prepare(`SELECT COUNT(*) AS n FROM contact_submissions WHERE status = 'NEW'`),
  ]);
  const byStatus = countByStatus(statuses);
  const counts: Record<string, number> = { ...byStatus };
  counts.total = ORDER_STATUSES.reduce((sum, status) => sum + byStatus[status], 0);
  counts.toFulfil = byStatus.PENDING + byStatus.CONFIRMED + byStatus.PAID + byStatus.PROCESSING + byStatus.PACKED;
  counts.lowStock = first<Count>(lowStock).n ?? 0;
  counts.pendingRefunds = first<Count>(refunds).n ?? 0;
  counts.pendingReviews = 0;
  counts.newContactSubmissions = first<Count>(enquiries).n ?? 0;
  return ok(c, counts);
});

/* ---------- Reports ---------- */

const reportSchema = rangeSchema.extend({
  type: z.enum(["sales", "products", "payments", "customers"]).default("sales"),
});

interface Report {
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
}

async function buildReport(db: D1Database, type: z.output<typeof reportSchema>["type"], from: string, to: string): Promise<Report> {
  if (type === "sales") {
    const { results } = await db
      .prepare(
        `SELECT date(created_at) AS day, currency, COUNT(*) AS orders,
                SUM(CASE WHEN ${BOOKED} THEN subtotal_paise ELSE 0 END) AS subtotal,
                SUM(CASE WHEN ${BOOKED} THEN discount_paise ELSE 0 END) AS discount,
                SUM(CASE WHEN ${BOOKED} THEN shipping_paise ELSE 0 END) AS shipping,
                SUM(CASE WHEN ${BOOKED} THEN tax_paise ELSE 0 END) AS tax,
                SUM(CASE WHEN ${BOOKED} THEN total_paise ELSE 0 END) AS total,
                SUM(refunded_paise) AS refunded,
                SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
                SUM(CASE WHEN status IN ('RETURN_REQUESTED','RETURNED') THEN 1 ELSE 0 END) AS returns
           FROM orders WHERE created_at >= ? AND created_at <= ? GROUP BY day, currency ORDER BY day, currency`,
      )
      .bind(from, to)
      .all<Record<string, number | string>>();
    return {
      columns: ["day", "currency", "orders", "subtotal", "discount", "shipping", "tax", "total", "refunded", "net", "cancelled", "returns"],
      rows: results.map((row) => ({
        day: row.day as string,
        currency: row.currency as string,
        orders: Number(row.orders),
        subtotal: toRupees(Number(row.subtotal)),
        discount: toRupees(Number(row.discount)),
        shipping: toRupees(Number(row.shipping)),
        tax: toRupees(Number(row.tax)),
        total: toRupees(Number(row.total)),
        refunded: toRupees(Number(row.refunded)),
        net: toRupees(Number(row.total) - Number(row.refunded)),
        cancelled: Number(row.cancelled),
        returns: Number(row.returns),
      })),
    };
  }
  if (type === "products") {
    const { results } = await db
      .prepare(
        `SELECT oi.product_id, MAX(oi.product_name) AS name, COALESCE(oi.sku, '') AS sku, o.currency, SUM(oi.quantity) AS units, SUM(oi.line_total_paise) AS revenue,
                COUNT(DISTINCT oi.order_id) AS orders
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.${BOOKED} AND o.created_at >= ? AND o.created_at <= ?
          GROUP BY oi.product_id, oi.sku, o.currency ORDER BY units DESC LIMIT 1000`,
      )
      .bind(from, to)
      .all<{ product_id: string; name: string; sku: string; currency: string; units: number; revenue: number; orders: number }>();
    return {
      columns: ["product", "sku", "currency", "units", "orders", "revenue"],
      rows: results.map((row) => ({ product: row.name, sku: row.sku, currency: row.currency, units: row.units, orders: row.orders, revenue: toRupees(row.revenue) })),
    };
  }
  if (type === "payments") {
    const { results } = await db
      .prepare(
        `SELECT p.provider, COALESCE(p.method, p.provider) AS method, p.status, p.currency, COUNT(*) AS n, SUM(p.amount_paise) AS amount, SUM(p.amount_refunded_paise) AS refunded
           FROM payments p WHERE p.created_at >= ? AND p.created_at <= ?
          GROUP BY p.provider, method, p.status, p.currency ORDER BY p.provider, method, p.status, p.currency`,
      )
      .bind(from, to)
      .all<{ provider: string; method: string; status: string; currency: string; n: number; amount: number; refunded: number }>();
    return {
      columns: ["provider", "method", "status", "currency", "count", "amount", "refunded"],
      rows: results.map((row) => ({
        provider: row.provider,
        method: row.method,
        status: row.status,
        currency: row.currency,
        count: row.n,
        amount: toRupees(row.amount),
        refunded: toRupees(row.refunded),
      })),
    };
  }
  const { results } = await db
    .prepare(
      `SELECT u.email, COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.name) AS name, u.created_at,
              COUNT(o.id) AS orders,
              COALESCE(SUM(CASE WHEN o.${BOOKED} AND o.currency = 'INR' THEN o.total_paise ELSE 0 END), 0) AS spent,
              COALESCE(SUM(CASE WHEN o.${BOOKED} AND o.currency = 'USD' THEN o.total_paise ELSE 0 END), 0) AS spent_usd
         FROM users u LEFT JOIN orders o ON o.user_id = u.id AND o.created_at >= ? AND o.created_at <= ?
        WHERE u.role = 'CUSTOMER' AND u.deleted_at IS NULL
        GROUP BY u.id HAVING orders > 0 OR (u.created_at >= ? AND u.created_at <= ?)
        ORDER BY spent DESC, spent_usd DESC LIMIT 5000`,
    )
    .bind(from, to, from, to)
    .all<{ email: string; name: string; created_at: string; orders: number; spent: number; spent_usd: number }>();
  return {
    columns: ["name", "email", "registered", "orders", "spentInr", "spentUsd"],
    rows: results.map((row) => ({
      name: row.name,
      email: row.email,
      registered: toIso(row.created_at),
      orders: row.orders,
      spentInr: toRupees(row.spent),
      spentUsd: toRupees(row.spent_usd),
    })),
  };
}

export const adminReportRoutes = new Hono<AppEnv>();

adminReportRoutes.get("/", can("reports.view"), async (c) => {
  const input = query(c, reportSchema);
  const { start, end } = resolveRange(input);
  const report = await buildReport(c.env.DB, input.type, sqlTime(start), sqlTime(end));
  return ok(c, report.rows, { type: input.type, columns: report.columns, from: start.toISOString(), to: end.toISOString() });
});

adminReportRoutes.get("/export", can("reports.export"), async (c) => {
  const input = query(c, reportSchema);
  const { start, end } = resolveRange(input);
  const report = await buildReport(c.env.DB, input.type, sqlTime(start), sqlTime(end));
  await c.env.DB.batch([auditStatement(c, { action: "report.export", entityType: "report", metadata: { type: input.type, rows: report.rows.length } })]);
  return csv(c, `${input.type}-${start.toISOString().slice(0, 10)}-${end.toISOString().slice(0, 10)}.csv`, report.rows, report.columns);
});

export const adminInventoryRoutes = new Hono<AppEnv>();

adminInventoryRoutes.get("/", can("inventory.view"), async (c) => {
  const input = query(
    c,
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      q: z.string().trim().max(120).optional(),
      stock: z.enum(["in", "low", "out"]).optional(),
      status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(),
    }),
  );
  const where: string[] = [];
  const binds: unknown[] = [];
  if (input.status) {
    where.push("p.status = ?");
    binds.push(input.status);
  } else where.push("p.status <> 'ARCHIVED'");
  if (input.stock === "out") where.push("p.stock = 0");
  if (input.stock === "low") where.push(LOW_STOCK);
  if (input.stock === "in") where.push("p.stock > COALESCE(p.low_stock_threshold, 6)");
  if (input.q) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.slug LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.sku LIKE ? ESCAPE '\\'))");
    binds.push(...Array(3).fill(likePattern(input.q)));
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const db = c.env.DB;
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT p.id, p.slug, p.name, p.status, p.stock, COALESCE(p.low_stock_threshold, 6) AS threshold, p.sold_count, p.updated_at
           FROM products p ${clause} ORDER BY p.stock ASC, p.name COLLATE NOCASE LIMIT ? OFFSET ?`,
      )
      .bind(...binds, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM products p ${clause}`).bind(...binds),
  ]);
  const products = (rows?.results ?? []) as Array<{ id: string; slug: string; name: string; status: string; stock: number; threshold: number; sold_count: number; updated_at: string }>;
  const variants = products.length
    ? (
        await db
          .prepare(
            `SELECT v.id, v.product_id, v.sku, v.stock, v.is_active, c.name AS color, s.name AS size FROM product_variants v
               LEFT JOIN taxonomy_terms c ON c.id = v.color_id LEFT JOIN taxonomy_terms s ON s.id = v.size_id
              WHERE v.product_id IN (${products.map(() => "?").join(",")}) ORDER BY v.sort_order, v.rowid`,
          )
          .bind(...products.map((row) => row.id))
          .all<{ id: string; product_id: string; sku: string; stock: number; is_active: number; color: string | null; size: string | null }>()
      ).results
    : [];
  return paginated(
    c,
    products.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      stock: row.stock,
      lowStockThreshold: row.threshold,
      stockState: row.stock === 0 ? "out" : row.stock <= row.threshold ? "low" : "in",
      soldCount: row.sold_count,
      updatedAt: toIso(row.updated_at),
      variants: variants
        .filter((variant) => variant.product_id === row.id)
        .map((variant) => ({ id: variant.id, sku: variant.sku, stock: variant.stock, isActive: variant.is_active === 1, color: variant.color, size: variant.size })),
    })),
    Number((total?.results[0] as Count)?.n ?? 0),
    input.page,
    input.limit,
  );
});

adminInventoryRoutes.get("/movements", can("inventory.view"), async (c) => {
  const input = query(c, z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) }));
  const db = c.env.DB;
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT m.*, p.name AS product_name, p.slug AS product_slug, v.sku, u.name AS actor_name FROM inventory_movements m
           LEFT JOIN products p ON p.id = m.product_id LEFT JOIN product_variants v ON v.id = m.variant_id LEFT JOIN users u ON u.id = m.actor_id
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT ? OFFSET ?`,
      )
      .bind(input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM inventory_movements`),
  ]);
  return paginated(
    c,
    ((rows?.results ?? []) as Array<Record<string, string | number | null>>).map((row) => ({
      id: row.id,
      productId: row.product_id,
      productName: row.product_name,
      productSlug: row.product_slug,
      variantId: row.variant_id,
      sku: row.sku,
      delta: row.delta,
      reason: row.reason,
      referenceId: row.reference_id,
      note: row.note,
      actor: row.actor_name ?? null,
      createdAt: toIso(row.created_at),
    })),
    Number((total?.results[0] as Count)?.n ?? 0),
    input.page,
    input.limit,
  );
});
