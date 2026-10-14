import { Hono, type Context } from "hono";
import { z } from "zod";
import { applyCoupon, cartDto, loadCartLines, MAX_CART_LINES, MAX_LINE_QUANTITY, resolveTarget, subtotalOf, type CartLine } from "../commerce/cart";
import { evaluateCoupon, normalizeCode } from "../commerce/coupons";
import { loadCommerceRules } from "../content/settings";
import { badRequest, conflict, notFound } from "../lib/errors";
import { ok } from "../lib/http";
import { body, id } from "../lib/validation";
import { currentUser, requireCustomer } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import type { AppEnv } from "../types";
import { resolverFor } from "./catalog";

async function priced(c: Context<AppEnv>, lines?: CartLine[]) {
  const db = c.env.DB;
  const userId = currentUser(c).userId;
  const currency = c.get("currency");
  const [cartLines, rules, stored] = await Promise.all([
    lines ? Promise.resolve(lines) : loadCartLines(db, userId, currency),
    loadCommerceRules(db, currency),
    db.prepare(`SELECT code FROM cart_coupons WHERE user_id = ?`).bind(userId).first<{ code: string }>(),
  ]);
  const applied = await applyCoupon(db, stored?.code, cartLines, userId, currency);
  return { lines: cartLines, dto: cartDto(cartLines, resolverFor(c), rules, applied) };
}

async function respond(c: Context<AppEnv>, extra?: Record<string, unknown>) {
  const { dto } = await priced(c);
  return ok(c, { ...dto, ...extra });
}

/** Adds (or sets) a line after checking it is purchasable and in stock. Returns false if skipped. */
async function upsertLine(c: Context<AppEnv>, variantId: string, quantity: number, mode: "add" | "set", strict: boolean): Promise<boolean> {
  const db = c.env.DB;
  const userId = currentUser(c).userId;
  const target = await resolveTarget(db, variantId, c.get("currency"));
  if (!target || !target.purchasable) {
    if (strict) throw notFound("Product");
    return false;
  }
  if (!target.priced) {
    if (strict) throw conflict("REGION_UNAVAILABLE", "This piece is not yet available in your shopping region.");
    return false;
  }
  const existing = await db
    .prepare(`SELECT quantity FROM cart_items WHERE user_id = ? AND product_id = ? AND variant_id = ?`)
    .bind(userId, target.productId, target.variantId)
    .first<{ quantity: number }>();
  if (!existing) {
    const lines = (await db.prepare(`SELECT COUNT(*) AS n FROM cart_items WHERE user_id = ?`).bind(userId).first<{ n: number }>())?.n ?? 0;
    if (lines >= MAX_CART_LINES) {
      if (strict) throw badRequest(`Your bag can hold up to ${MAX_CART_LINES} different items.`);
      return false;
    }
  }
  const desired = Math.min(MAX_LINE_QUANTITY, mode === "add" ? (existing?.quantity ?? 0) + quantity : quantity);
  if (desired > target.stock) {
    if (strict) {
      throw conflict(
        "INSUFFICIENT_STOCK",
        target.stock > 0 ? `Only ${target.stock} left in stock.` : "This item is out of stock.",
        { quantity: target.stock > 0 ? `Only ${target.stock} available.` : "Out of stock." },
      );
    }
    if (target.stock <= 0) return false;
  }
  const quantityToStore = Math.min(desired, Math.max(target.stock, 0));
  await db
    .prepare(
      `INSERT INTO cart_items (user_id, product_id, variant_id, quantity) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, product_id, variant_id) DO UPDATE SET quantity = excluded.quantity`,
    )
    .bind(userId, target.productId, target.variantId, quantityToStore)
    .run();
  return true;
}

export const cartRoutes = new Hono<AppEnv>();
cartRoutes.use("*", requireCustomer);
const writeLimit = rateLimit({ name: "cart-write", limit: 120, windowSeconds: 60, key: (c) => c.get("auth")?.userId ?? c.get("clientIp") });

cartRoutes.get("/", (c) => respond(c));

cartRoutes.post("/items", writeLimit, async (c) => {
  const input = await body(c, z.object({ variantId: id, quantity: z.coerce.number().int().min(1).max(MAX_LINE_QUANTITY).default(1) }));
  await upsertLine(c, input.variantId, input.quantity, "add", true);
  return respond(c);
});

cartRoutes.patch("/items/:itemId", writeLimit, async (c) => {
  const input = await body(c, z.object({ quantity: z.coerce.number().int().min(0).max(MAX_LINE_QUANTITY) }));
  const itemId = c.req.param("itemId");
  const userId = currentUser(c).userId;
  if (input.quantity === 0) {
    await c.env.DB.prepare(`DELETE FROM cart_items WHERE user_id = ?2 AND (variant_id = ?1 OR (variant_id = '' AND product_id = ?1))`)
      .bind(itemId, userId)
      .run();
    return respond(c);
  }
  const target = await resolveTarget(c.env.DB, itemId);
  const inCart = target
    ? await c.env.DB.prepare(`SELECT 1 FROM cart_items WHERE user_id = ? AND product_id = ? AND variant_id = ?`).bind(userId, target.productId, target.variantId).first()
    : null;
  if (!inCart) throw notFound("Cart item");
  await upsertLine(c, itemId, input.quantity, "set", true);
  return respond(c);
});

cartRoutes.delete("/items/:itemId", writeLimit, async (c) => {
  const itemId = c.req.param("itemId");
  await c.env.DB.prepare(`DELETE FROM cart_items WHERE user_id = ?2 AND (variant_id = ?1 OR (variant_id = '' AND product_id = ?1))`)
    .bind(itemId, currentUser(c).userId)
    .run();
  return respond(c);
});

cartRoutes.delete("/", writeLimit, async (c) => {
  await c.env.DB.prepare(`DELETE FROM cart_items WHERE user_id = ?`).bind(currentUser(c).userId).run();
  return respond(c);
});

/** Merges a signed-out (browser-stored) bag into the account bag after login. */
cartRoutes.post("/merge", writeLimit, async (c) => {
  const input = await body(
    c,
    z.object({ items: z.array(z.object({ variantId: id, quantity: z.coerce.number().int().min(1).max(MAX_LINE_QUANTITY) })).max(MAX_CART_LINES) }),
  );
  const skipped: string[] = [];
  for (const item of input.items) {
    if (!(await upsertLine(c, item.variantId, item.quantity, "add", false))) skipped.push(item.variantId);
  }
  return respond(c, { skipped });
});

cartRoutes.get("/validate", async (c) => {
  const { lines, dto } = await priced(c);
  const issues = lines
    .filter((line) => line.issue)
    .map((line) => ({ itemId: line.key, productSlug: line.productSlug, issue: line.issue, available: Math.max(0, line.stock) }));
  return ok(c, { valid: lines.length > 0 && issues.length === 0, issues, ...dto });
});

cartRoutes.post("/coupon", rateLimit({ name: "coupon-apply", limit: 20, windowSeconds: 600, key: (c) => c.get("auth")?.userId ?? c.get("clientIp") }), async (c) => {
  const input = await body(c, z.object({ code: z.string().trim().min(2, "Enter a code.").max(40) }));
  const db = c.env.DB;
  const userId = currentUser(c).userId;
  const currency = c.get("currency");
  const lines = await loadCartLines(db, userId, currency);
  if (!lines.length) throw badRequest("Add something to your bag first.");
  const result = await evaluateCoupon(db, input.code, subtotalOf(lines), userId, currency);
  if (!result.ok) throw conflict(result.code, result.message, { code: result.message });
  await db
    .prepare(`INSERT INTO cart_coupons (user_id, code) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET code = excluded.code, applied_at = CURRENT_TIMESTAMP`)
    .bind(userId, normalizeCode(result.coupon.code))
    .run();
  const { dto } = await priced(c, lines);
  return ok(c, dto);
});

cartRoutes.delete("/coupon", async (c) => {
  await c.env.DB.prepare(`DELETE FROM cart_coupons WHERE user_id = ?`).bind(currentUser(c).userId).run();
  return respond(c);
});
