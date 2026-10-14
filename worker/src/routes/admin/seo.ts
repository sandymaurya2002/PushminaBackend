import { Hono } from "hono";
import { z } from "zod";
import { readProductDetails } from "../../catalog/model";
import { normalizePath, redirectDto, seoDto, type RedirectRow, type SeoRow } from "../../content/site";
import { auditStatement } from "../../lib/audit";
import { conflict, isUniqueViolation, notFound, validationError } from "../../lib/errors";
import { noContent, ok, created } from "../../lib/http";
import { newId } from "../../lib/util";
import { body, query } from "../../lib/validation";
import { can } from "../../middleware/auth";
import type { AppEnv } from "../../types";

const sitePath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => /^\/[^\s?#]*$/.test(value), "Use a path that starts with / (no query string).")
  .transform(normalizePath);
const blankToNull = (value: unknown) => (value === "" ? null : value);

const entrySchema = z.object({
  id: z.string().max(64).optional(),
  entityType: z.enum(["PAGE", "PRODUCT", "COLLECTION", "CATEGORY", "BLOG", "OTHER"]).default("PAGE"),
  entityId: z.preprocess(blankToNull, z.string().max(64).nullable().optional()),
  path: sitePath,
  title: z.preprocess(blankToNull, z.string().trim().max(120).nullable().optional()),
  description: z.preprocess(blankToNull, z.string().trim().max(320).nullable().optional()),
  keywords: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  canonicalUrl: z.preprocess(blankToNull, z.string().trim().url().max(500).nullable().optional()),
  ogImageUrl: z.preprocess(blankToNull, z.string().trim().max(500).refine((value) => /^(https:\/\/|\/)/.test(value), "Use an https:// URL or a /path.").nullable().optional()),
  robotsIndex: z.boolean().default(true),
  robotsFollow: z.boolean().default(true),
});

export const adminSeoRoutes = new Hono<AppEnv>();

adminSeoRoutes.get("/", can("seo.view"), async (c) => {
  const { limit } = query(c, z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }));
  const { results } = await c.env.DB.prepare(`SELECT * FROM seo_entries ORDER BY updated_at DESC LIMIT ?`).bind(limit).all<SeoRow>();
  return ok(c, results.map(seoDto));
});

/** Creates or replaces the override for a path. */
adminSeoRoutes.put("/", can("seo.update"), async (c) => {
  const input = await body(c, entrySchema);
  const existing = input.id
    ? await c.env.DB.prepare(`SELECT * FROM seo_entries WHERE id = ?`).bind(input.id).first<SeoRow>()
    : await c.env.DB.prepare(`SELECT * FROM seo_entries WHERE path = ?`).bind(input.path).first<SeoRow>();
  const entryId = existing?.id ?? newId();
  const values = [
    input.entityType,
    input.entityId ?? null,
    input.path,
    input.title ?? null,
    input.description ?? null,
    JSON.stringify(input.keywords),
    input.canonicalUrl ?? null,
    input.ogImageUrl ?? null,
    input.robotsIndex ? 1 : 0,
    input.robotsFollow ? 1 : 0,
    c.get("auth")!.userId,
  ];
  try {
    await c.env.DB.batch([
      existing
        ? c.env.DB.prepare(
            `UPDATE seo_entries SET entity_type = ?, entity_id = ?, path = ?, title = ?, description = ?, keywords_json = ?, canonical_url = ?, og_image_url = ?,
                    robots_index = ?, robots_follow = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          ).bind(...values, entryId)
        : c.env.DB.prepare(
            `INSERT INTO seo_entries (entity_type, entity_id, path, title, description, keywords_json, canonical_url, og_image_url, robots_index, robots_follow, updated_by, id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(...values, entryId),
      auditStatement(c, { action: existing ? "seo.update" : "seo.create", entityType: "seo", targetId: entryId, metadata: { path: input.path } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("PATH_TAKEN", "Another override already uses that path.", { path: "Already has an override." });
    throw error;
  }
  const row = await c.env.DB.prepare(`SELECT * FROM seo_entries WHERE id = ?`).bind(entryId).first<SeoRow>();
  return ok(c, seoDto(row!));
});

adminSeoRoutes.delete("/:id", can("seo.update"), async (c) => {
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM seo_entries WHERE id = ?`).bind(c.req.param("id")),
    auditStatement(c, { action: "seo.delete", entityType: "seo", targetId: c.req.param("id") }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) throw notFound("SEO entry");
  return noContent(c);
});

adminSeoRoutes.get("/audit", can("seo.view"), async (c) => {
  const db = c.env.DB;
  const [products, noImages, noAlt, seoPaths, duplicates] = await db.batch([
    db.prepare(`SELECT id, slug, name, product_json FROM products WHERE status = 'PUBLISHED'`),
    db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE p.status = 'PUBLISHED' AND NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id)`),
    db.prepare(`SELECT COUNT(*) AS n FROM product_images i JOIN products p ON p.id = i.product_id WHERE p.status = 'PUBLISHED' AND TRIM(i.alt) = ''`),
    db.prepare(`SELECT path FROM seo_entries WHERE path LIKE '/products/%'`),
    db.prepare(`SELECT title, COUNT(*) AS count FROM seo_entries WHERE title IS NOT NULL AND title <> '' GROUP BY title COLLATE NOCASE HAVING COUNT(*) > 1`),
  ]);
  const published = (products?.results ?? []) as Array<{ id: string; slug: string; name: string; product_json: string }>;
  const customised = new Set(((seoPaths?.results ?? []) as Array<{ path: string }>).map((row) => row.path));
  return ok(c, {
    issues: {
      productsWithoutImages: Number((noImages?.results[0] as { n: number })?.n ?? 0),
      imagesWithoutAltText: Number((noAlt?.results[0] as { n: number })?.n ?? 0),
      productsWithoutDescription: published
        .filter((product) => !readProductDetails(product.product_json).description.trim())
        .map(({ id, slug, name }) => ({ id, slug, name })),
      productsWithoutCustomSeo: published.filter((product) => !customised.has(`/products/${product.slug}`)).length,
      duplicateTitles: (duplicates?.results ?? []) as Array<{ title: string; count: number }>,
    },
  });
});

/* ---------- Redirects ---------- */

adminSeoRoutes.get("/redirects", can("seo.view"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM redirects ORDER BY created_at DESC`).all<RedirectRow>();
  return ok(c, results.map(redirectDto));
});

const redirectSchema = z.object({
  fromPath: sitePath,
  toPath: z
    .string()
    .trim()
    .max(500)
    .refine((value) => /^\/[^\s]*$/.test(value) || /^https:\/\/[^\s]+$/.test(value), "Use a /path or an https:// URL."),
  statusCode: z.coerce.number().refine((value) => [301, 302, 307, 308].includes(value), "Choose 301, 302, 307 or 308.").default(301),
  isActive: z.boolean().default(true),
});

async function assertNoLoop(db: D1Database, fromPath: string, toPath: string, ignoreId?: string) {
  if (!toPath.startsWith("/")) return;
  const target = normalizePath(toPath);
  if (target === fromPath) throw validationError({ toPath: "A page cannot redirect to itself." });
  const { results } = await db.prepare(`SELECT id, from_path, to_path FROM redirects WHERE is_active = 1`).all<{ id: string; from_path: string; to_path: string }>();
  const map = new Map(results.filter((row) => row.id !== ignoreId).map((row) => [row.from_path, row.to_path]));
  map.set(fromPath, toPath);
  let cursor: string | undefined = target;
  for (let hops = 0; cursor && hops < 20; hops += 1) {
    if (cursor === fromPath) throw validationError({ toPath: "This would create a redirect loop." });
    const next = map.get(cursor);
    cursor = next && next.startsWith("/") ? normalizePath(next) : undefined;
  }
}

adminSeoRoutes.post("/redirects", can("seo.update"), async (c) => {
  const input = await body(c, redirectSchema);
  await assertNoLoop(c.env.DB, input.fromPath, input.toPath);
  const redirectId = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO redirects (id, from_path, to_path, status_code, is_active) VALUES (?, ?, ?, ?, ?)`).bind(
        redirectId,
        input.fromPath,
        input.toPath,
        input.statusCode,
        input.isActive ? 1 : 0,
      ),
      auditStatement(c, { action: "redirect.create", entityType: "redirect", targetId: redirectId, metadata: input }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("REDIRECT_EXISTS", "That path already redirects somewhere.", { fromPath: "Already redirected." });
    throw error;
  }
  const row = await c.env.DB.prepare(`SELECT * FROM redirects WHERE id = ?`).bind(redirectId).first<RedirectRow>();
  return created(c, redirectDto(row!));
});

adminSeoRoutes.patch("/redirects/:id", can("seo.update"), async (c) => {
  const existing = await c.env.DB.prepare(`SELECT * FROM redirects WHERE id = ?`).bind(c.req.param("id")).first<RedirectRow>();
  if (!existing) throw notFound("Redirect");
  const input = await body(c, redirectSchema.partial());
  const next = {
    fromPath: input.fromPath ?? existing.from_path,
    toPath: input.toPath ?? existing.to_path,
    statusCode: input.statusCode ?? existing.status_code,
    isActive: input.isActive ?? existing.is_active === 1,
  };
  if (next.isActive) await assertNoLoop(c.env.DB, next.fromPath, next.toPath, existing.id);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE redirects SET from_path = ?, to_path = ?, status_code = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(
      next.fromPath,
      next.toPath,
      next.statusCode,
      next.isActive ? 1 : 0,
      existing.id,
    ),
    auditStatement(c, { action: "redirect.update", entityType: "redirect", targetId: existing.id, metadata: next }),
  ]);
  const row = await c.env.DB.prepare(`SELECT * FROM redirects WHERE id = ?`).bind(existing.id).first<RedirectRow>();
  return ok(c, redirectDto(row!));
});

adminSeoRoutes.delete("/redirects/:id", can("seo.update"), async (c) => {
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM redirects WHERE id = ?`).bind(c.req.param("id")),
    auditStatement(c, { action: "redirect.delete", entityType: "redirect", targetId: c.req.param("id") }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) throw notFound("Redirect");
  return noContent(c);
});
