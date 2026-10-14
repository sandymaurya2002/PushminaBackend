import { Hono, type Context } from "hono";
import { z } from "zod";
import { loadCatalog, publicProduct, viewProduct } from "../catalog/model";
import { notFound } from "../lib/errors";
import { noContent, ok } from "../lib/http";
import { body, slug } from "../lib/validation";
import { currentUser, requireCustomer } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import type { AppEnv } from "../types";
import { resolverFor } from "./catalog";

const MAX_WISHLIST = 200;

async function slugs(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT p.slug FROM wishlist_items w JOIN products p ON p.id = w.product_id WHERE w.user_id = ? AND p.status = 'PUBLISHED' ORDER BY w.created_at DESC`)
    .bind(userId)
    .all<{ slug: string }>();
  return results.map((row) => row.slug);
}

async function productIdFor(db: D1Database, productSlug: string): Promise<string> {
  const row = await db.prepare(`SELECT id FROM products WHERE slug = ? AND status = 'PUBLISHED'`).bind(productSlug).first<{ id: string }>();
  if (!row) throw notFound("Product");
  return row.id;
}

async function add(c: Context<AppEnv>, productSlug: string) {
  const db = c.env.DB;
  const userId = currentUser(c).userId;
  const productId = await productIdFor(db, productSlug);
  await db
    .prepare(
      `INSERT INTO wishlist_items (user_id, product_id) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM wishlist_items WHERE user_id = ?1) < ?3
       ON CONFLICT(user_id, product_id) DO NOTHING`,
    )
    .bind(userId, productId, MAX_WISHLIST)
    .run();
}

export const wishlistRoutes = new Hono<AppEnv>();
wishlistRoutes.use("*", requireCustomer);
const writeLimit = rateLimit({ name: "wishlist-write", limit: 120, windowSeconds: 60, key: (c) => c.get("auth")?.userId ?? c.get("clientIp") });

wishlistRoutes.get("/", async (c) => {
  const db = c.env.DB;
  const { results } = await db
    .prepare(`SELECT w.product_id FROM wishlist_items w WHERE w.user_id = ? ORDER BY w.created_at DESC`)
    .bind(currentUser(c).userId)
    .all<{ product_id: string }>();
  const catalog = await loadCatalog(db, { productIds: results.map((row) => row.product_id), publishedOnly: true });
  const resolve = resolverFor(c);
  const byId = new Map(catalog.products.map((row) => [row.id, row]));
  return ok(
    c,
    results
      .map((row) => byId.get(row.product_id))
      .filter(Boolean)
      .map((row) => publicProduct(viewProduct(catalog, row!), catalog, resolve, "card", c.get("currency"))),
  );
});

wishlistRoutes.get("/slugs", async (c) => ok(c, await slugs(c.env.DB, currentUser(c).userId)));

wishlistRoutes.post("/", writeLimit, async (c) => {
  const input = await body(c, z.object({ slug }));
  await add(c, input.slug);
  return ok(c, { slugs: await slugs(c.env.DB, currentUser(c).userId) });
});

wishlistRoutes.post("/toggle", writeLimit, async (c) => {
  const input = await body(c, z.object({ slug }));
  const db = c.env.DB;
  const userId = currentUser(c).userId;
  const productId = await productIdFor(db, input.slug);
  const removed = await db.prepare(`DELETE FROM wishlist_items WHERE user_id = ? AND product_id = ?`).bind(userId, productId).run();
  const saved = (removed.meta.changes ?? 0) === 0;
  if (saved) await add(c, input.slug);
  return ok(c, { slug: input.slug, saved, slugs: await slugs(db, userId) });
});

wishlistRoutes.post("/merge", writeLimit, async (c) => {
  const input = await body(c, z.object({ slugs: z.array(slug).max(MAX_WISHLIST) }));
  let merged = 0;
  for (const entry of [...new Set(input.slugs)]) {
    try {
      await add(c, entry);
      merged += 1;
    } catch {
      // Unknown or unpublished products are skipped.
    }
  }
  return ok(c, { merged, slugs: await slugs(c.env.DB, currentUser(c).userId) });
});

wishlistRoutes.delete("/:slug", writeLimit, async (c) => {
  await c.env.DB.prepare(`DELETE FROM wishlist_items WHERE user_id = ? AND product_id IN (SELECT id FROM products WHERE slug = ?)`)
    .bind(currentUser(c).userId, c.req.param("slug"))
    .run();
  return noContent(c);
});

wishlistRoutes.delete("/", writeLimit, async (c) => {
  await c.env.DB.prepare(`DELETE FROM wishlist_items WHERE user_id = ?`).bind(currentUser(c).userId).run();
  return noContent(c);
});
