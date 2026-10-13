import { Hono } from "hono";
import { z } from "zod";
import { ORDER_STATUSES } from "../../commerce/orders";
import { ok, paginated } from "../../lib/http";
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

export const adminDashboardRoutes = new Hono<AppEnv>();

adminDashboardRoutes.get("/", can("dashboard.view"), async (c) => {
  const { days } = query(c, z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }));
  const db = c.env.DB;
  const since = new Date(Date.now() - days * 86_400_000);
  const sinceSql = since.toISOString().slice(0, 19).replace("T", " ");
  const previousSql = new Date(since.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const live = `status <> 'CANCELLED'`;

  const [users, newUsers, products, published, orders, ordersInRange, revenue, previous, paid, unpaid, refunded, lowStock, outOfStock, chart, recent, recentItems, trending, top] =
    await db.batch([
      db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'CUSTOMER' AND deleted_at IS NULL`),
      db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'CUSTOMER' AND deleted_at IS NULL AND created_at >= ?`).bind(sinceSql),
      db.prepare(`SELECT COUNT(*) AS n FROM products WHERE status <> 'ARCHIVED'`),
      db.prepare(`SELECT COUNT(*) AS n FROM products WHERE status = 'PUBLISHED'`),
      db.prepare(`SELECT COUNT(*) AS n FROM orders`),
      db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?`).bind(sinceSql),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total FROM orders WHERE ${live} AND created_at >= ?`).bind(sinceSql),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total FROM orders WHERE ${live} AND created_at >= ? AND created_at < ?`).bind(previousSql, sinceSql),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total FROM orders WHERE payment_status = 'PAID' AND created_at >= ?`).bind(sinceSql),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total FROM orders WHERE payment_status = 'UNPAID' AND ${live} AND created_at >= ?`).bind(sinceSql),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total FROM orders WHERE payment_status = 'REFUNDED' AND created_at >= ?`).bind(sinceSql),
      db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE p.status = 'PUBLISHED' AND ${LOW_STOCK}`),
      db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE p.status = 'PUBLISHED' AND p.stock = 0`),
      db
        .prepare(`SELECT date(created_at) AS day, COUNT(*) AS orders, COALESCE(SUM(total_paise), 0) AS revenue FROM orders WHERE ${live} AND created_at >= ? GROUP BY day ORDER BY day`)
        .bind(sinceSql),
      db.prepare(`SELECT id, order_number, shipping_email, status, total_paise, created_at FROM orders ORDER BY created_at DESC, rowid DESC LIMIT 8`),
      db.prepare(
        `SELECT oi.order_id, oi.product_name, oi.quantity FROM order_items oi
          WHERE oi.order_id IN (SELECT id FROM orders ORDER BY created_at DESC, rowid DESC LIMIT 8) ORDER BY oi.rowid`,
      ),
      db.prepare(
        `SELECT p.slug, p.name, p.price_paise,
                (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY i.is_primary DESC, i.sort_order LIMIT 1) AS image_url
           FROM products p WHERE p.status = 'PUBLISHED'
          ORDER BY json_extract(p.product_json, '$.trendingOrder') IS NULL, json_extract(p.product_json, '$.trendingOrder'), p.popularity DESC, p.sold_count DESC
          LIMIT 6`,
      ),
      db
        .prepare(
          `SELECT oi.product_id, MAX(oi.product_name) AS name, SUM(oi.quantity) AS units, SUM(oi.line_total_paise) AS revenue
             FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.status <> 'CANCELLED' AND o.created_at >= ?
            GROUP BY oi.product_id ORDER BY units DESC, revenue DESC LIMIT 5`,
        )
        .bind(sinceSql),
    ]);

  const range = first<Sum>(revenue);
  const before = first<Sum>(previous);
  const byDay = new Map(((chart?.results ?? []) as Array<{ day: string; orders: number; revenue: number }>).map((row) => [row.day, row]));
  const series: Array<{ date: string; revenue: number; orders: number }> = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const row = byDay.get(date);
    series.push({ date, revenue: toRupees(row?.revenue ?? 0), orders: row?.orders ?? 0 });
  }
  const items = (recentItems?.results ?? []) as Array<{ order_id: string; product_name: string; quantity: number }>;
  const resolve = resolverFor(c);
  const refundedTotals = first<Sum>(refunded);

  return ok(c, {
    range: { days, since: since.toISOString() },
    totals: {
      users: first<Count>(users).n ?? 0,
      newUsers: first<Count>(newUsers).n ?? 0,
      products: first<Count>(products).n ?? 0,
      publishedProducts: first<Count>(published).n ?? 0,
      orders: first<Count>(orders).n ?? 0,
      ordersInRange: first<Count>(ordersInRange).n ?? 0,
      subscribers: 0,
    },
    revenue: {
      gross: toRupees(range.total ?? 0),
      refunded: toRupees(refundedTotals.total ?? 0),
      net: toRupees((range.total ?? 0) - (refundedTotals.total ?? 0)),
      changePercent: change(range.total ?? 0, before.total ?? 0),
      averageOrderValue: range.n ? toRupees(Math.round(range.total / range.n)) : 0,
      ordersChangePercent: change(range.n ?? 0, before.n ?? 0),
    },
    payments: {
      successful: first<Sum>(paid).n ?? 0,
      pending: first<Sum>(unpaid).n ?? 0,
      pendingAmount: toRupees(first<Sum>(unpaid).total ?? 0),
      failed: 0,
      refunded: refundedTotals.n ?? 0,
      refundCount: refundedTotals.n ?? 0,
      refundAmount: toRupees(refundedTotals.total ?? 0),
    },
    alerts: {
      lowStock: first<Count>(lowStock).n ?? 0,
      outOfStock: first<Count>(outOfStock).n ?? 0,
      pendingReviews: 0,
      newContactSubmissions: 0,
    },
    chart: series,
    recentOrders: ((recent?.results ?? []) as Array<{ id: string; order_number: string; shipping_email: string; status: string; total_paise: number; created_at: string }>).map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      email: row.shipping_email,
      status: row.status,
      total: toRupees(row.total_paise),
      placedAt: toIso(row.created_at),
      items: items.filter((item) => item.order_id === row.id).map((item) => ({ name: item.product_name, quantity: item.quantity })),
    })),
    recentNotifications: [],
    trendingProducts: ((trending?.results ?? []) as Array<{ slug: string; name: string; price_paise: number; image_url: string | null }>).map((row) => ({
      slug: row.slug,
      name: row.name,
      price: toRupees(row.price_paise),
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

/** Sidebar badges: order counts per status, plus stock alerts. */
adminDashboardRoutes.get("/order-stats", can("dashboard.view"), async (c) => {
  const db = c.env.DB;
  const [statuses, lowStock] = await db.batch([
    db.prepare(`SELECT status, COUNT(*) AS n FROM orders GROUP BY status`),
    db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE p.status = 'PUBLISHED' AND (p.stock = 0 OR ${LOW_STOCK})`),
  ]);
  const counts: Record<string, number> = Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0]));
  for (const row of (statuses?.results ?? []) as Array<{ status: string; n: number }>) counts[row.status] = row.n;
  counts.total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  counts.lowStock = first<Count>(lowStock).n ?? 0;
  counts.pendingReviews = 0;
  counts.newContactSubmissions = 0;
  return ok(c, counts);
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
