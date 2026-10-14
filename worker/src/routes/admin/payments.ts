import { Hono } from "hono";
import { z } from "zod";
import { orderActor } from "../../commerce/orders";
import { auditStatement } from "../../lib/audit";
import { csv, paginated } from "../../lib/http";
import { likePattern, toIso, toRupees } from "../../lib/util";
import { CURRENCIES } from "../../commerce/currency";
import { body, query } from "../../lib/validation";
import { can } from "../../middleware/auth";
import { processRefund, rejectRefund, type PaymentRow, type RefundRow } from "../../payments/service";
import { ok } from "../../lib/http";
import type { AppEnv } from "../../types";
import { paymentDto, refundDto } from "./orders";

const PAYMENT_STATUSES = ["CREATED", "AUTHORIZED", "CAPTURED", "FAILED", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED"] as const;
const REFUND_STATUSES = ["REQUESTED", "PROCESSING", "COMPLETED", "REJECTED", "FAILED"] as const;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(120).optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  method: z.string().trim().max(40).optional(),
  provider: z.enum(["razorpay", "cod", "manual"]).optional(),
  currency: z.enum(CURRENCIES).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});

function filters(input: Omit<z.output<typeof listSchema>, "page" | "limit">) {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (input.status) {
    where.push("p.status = ?");
    binds.push(input.status);
  }
  if (input.method) {
    where.push("LOWER(COALESCE(p.method, p.provider)) = LOWER(?)");
    binds.push(input.method);
  }
  if (input.provider) {
    where.push("p.provider = ?");
    binds.push(input.provider);
  }
  if (input.currency) {
    where.push("p.currency = ?");
    binds.push(input.currency);
  }
  if (input.q) {
    where.push("(o.order_number LIKE ? ESCAPE '\\' OR o.shipping_email LIKE ? ESCAPE '\\' OR p.provider_payment_id LIKE ? ESCAPE '\\' OR p.provider_order_id LIKE ? ESCAPE '\\')");
    binds.push(...Array(4).fill(likePattern(input.q)));
  }
  if (input.from) {
    where.push("p.created_at >= ?");
    binds.push(`${input.from} 00:00:00`);
  }
  if (input.to) {
    where.push("p.created_at <= ?");
    binds.push(`${input.to} 23:59:59`);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

type PaymentListRow = PaymentRow & {
  order_number: string;
  shipping_email: string;
  order_status: string;
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  user_name: string | null;
};

const PAYMENT_SELECT = `SELECT p.*, o.order_number, o.shipping_email, o.status AS order_status, o.user_id, u.first_name, u.last_name, u.name AS user_name
  FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = o.user_id`;

function nameParts(row: { first_name: string | null; last_name: string | null; user_name: string | null }) {
  const [first = "", ...rest] = (row.user_name ?? "").split(" ");
  return { firstName: row.first_name ?? first, lastName: row.last_name ?? rest.join(" ") };
}

export const adminPaymentRoutes = new Hono<AppEnv>();

adminPaymentRoutes.get("/", can("payments.view"), async (c) => {
  const input = query(c, listSchema);
  const { clause, binds } = filters(input);
  const db = c.env.DB;
  const [rows, total, byStatus] = await db.batch([
    db.prepare(`${PAYMENT_SELECT} ${clause} ORDER BY p.created_at DESC, p.rowid DESC LIMIT ? OFFSET ?`).bind(...binds, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM payments p JOIN orders o ON o.id = p.order_id ${clause}`).bind(...binds),
    db
      .prepare(
        `SELECT p.status, p.currency, COUNT(*) AS count, COALESCE(SUM(p.amount_paise), 0) AS amount FROM payments p JOIN orders o ON o.id = p.order_id ${clause}
          GROUP BY p.status, p.currency`,
      )
      .bind(...binds),
  ]);
  const payments = (rows?.results ?? []) as unknown as PaymentListRow[];
  const refunds = payments.length
    ? (await db.prepare(`SELECT * FROM refunds WHERE payment_id IN (${payments.map(() => "?").join(",")}) ORDER BY created_at`).bind(...payments.map((row) => row.id)).all<RefundRow>()).results
    : [];
  return paginated(
    c,
    payments.map((row) => ({
      ...paymentDto(row),
      order: { id: row.order_id, orderNumber: row.order_number, email: row.shipping_email, status: row.order_status, user: { id: row.user_id, ...nameParts(row) } },
      refunds: refunds.filter((refund) => refund.payment_id === row.id).map((refund) => refundDto(refund, row.currency)),
    })),
    Number((total?.results[0] as { n: number })?.n ?? 0),
    input.page,
    input.limit,
    {
      /** One entry per status and currency: amounts in different currencies are never added together. */
      byStatus: ((byStatus?.results ?? []) as Array<{ status: string; currency: string; count: number; amount: number }>).map((entry) => ({
        status: entry.status,
        currency: entry.currency,
        count: entry.count,
        amount: toRupees(entry.amount),
      })),
    },
  );
});

adminPaymentRoutes.get("/export/csv", can("payments.export"), async (c) => {
  const input = query(c, listSchema.omit({ page: true, limit: true }));
  const { clause, binds } = filters(input);
  const { results } = await c.env.DB.prepare(`${PAYMENT_SELECT} ${clause} ORDER BY p.created_at DESC LIMIT 5000`).bind(...binds).all<PaymentListRow>();
  await c.env.DB.batch([auditStatement(c, { action: "payment.export", entityType: "payment", metadata: { rows: results.length, filters: input } })]);
  return csv(
    c,
    `payments-${new Date().toISOString().slice(0, 10)}.csv`,
    results.map((row) => ({
      createdAt: toIso(row.created_at),
      orderNumber: row.order_number,
      email: row.shipping_email,
      provider: row.provider,
      method: row.method ?? "",
      status: row.status,
      currency: row.currency,
      amount: toRupees(row.amount_paise),
      refunded: toRupees(row.amount_refunded_paise),
      providerOrderId: row.provider_order_id ?? "",
      providerPaymentId: row.provider_payment_id ?? "",
      capturedAt: toIso(row.captured_at) ?? "",
      failureReason: row.failure_reason ?? "",
    })),
    ["createdAt", "orderNumber", "email", "provider", "method", "status", "currency", "amount", "refunded", "providerOrderId", "providerPaymentId", "capturedAt", "failureReason"],
  );
});

/* ---------- Refunds ---------- */

type RefundListRow = RefundRow & {
  order_number: string;
  shipping_email: string;
  order_status: string;
  requested_by_name: string | null;
  requested_first: string | null;
  requested_last: string | null;
  processed_by_name: string | null;
};

adminPaymentRoutes.get("/refunds/all", can("refunds.view"), async (c) => {
  const input = query(
    c,
    z.object({
      status: z.enum(REFUND_STATUSES).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  );
  const db = c.env.DB;
  const where = input.status ? `WHERE r.status = ?` : "";
  const binds = input.status ? [input.status] : [];
  const [rows, total, pending] = await db.batch([
    db
      .prepare(
        `SELECT r.*, o.order_number, o.shipping_email, o.status AS order_status, o.currency AS order_currency,
                rq.name AS requested_by_name, rq.first_name AS requested_first, rq.last_name AS requested_last, pr.name AS processed_by_name
           FROM refunds r JOIN orders o ON o.id = r.order_id
           LEFT JOIN users rq ON rq.id = r.requested_by LEFT JOIN users pr ON pr.id = r.processed_by
           ${where} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM refunds r ${where}`).bind(...binds),
    db.prepare(`SELECT COUNT(*) AS n FROM refunds WHERE status IN ('REQUESTED','FAILED')`),
  ]);
  return paginated(
    c,
    ((rows?.results ?? []) as unknown as RefundListRow[]).map((row) => {
      const [first = "", ...rest] = (row.requested_by_name ?? "").split(" ");
      return {
        ...refundDto(row),
        order: { id: row.order_id, orderNumber: row.order_number, email: row.shipping_email, status: row.order_status },
        requestedBy: row.requested_by ? { id: row.requested_by, firstName: row.requested_first ?? first, lastName: row.requested_last ?? rest.join(" ") } : null,
      };
    }),
    Number((total?.results[0] as { n: number })?.n ?? 0),
    input.page,
    input.limit,
    { pendingCount: Number((pending?.results[0] as { n: number })?.n ?? 0) },
  );
});

async function refundWithCurrency(db: D1Database, refundId: string) {
  const row = await db
    .prepare(`SELECT r.*, o.currency AS order_currency FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.id = ?`)
    .bind(refundId)
    .first<RefundRow & { order_currency: string }>();
  return refundDto(row!);
}

adminPaymentRoutes.post("/refunds/:id/approve", can("refunds.approve"), async (c) => {
  const refund = await processRefund(orderActor(c), c.req.param("id"));
  return ok(c, await refundWithCurrency(c.env.DB, refund.id));
});

adminPaymentRoutes.post("/refunds/:id/reject", can("refunds.reject"), async (c) => {
  const input = await body(c, z.object({ reason: z.string().trim().min(3, "Give a reason.").max(500) }));
  await rejectRefund(orderActor(c), c.req.param("id"), input.reason);
  return ok(c, await refundWithCurrency(c.env.DB, c.req.param("id")));
});

/** Recent webhook deliveries, for diagnosing payment issues. */
adminPaymentRoutes.get("/events", can("payments.view"), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, provider, event, provider_order_id, provider_payment_id, provider_refund_id, status, error, received_at, processed_at FROM payment_events ORDER BY received_at DESC LIMIT 100`,
  ).all();
  return ok(c, results);
});
