import { Hono } from "hono";
import { z } from "zod";
import { COLLECTION_GROUPS, readCollectionDetails, type CollectionRow } from "../../catalog/model";
import { auditStatement } from "../../lib/audit";
import { conflict, isUniqueViolation, notFound, validationError } from "../../lib/errors";
import { created, noContent, ok } from "../../lib/http";
import { likePattern, newId, slugify, toIso } from "../../lib/util";
import { body, id, query, slug } from "../../lib/validation";
import { can } from "../../middleware/auth";
import type { AppEnv } from "../../types";

const collectionSchema = z.object({
  name: z.string().trim().min(2, "Name is required.").max(120),
  slug: slug.optional().or(z.literal("").transform(() => undefined)),
  heading: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(5000).default(""),
  seoContent: z.array(z.string().trim().max(5000)).max(20).default([]),
  group: z.enum(COLLECTION_GROUPS).default("COLLECTIONS"),
  bannerUrl: z
    .string()
    .trim()
    .max(500)
    .refine((url) => url.startsWith("/media/") || /^https:\/\//.test(url), "Use an uploaded image (/media/...) or an https:// URL.")
    .nullable()
    .optional(),
  bannerAlt: z.string().trim().max(300).nullable().optional(),
  isHidden: z.boolean().default(false),
  isFeatured: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(100_000).default(0),
  includeCategoryIds: z.array(id).max(50).default([]),
  relatedCollectionIds: z.array(id).max(24).default([]),
  productIds: z.array(id).max(500).optional(),
  faqs: z.array(z.object({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(2000) })).max(30).default([]),
});
type CollectionInput = z.output<typeof collectionSchema>;

function collectionJson(input: CollectionInput) {
  return JSON.stringify({
    heading: input.heading ?? null,
    description: input.description,
    seoContent: input.seoContent.filter(Boolean),
    group: input.group,
    bannerUrl: input.bannerUrl ?? null,
    bannerAlt: input.bannerAlt ?? null,
    includeCategoryIds: [...new Set(input.includeCategoryIds)],
    relatedCollectionIds: [...new Set(input.relatedCollectionIds)],
    faqs: input.faqs,
    hidden: input.isHidden,
    featured: input.isFeatured,
  });
}

function rowDto(row: CollectionRow & { product_count?: number }) {
  const details = readCollectionDetails(row.collection_json);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    heading: details.heading,
    description: details.description,
    seoContent: details.seoContent,
    group: details.group,
    bannerUrl: details.bannerUrl,
    bannerAlt: details.bannerAlt,
    isHidden: details.hidden,
    isFeatured: details.featured,
    isActive: row.is_active === 1,
    sortOrder: row.sort_order,
    updatedAt: toIso(row.updated_at),
    _count: { products: row.product_count ?? 0 },
  };
}

async function validate(db: D1Database, input: CollectionInput, selfId?: string) {
  const unique = (values: string[]) => (values.length ? [...new Set(values)] : ["__none__"]);
  const categoryIds = unique(input.includeCategoryIds);
  const relatedIds = unique(input.relatedCollectionIds);
  const productIds = unique(input.productIds ?? []);
  const [categories, related, products] = await db.batch([
    db.prepare(`SELECT id FROM categories WHERE id IN (${categoryIds.map(() => "?").join(",")})`).bind(...categoryIds),
    db.prepare(`SELECT id FROM collections WHERE id IN (${relatedIds.map(() => "?").join(",")})`).bind(...relatedIds),
    db.prepare(`SELECT id FROM products WHERE id IN (${productIds.map(() => "?").join(",")})`).bind(...productIds),
  ]);
  const found = (result: D1Result | undefined) => new Set(((result?.results ?? []) as Array<{ id: string }>).map((row) => row.id));
  const errors: Record<string, string> = {};
  const foundCategories = found(categories);
  if (input.includeCategoryIds.some((value) => !foundCategories.has(value))) errors.includeCategoryIds = "Unknown category.";
  const foundRelated = found(related);
  if (input.relatedCollectionIds.some((value) => !foundRelated.has(value) || value === selfId)) errors.relatedCollectionIds = "Unknown collection.";
  const foundProducts = found(products);
  if ((input.productIds ?? []).some((value) => !foundProducts.has(value))) errors.productIds = "Unknown product.";
  if (Object.keys(errors).length) throw validationError(errors);
}

function membership(db: D1Database, collectionId: string, productIds: string[] | undefined): D1PreparedStatement[] {
  if (!productIds) return [];
  return [
    db.prepare(`DELETE FROM product_collections WHERE collection_id = ?`).bind(collectionId),
    ...[...new Set(productIds)].map((productId, index) =>
      db.prepare(`INSERT INTO product_collections (product_id, collection_id, sort_order) VALUES (?, ?, ?)`).bind(productId, collectionId, index),
    ),
  ];
}

export const adminCollectionRoutes = new Hono<AppEnv>();

adminCollectionRoutes.get("/", can("collections.view"), async (c) => {
  const input = query(
    c,
    z.object({
      group: z.enum(COLLECTION_GROUPS).optional(),
      q: z.string().trim().max(80).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  );
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM product_collections pc WHERE pc.collection_id = c.id) AS product_count
       FROM collections c ${input.q ? "WHERE c.name LIKE ? ESCAPE '\\'" : ""} ORDER BY c.sort_order, c.name`,
  )
    .bind(...(input.q ? [likePattern(input.q)] : []))
    .all<CollectionRow & { product_count: number }>();
  const rows = results.map(rowDto).filter((row) => !input.group || row.group === input.group);
  const start = (input.page - 1) * input.limit;
  return ok(c, rows.slice(start, start + input.limit), { total: rows.length, page: input.page, limit: input.limit });
});

adminCollectionRoutes.get("/:id", can("collections.view"), async (c) => {
  const db = c.env.DB;
  const [rows, links] = await db.batch([
    db.prepare(`SELECT * FROM collections WHERE id = ?`).bind(c.req.param("id")),
    db.prepare(`SELECT product_id FROM product_collections WHERE collection_id = ? ORDER BY sort_order`).bind(c.req.param("id")),
  ]);
  const row = rows?.results[0] as CollectionRow | undefined;
  if (!row) throw notFound("Collection");
  const details = readCollectionDetails(row.collection_json);
  const productIds = ((links?.results ?? []) as Array<{ product_id: string }>).map((link) => link.product_id);
  return ok(c, {
    ...rowDto({ ...row, product_count: productIds.length }),
    includeCategoryIds: details.includeCategoryIds,
    relatedCollectionIds: details.relatedCollectionIds,
    productIds,
    faqs: details.faqs,
  });
});

adminCollectionRoutes.post("/", can("collections.create"), async (c) => {
  const input = await body(c, collectionSchema);
  const db = c.env.DB;
  await validate(db, input);
  const collectionId = newId();
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO collections (id, slug, name, collection_json, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(collectionId, input.slug ?? slugify(input.name), input.name, collectionJson(input), input.isActive ? 1 : 0, input.sortOrder),
      ...membership(db, collectionId, input.productIds),
      auditStatement(c, { action: "collection.create", entityType: "collection", targetId: collectionId, metadata: { name: input.name } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("SLUG_TAKEN", "That slug is already in use.", { slug: "Already in use." });
    throw error;
  }
  const row = await db.prepare(`SELECT * FROM collections WHERE id = ?`).bind(collectionId).first<CollectionRow>();
  return created(c, rowDto(row!));
});

adminCollectionRoutes.put("/:id", can("collections.update"), async (c) => {
  const input = await body(c, collectionSchema);
  const db = c.env.DB;
  const existing = await db.prepare(`SELECT * FROM collections WHERE id = ?`).bind(c.req.param("id")).first<CollectionRow>();
  if (!existing) throw notFound("Collection");
  await validate(db, input, existing.id);
  try {
    await db.batch([
      db
        .prepare(`UPDATE collections SET slug = ?, name = ?, collection_json = ?, is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(input.slug ?? existing.slug, input.name, collectionJson(input), input.isActive ? 1 : 0, input.sortOrder, existing.id),
      ...membership(db, existing.id, input.productIds),
      auditStatement(c, { action: "collection.update", entityType: "collection", targetId: existing.id, metadata: { name: input.name } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("SLUG_TAKEN", "That slug is already in use.", { slug: "Already in use." });
    throw error;
  }
  const row = await db.prepare(`SELECT * FROM collections WHERE id = ?`).bind(existing.id).first<CollectionRow>();
  return ok(c, rowDto(row!));
});

adminCollectionRoutes.delete("/:id", can("collections.delete"), async (c) => {
  const db = c.env.DB;
  const existing = await db.prepare(`SELECT * FROM collections WHERE id = ?`).bind(c.req.param("id")).first<CollectionRow>();
  if (!existing) throw notFound("Collection");
  await db.batch([
    db.prepare(`DELETE FROM collections WHERE id = ?`).bind(existing.id),
    auditStatement(c, { action: "collection.delete", entityType: "collection", targetId: existing.id, metadata: { name: existing.name } }),
  ]);
  return noContent(c);
});
