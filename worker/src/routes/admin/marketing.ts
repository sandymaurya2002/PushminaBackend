import { Hono } from "hono";
import { z } from "zod";
import { adminCouponDto, type CouponRow } from "../../commerce/coupons";
import { auditStatement } from "../../lib/audit";
import { conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { created, csv, noContent, ok, paginated } from "../../lib/http";
import { likePattern, newId, toIso, toPaise } from "../../lib/util";
import { body, query } from "../../lib/validation";
import { can } from "../../middleware/auth";
import type { AppEnv } from "../../types";

/* ---------- Coupons ---------- */

const dateOrNull = z.preprocess(
  (value) => (value === "" ? null : value),
  z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date.")
    .nullable()
    .optional(),
);
const positiveOrNull = z.preprocess((value) => (value === "" || value === 0 ? null : value), z.coerce.number().positive().nullable().optional());

const couponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{3,30}$/, "Use 3–30 letters, digits, - or _."),
    label: z.string().trim().max(80).default(""),
    description: z.string().trim().max(300).nullable().optional(),
    type: z.enum(["PERCENT", "FIXED"]),
    value: z.coerce.number().int("Whole numbers only.").positive(),
    minimumSubtotal: positiveOrNull,
    maxDiscount: positiveOrNull,
    usageLimit: z.preprocess((value) => (value === "" || value === 0 ? null : value), z.coerce.number().int().positive().nullable().optional()),
    perUserLimit: z.preprocess((value) => (value === "" || value === 0 ? null : value), z.coerce.number().int().positive().nullable().optional()),
    startsAt: dateOrNull,
    endsAt: dateOrNull,
    isActive: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.type === "PERCENT" && value.value > 90) ctx.addIssue({ code: "custom", path: ["value"], message: "Percentage discounts go up to 90%." });
    if (value.startsAt && value.endsAt && value.endsAt < value.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end must be after the start." });
  });

function couponValues(input: z.output<typeof couponSchema>) {
  return [
    input.code,
    input.label || input.code,
    input.description ?? null,
    input.type,
    input.value,
    input.minimumSubtotal ? toPaise(input.minimumSubtotal) : null,
    input.maxDiscount ? toPaise(input.maxDiscount) : null,
    input.usageLimit ?? null,
    input.perUserLimit ?? null,
    input.startsAt ?? null,
    input.endsAt ?? null,
    input.isActive ? 1 : 0,
  ];
}

export const adminCouponRoutes = new Hono<AppEnv>();

adminCouponRoutes.get("/", can("discounts.view"), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id = c.id) AS redemptions FROM coupons c ORDER BY c.created_at DESC`,
  ).all<CouponRow & { redemptions: number }>();
  return ok(c, results.map(adminCouponDto));
});

adminCouponRoutes.post("/", can("discounts.create"), async (c) => {
  const input = await body(c, couponSchema);
  const couponId = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO coupons (code, label, description, type, value, minimum_subtotal_paise, max_discount_paise, usage_limit, per_user_limit, starts_at, ends_at, is_active, id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(...couponValues(input), couponId),
      auditStatement(c, { action: "coupon.create", entityType: "coupon", targetId: couponId, metadata: { code: input.code, type: input.type, value: input.value } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("CODE_TAKEN", "That code already exists.", { code: "Already in use." });
    throw error;
  }
  const row = await c.env.DB.prepare(`SELECT * FROM coupons WHERE id = ?`).bind(couponId).first<CouponRow>();
  return created(c, adminCouponDto(row!));
});

adminCouponRoutes.patch("/:id", can("discounts.update"), async (c) => {
  const input = await body(c, couponSchema);
  const existing = await c.env.DB.prepare(`SELECT * FROM coupons WHERE id = ?`).bind(c.req.param("id")).first<CouponRow>();
  if (!existing) throw notFound("Coupon");
  if (input.usageLimit && input.usageLimit < existing.used_count) {
    throw conflict("LIMIT_BELOW_USAGE", `This code has already been used ${existing.used_count} times.`, { usageLimit: `At least ${existing.used_count}.` });
  }
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE coupons SET code = ?, label = ?, description = ?, type = ?, value = ?, minimum_subtotal_paise = ?, max_discount_paise = ?, usage_limit = ?, per_user_limit = ?,
                starts_at = ?, ends_at = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).bind(...couponValues(input), existing.id),
      auditStatement(c, { action: "coupon.update", entityType: "coupon", targetId: existing.id, metadata: { code: input.code } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("CODE_TAKEN", "That code already exists.", { code: "Already in use." });
    throw error;
  }
  const row = await c.env.DB.prepare(`SELECT * FROM coupons WHERE id = ?`).bind(existing.id).first<CouponRow>();
  return ok(c, adminCouponDto(row!));
});

/** A code that has been used is deactivated rather than deleted, so past orders keep their record. */
adminCouponRoutes.delete("/:id", can("discounts.delete"), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT * FROM coupons WHERE id = ?`).bind(c.req.param("id")).first<CouponRow>();
  if (!existing) throw notFound("Coupon");
  const used = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ?`).bind(existing.id).first<{ n: number }>();
  await c.env.DB.batch([
    (used?.n ?? 0) > 0
      ? c.env.DB.prepare(`UPDATE coupons SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(existing.id)
      : c.env.DB.prepare(`DELETE FROM coupons WHERE id = ?`).bind(existing.id),
    c.env.DB.prepare(`DELETE FROM cart_coupons WHERE code = ? COLLATE NOCASE`).bind(existing.code),
    auditStatement(c, { action: (used?.n ?? 0) > 0 ? "coupon.deactivate" : "coupon.delete", entityType: "coupon", targetId: existing.id, metadata: { code: existing.code } }),
  ]);
  return noContent(c);
});

/* ---------- Contact enquiries ---------- */

interface ContactRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  subject: string;
  order_number: string | null;
  message: string;
  status: string;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

const contactDto = (row: ContactRow) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  subject: row.subject,
  orderNumber: row.order_number,
  message: row.message,
  status: row.status,
  adminNotes: row.admin_notes,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

export const adminContactRoutes = new Hono<AppEnv>();

adminContactRoutes.get("/", can("contact.view"), async (c) => {
  const input = query(
    c,
    z.object({
      status: z.enum(["NEW", "READ", "REPLIED", "CLOSED"]).optional(),
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
  );
  const where: string[] = [];
  const binds: unknown[] = [];
  if (input.status) {
    where.push("status = ?");
    binds.push(input.status);
  }
  if (input.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\')");
    binds.push(...Array(3).fill(likePattern(input.q)));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = c.env.DB;
  const [rows, total, unread] = await db.batch([
    db.prepare(`SELECT * FROM contact_submissions ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...binds, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM contact_submissions ${clause}`).bind(...binds),
    db.prepare(`SELECT COUNT(*) AS n FROM contact_submissions WHERE status = 'NEW'`),
  ]);
  return paginated(
    c,
    ((rows?.results ?? []) as unknown as ContactRow[]).map(contactDto),
    Number((total?.results[0] as { n: number })?.n ?? 0),
    input.page,
    input.limit,
    { unread: Number((unread?.results[0] as { n: number })?.n ?? 0) },
  );
});

adminContactRoutes.patch("/:id", can("contact.update"), async (c) => {
  const input = await body(c, z.object({ status: z.enum(["NEW", "READ", "REPLIED", "CLOSED"]).optional(), adminNotes: z.string().trim().max(4000).nullable().optional() }));
  const existing = await c.env.DB.prepare(`SELECT * FROM contact_submissions WHERE id = ?`).bind(c.req.param("id")).first<ContactRow>();
  if (!existing) throw notFound("Enquiry");
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE contact_submissions SET status = ?, admin_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(
      input.status ?? existing.status,
      input.adminNotes === undefined ? existing.admin_notes : input.adminNotes,
      existing.id,
    ),
    auditStatement(c, { action: "contact.update", entityType: "contact", targetId: existing.id, metadata: { status: input.status } }),
  ]);
  const row = await c.env.DB.prepare(`SELECT * FROM contact_submissions WHERE id = ?`).bind(existing.id).first<ContactRow>();
  return ok(c, contactDto(row!));
});

/* ---------- Newsletter ---------- */

interface SubscriberRow {
  id: string;
  email: string;
  status: string;
  source: string | null;
  subscribed_at: string;
  unsubscribed_at: string | null;
}

const subscriberDto = (row: SubscriberRow) => ({
  id: row.id,
  email: row.email,
  status: row.status,
  source: row.source,
  subscribedAt: toIso(row.subscribed_at),
  unsubscribedAt: toIso(row.unsubscribed_at),
});

export const adminNewsletterRoutes = new Hono<AppEnv>();

const newsletterQuery = z.object({
  status: z.enum(["SUBSCRIBED", "UNSUBSCRIBED"]).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function newsletterWhere(input: { status?: string; q?: string }) {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (input.status) {
    where.push("status = ?");
    binds.push(input.status);
  }
  if (input.q) {
    where.push("email LIKE ? ESCAPE '\\'");
    binds.push(likePattern(input.q));
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

adminNewsletterRoutes.get("/", can("newsletter.view"), async (c) => {
  const input = query(c, newsletterQuery);
  const { clause, binds } = newsletterWhere(input);
  const db = c.env.DB;
  const [rows, total, active] = await db.batch([
    db.prepare(`SELECT * FROM newsletter_subscribers ${clause} ORDER BY subscribed_at DESC LIMIT ? OFFSET ?`).bind(...binds, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM newsletter_subscribers ${clause}`).bind(...binds),
    db.prepare(`SELECT COUNT(*) AS n FROM newsletter_subscribers WHERE status = 'SUBSCRIBED'`),
  ]);
  return paginated(c, ((rows?.results ?? []) as unknown as SubscriberRow[]).map(subscriberDto), Number((total?.results[0] as { n: number })?.n ?? 0), input.page, input.limit, {
    activeCount: Number((active?.results[0] as { n: number })?.n ?? 0),
  });
});

adminNewsletterRoutes.get("/export/:format{csv}?", can("newsletter.export"), async (c) => {
  const input = query(c, newsletterQuery.omit({ page: true, limit: true }));
  const { clause, binds } = newsletterWhere(input);
  const { results } = await c.env.DB.prepare(`SELECT * FROM newsletter_subscribers ${clause} ORDER BY subscribed_at DESC LIMIT 20000`).bind(...binds).all<SubscriberRow>();
  await c.env.DB.batch([auditStatement(c, { action: "newsletter.export", entityType: "newsletter", metadata: { rows: results.length } })]);
  return csv(
    c,
    `newsletter-${new Date().toISOString().slice(0, 10)}.csv`,
    results.map((row) => ({ email: row.email, status: row.status, source: row.source ?? "", subscribedAt: toIso(row.subscribed_at), unsubscribedAt: toIso(row.unsubscribed_at) ?? "" })),
    ["email", "status", "source", "subscribedAt", "unsubscribedAt"],
  );
});
