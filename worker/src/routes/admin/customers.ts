import { Hono } from "hono";
import { z } from "zod";
import { revokeAllStatement } from "../../auth/sessions";
import { auditStatement } from "../../lib/audit";
import { conflict, notFound } from "../../lib/errors";
import { csv, ok, paginated } from "../../lib/http";
import { likePattern, toIso, toRupees } from "../../lib/util";
import { body, query } from "../../lib/validation";
import { can } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import { addressDto } from "../auth";

interface CustomerRow {
  id: string;
  email: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  active: number;
  deleted_at: string | null;
  accepts_marketing: number | null;
  created_at: string;
  last_login_at: string | null;
  order_count: number;
  wishlist_count: number;
  lifetime_spend_paise: number;
}

/** Spend excludes cancelled orders; COD orders count once placed. */
const SELECT = `
  SELECT u.id, u.email, u.name, u.first_name, u.last_name, u.phone, u.active, u.deleted_at, u.accepts_marketing, u.created_at, u.last_login_at,
         (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
         (SELECT COUNT(*) FROM wishlist_items w WHERE w.user_id = u.id) AS wishlist_count,
         (SELECT COALESCE(SUM(o.total_paise), 0) FROM orders o WHERE o.user_id = u.id AND o.status <> 'CANCELLED') AS lifetime_spend_paise
    FROM users u`;

const SORT = {
  newest: "u.created_at DESC, u.rowid DESC",
  oldest: "u.created_at ASC, u.rowid ASC",
  name: "u.name COLLATE NOCASE ASC",
  spend: "lifetime_spend_paise DESC, u.created_at DESC",
} as const;

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(120).optional(),
  status: z.enum(["ACTIVE", "BLOCKED", "DELETED"]).optional(),
  sort: z.enum(Object.keys(SORT) as [keyof typeof SORT, ...Array<keyof typeof SORT>]).default("newest"),
});

function filters(input: Pick<z.output<typeof listSchema>, "q" | "status">) {
  const where = ["u.role = 'CUSTOMER'"];
  const binds: unknown[] = [];
  if (input.status === "DELETED") where.push("u.deleted_at IS NOT NULL");
  else {
    where.push("u.deleted_at IS NULL");
    if (input.status === "ACTIVE") where.push("u.active = 1");
    if (input.status === "BLOCKED") where.push("u.active = 0");
  }
  if (input.q) {
    where.push("(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\')");
    binds.push(...Array(3).fill(likePattern(input.q)));
  }
  return { clause: `WHERE ${where.join(" AND ")}`, binds };
}

function status(row: Pick<CustomerRow, "active" | "deleted_at">) {
  return row.deleted_at ? "DELETED" : row.active === 1 ? "ACTIVE" : "BLOCKED";
}

function names(row: Pick<CustomerRow, "name" | "first_name" | "last_name">) {
  const [first = "", ...rest] = row.name.split(" ");
  return { firstName: row.first_name ?? first, lastName: row.last_name ?? rest.join(" ") };
}

function rowDto(row: CustomerRow) {
  return {
    id: row.id,
    email: row.email,
    ...names(row),
    name: row.name,
    phone: row.phone,
    status: status(row),
    emailVerified: false,
    acceptsMarketing: row.accepts_marketing === 1,
    createdAt: toIso(row.created_at),
    lastLoginAt: toIso(row.last_login_at),
    orderCount: row.order_count,
    reviewCount: 0,
    wishlistCount: row.wishlist_count,
    lifetimeSpend: toRupees(row.lifetime_spend_paise),
  };
}

export const adminCustomerRoutes = new Hono<AppEnv>();

adminCustomerRoutes.get("/", can("customers.view"), async (c) => {
  const input = query(c, listSchema);
  const { clause, binds } = filters(input);
  const db = c.env.DB;
  const [rows, total] = await db.batch([
    db.prepare(`${SELECT} ${clause} ORDER BY ${SORT[input.sort]} LIMIT ? OFFSET ?`).bind(...binds, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM users u ${clause}`).bind(...binds),
  ]);
  return paginated(
    c,
    ((rows?.results ?? []) as unknown as CustomerRow[]).map(rowDto),
    Number((total?.results[0] as { n: number })?.n ?? 0),
    input.page,
    input.limit,
  );
});

adminCustomerRoutes.get("/export/csv", can("customers.export"), async (c) => {
  const input = query(c, listSchema.pick({ q: true, status: true }));
  const { clause, binds } = filters(input);
  const { results } = await c.env.DB.prepare(`${SELECT} ${clause} ORDER BY u.created_at DESC LIMIT 10000`).bind(...binds).all<CustomerRow>();
  await c.env.DB.batch([auditStatement(c, { action: "customer.export", entityType: "customer", metadata: { rows: results.length } })]);
  return csv(
    c,
    `customers-${new Date().toISOString().slice(0, 10)}.csv`,
    results.map(rowDto),
    ["email", "firstName", "lastName", "phone", "status", "acceptsMarketing", "createdAt", "lastLoginAt", "orderCount", "lifetimeSpend"],
  );
});

adminCustomerRoutes.get("/:id", can("customers.view"), async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const [customers, addresses, orders, items, wishlist] = await db.batch([
    db.prepare(`${SELECT} WHERE u.id = ? AND u.role = 'CUSTOMER'`).bind(id),
    db.prepare(`SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC`).bind(id),
    db.prepare(`SELECT id, order_number, status, payment_status, total_paise, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).bind(id),
    db.prepare(`SELECT oi.order_id, oi.product_name, oi.quantity FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ? ORDER BY oi.rowid`).bind(id),
    db.prepare(`SELECT w.product_id, p.slug, p.name FROM wishlist_items w JOIN products p ON p.id = w.product_id WHERE w.user_id = ? ORDER BY w.created_at DESC`).bind(id),
  ]);
  const row = customers?.results[0] as CustomerRow | undefined;
  if (!row) throw notFound("Customer");
  const orderRows = (orders?.results ?? []) as Array<{ id: string; order_number: string; status: string; payment_status: string; total_paise: number; created_at: string }>;
  const itemRows = (items?.results ?? []) as Array<{ order_id: string; product_name: string; quantity: number }>;
  const counted = orderRows.filter((order) => order.status !== "CANCELLED");
  const paid = orderRows.filter((order) => order.payment_status === "PAID");
  return ok(c, {
    ...rowDto(row),
    addresses: ((addresses?.results ?? []) as Parameters<typeof addressDto>[0][]).map(addressDto),
    orders: orderRows.map((order) => ({
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      total: toRupees(order.total_paise),
      placedAt: toIso(order.created_at),
      items: itemRows.filter((item) => item.order_id === order.id).map((item) => ({ name: item.product_name, quantity: item.quantity })),
    })),
    reviews: [],
    wishlistItems: ((wishlist?.results ?? []) as Array<{ product_id: string; slug: string; name: string }>).map((entry) => ({
      id: entry.product_id,
      product: { slug: entry.slug, name: entry.name },
    })),
    stats: {
      lifetimeSpend: toRupees(row.lifetime_spend_paise),
      paidOrders: paid.length,
      averageOrderValue: counted.length ? toRupees(Math.round(row.lifetime_spend_paise / counted.length)) : 0,
    },
  });
});

adminCustomerRoutes.post("/:id/block", can("customers.block"), async (c) => {
  const input = await body(c, z.object({ blocked: z.boolean() }));
  const db = c.env.DB;
  const id = c.req.param("id");
  const row = await db.prepare(`SELECT id, active, deleted_at FROM users WHERE id = ? AND role = 'CUSTOMER'`).bind(id).first<{ id: string; active: number; deleted_at: string | null }>();
  if (!row) throw notFound("Customer");
  if (row.deleted_at) throw conflict("CUSTOMER_DELETED", "This account has been deleted.");
  const statements = [
    db.prepare(`UPDATE users SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(input.blocked ? 0 : 1, id),
    auditStatement(c, { action: input.blocked ? "customer.block" : "customer.unblock", entityType: "customer", targetId: id }),
  ];
  if (input.blocked) statements.push(revokeAllStatement(db, id));
  await db.batch(statements);
  return ok(c, { id, status: input.blocked ? "BLOCKED" : "ACTIVE" });
});

/**
 * Erases personal data but keeps the user row, because orders and the audit
 * trail reference it. Order shipping snapshots are retained for accounting.
 */
adminCustomerRoutes.delete("/:id", can("customers.delete"), async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const row = await db.prepare(`SELECT id, deleted_at FROM users WHERE id = ? AND role = 'CUSTOMER'`).bind(id).first<{ id: string; deleted_at: string | null }>();
  if (!row) throw notFound("Customer");
  if (row.deleted_at) return ok(c, { id, status: "DELETED" });
  await db.batch([
    db
      .prepare(
        `UPDATE users SET email = ?, name = 'Deleted customer', first_name = NULL, last_name = NULL, phone = NULL, active = 0,
                password_hash = 'disabled', password_salt = 'disabled', accepts_marketing = 0, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
      .bind(`deleted+${id}@deleted.invalid`, id),
    db.prepare(`DELETE FROM addresses WHERE user_id = ?`).bind(id),
    db.prepare(`DELETE FROM cart_items WHERE user_id = ?`).bind(id),
    db.prepare(`DELETE FROM wishlist_items WHERE user_id = ?`).bind(id),
    revokeAllStatement(db, id),
    auditStatement(c, { action: "customer.delete", entityType: "customer", targetId: id }),
  ]);
  return ok(c, { id, status: "DELETED" });
});
