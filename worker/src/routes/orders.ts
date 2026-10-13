import { Hono } from "hono";
import { z } from "zod";
import { createOrder, CUSTOMER_CANCELLABLE, loadOrder, orderDto, transitionOrder, type OrderItemRow, type OrderRow } from "../commerce/orders";
import { notFound } from "../lib/errors";
import { created, ok, paginated } from "../lib/http";
import { body, email, phone, query } from "../lib/validation";
import { currentUser, requireCustomer } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import type { AppEnv } from "../types";
import { resolverFor } from "./catalog";

const shippingAddress = z.object({
  fullName: z.string().trim().min(2, "Please enter your full name.").max(120),
  email,
  phone,
  line1: z.string().trim().min(4, "Please enter your address.").max(200),
  line2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().min(2, "Please enter your city.").max(80),
  state: z.string().trim().min(2, "Please enter your state.").max(80),
  postalCode: z.string().trim().regex(/^[0-9]{6}$/, "Please enter a valid 6-digit PIN code."),
  country: z.string().trim().max(80).default("India"),
});

const createSchema = z.object({
  address: shippingAddress,
  shippingMethod: z.enum(["standard", "express"]).default("standard"),
  paymentMethod: z.enum(["UPI", "CARD", "NETBANKING", "WALLET", "COD"]),
  customerNote: z.string().trim().max(1000).optional(),
});

export const orderRoutes = new Hono<AppEnv>();

orderRoutes.post("/track", rateLimit({ name: "order-track", limit: 10, windowSeconds: 600 }), async (c) => {
  const input = await body(c, z.object({ orderNumber: z.string().trim().toUpperCase().regex(/^PSH-\d{6}$/, "Order numbers look like PSH-104287."), email }));
  const row = await c.env.DB.prepare(`SELECT id, order_number, status, created_at, updated_at FROM orders WHERE order_number = ? AND shipping_email = ? COLLATE NOCASE`)
    .bind(input.orderNumber, input.email)
    .first<{ id: string }>();
  if (!row) throw notFound("Order");
  const { order, items } = await loadOrder(c.env.DB, row.id);
  const dto = orderDto(order, items, resolverFor(c));
  return ok(c, { orderNumber: dto.orderNumber, status: dto.status, placedAt: dto.placedAt, items: dto.items.map(({ name, quantity }) => ({ name, quantity })), trackingNumber: dto.trackingNumber, carrier: dto.carrier });
});

orderRoutes.use("*", requireCustomer);

orderRoutes.post("/", rateLimit({ name: "order-create", limit: 10, windowSeconds: 600, key: (c) => c.get("auth")?.userId ?? c.get("clientIp") }), async (c) => {
  const input = await body(c, createSchema);
  const idempotencyKey = c.req.header("idempotency-key")?.trim();
  const { orderId, replayed } = await createOrder(c, {
    ...input,
    idempotencyKey: idempotencyKey && /^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey) ? idempotencyKey : undefined,
  });
  const { order, items, history } = await loadOrder(c.env.DB, orderId, currentUser(c).userId);
  const dto = orderDto(order, items, resolverFor(c), history);
  return replayed ? ok(c, dto, { replayed: true }) : created(c, dto);
});

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
    ? ((await db.prepare(`SELECT * FROM order_items WHERE order_id IN (${rows.map(() => "?").join(",")}) ORDER BY rowid`).bind(...rows.map((row) => row.id)).all<OrderItemRow>()).results)
    : [];
  const resolve = resolverFor(c);
  return paginated(
    c,
    rows.map((row) => orderDto(row, items.filter((item) => item.order_id === row.id), resolve)),
    Number((total?.results[0] as { n: number })?.n ?? 0),
    input.page,
    input.limit,
  );
});

orderRoutes.get("/:id", async (c) => {
  const { order, items, history } = await loadOrder(c.env.DB, c.req.param("id"), currentUser(c).userId);
  return ok(c, orderDto(order, items, resolverFor(c), history));
});

orderRoutes.post("/:id/cancel", rateLimit({ name: "order-cancel", limit: 10, windowSeconds: 600, key: (c) => c.get("auth")?.userId ?? c.get("clientIp") }), async (c) => {
  const input = await body(c, z.object({ reason: z.string().trim().max(500).optional() }));
  const auth = currentUser(c);
  const { order } = await loadOrder(c.env.DB, c.req.param("id"), auth.userId);
  await transitionOrder(c, order, "CANCELLED", { note: input.reason ? `Cancelled by customer: ${input.reason}` : "Cancelled by customer", actorId: auth.userId, allowed: CUSTOMER_CANCELLABLE.includes(order.status) ? ["CANCELLED"] : [] });
  const fresh = await loadOrder(c.env.DB, order.id, auth.userId);
  return ok(c, orderDto(fresh.order, fresh.items, resolverFor(c), fresh.history));
});
