import { Hono, type Context } from "hono";
import { z } from "zod";
import { readProductDetails } from "../../catalog/model";
import { auditStatement } from "../../lib/audit";
import { conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { created, noContent, ok } from "../../lib/http";
import { newId, slugify, toIso } from "../../lib/util";
import { body, slug } from "../../lib/validation";
import { can } from "../../middleware/auth";
import type { AppEnv } from "../../types";

const KINDS = { colors: "color", sizes: "size", materials: "material", patterns: "pattern" } as const;
type KindPath = keyof typeof KINDS;

const termSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(80),
  slug: slug.optional(),
  hex: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #c9a96e.").nullable().optional(),
  measurement: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().optional(),
});

const categorySchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  slug: slug.optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  gender: z.enum(["WOMEN", "MEN", "UNISEX"]).nullable().optional(),
  imageUrl: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().optional(),
});

interface TermRow {
  id: string;
  kind: string;
  slug: string;
  name: string;
  hex: string | null;
  measurement: string | null;
  sort_order: number;
  is_active: number;
  created_at: string;
}

/** How many products reference each taxonomy id (explicit lists, material/pattern, or variants). */
async function usageCounts(db: D1Database): Promise<Map<string, number>> {
  const [products, variants] = await db.batch([
    db.prepare(`SELECT id, product_json, category_id FROM products`),
    db.prepare(`SELECT product_id, color_id, size_id FROM product_variants`),
  ]);
  const usage = new Map<string, Set<string>>();
  const add = (termId: string | null | undefined, productId: string) => {
    if (!termId) return;
    if (!usage.has(termId)) usage.set(termId, new Set());
    usage.get(termId)!.add(productId);
  };
  for (const row of (products?.results ?? []) as Array<{ id: string; product_json: string; category_id: string | null }>) {
    const details = readProductDetails(row.product_json);
    [...details.colorIds, ...details.sizeIds, details.materialId, details.patternId, row.category_id].forEach((termId) => add(termId, row.id));
  }
  for (const row of (variants?.results ?? []) as Array<{ product_id: string; color_id: string | null; size_id: string | null }>) {
    add(row.color_id, row.product_id);
    add(row.size_id, row.product_id);
  }
  return new Map([...usage.entries()].map(([key, value]) => [key, value.size]));
}

function termDto(row: TermRow, usage: Map<string, number>) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    ...(row.kind === "color" ? { hex: row.hex ?? "#d8c7ae" } : {}),
    ...(row.kind === "size" ? { measurement: row.measurement } : {}),
    ...(row.kind === "material" || row.kind === "pattern" ? { description: row.measurement } : {}),
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
    createdAt: toIso(row.created_at),
    _count: { products: usage.get(row.id) ?? 0 },
  };
}

interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  gender: string | null;
  image_url: string | null;
  sort_order: number;
  is_active: number;
  created_at: string;
}

function categoryDto(row: CategoryRow, usage: Map<string, number>) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description || null,
    gender: row.gender,
    imageUrl: row.image_url,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
    createdAt: toIso(row.created_at),
    _count: { products: usage.get(row.id) ?? 0 },
  };
}

function slugConflict(error: unknown): never {
  if (isUniqueViolation(error)) throw conflict("SLUG_TAKEN", "That slug is already in use.", { slug: "Already in use." });
  throw error;
}

export const adminTaxonomyRoutes = new Hono<AppEnv>();

/* Categories (registered before the :kind routes so the literal path wins) */

adminTaxonomyRoutes.get("/categories", can("categories.view"), async (c) => {
  const db = c.env.DB;
  const [{ results }, usage] = await Promise.all([db.prepare(`SELECT * FROM categories ORDER BY sort_order, name`).all<CategoryRow>(), usageCounts(db)]);
  return ok(c, results.map((row) => categoryDto(row, usage)));
});

adminTaxonomyRoutes.post("/categories", can("categories.create"), async (c) => {
  const input = await body(c, categorySchema);
  const db = c.env.DB;
  const categoryId = newId();
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO categories (id, slug, name, description, gender, image_url, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(categoryId, input.slug ?? slugify(input.name), input.name, input.description ?? "", input.gender ?? null, input.imageUrl ?? null, input.sortOrder ?? 0, input.isActive === false ? 0 : 1),
      auditStatement(c, { action: "category.create", entityType: "category", targetId: categoryId, metadata: { name: input.name } }),
    ]);
  } catch (error) {
    slugConflict(error);
  }
  const row = await db.prepare(`SELECT * FROM categories WHERE id = ?`).bind(categoryId).first<CategoryRow>();
  return created(c, categoryDto(row!, new Map()));
});

adminTaxonomyRoutes.patch("/categories/:id", can("categories.update"), async (c) => {
  const input = await body(c, categorySchema.partial());
  const db = c.env.DB;
  const row = await db.prepare(`SELECT * FROM categories WHERE id = ?`).bind(c.req.param("id")).first<CategoryRow>();
  if (!row) throw notFound("Category");
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE categories SET slug = ?, name = ?, description = ?, gender = ?, image_url = ?, sort_order = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        )
        .bind(
          input.slug ?? row.slug,
          input.name ?? row.name,
          input.description === undefined ? row.description : input.description ?? "",
          input.gender === undefined ? row.gender : input.gender,
          input.imageUrl === undefined ? row.image_url : input.imageUrl,
          input.sortOrder ?? row.sort_order,
          input.isActive === undefined ? row.is_active : input.isActive ? 1 : 0,
          row.id,
        ),
      auditStatement(c, { action: "category.update", entityType: "category", targetId: row.id, metadata: input }),
    ]);
  } catch (error) {
    slugConflict(error);
  }
  const updated = await db.prepare(`SELECT * FROM categories WHERE id = ?`).bind(row.id).first<CategoryRow>();
  return ok(c, categoryDto(updated!, await usageCounts(db)));
});

adminTaxonomyRoutes.delete("/categories/:id", can("categories.delete"), async (c) => {
  const db = c.env.DB;
  const row = await db.prepare(`SELECT * FROM categories WHERE id = ?`).bind(c.req.param("id")).first<CategoryRow>();
  if (!row) throw notFound("Category");
  const used = (await usageCounts(db)).get(row.id) ?? 0;
  if (used > 0) throw conflict("IN_USE", `${row.name} is used by ${used} product(s). Deactivate it instead.`);
  await db.batch([
    db.prepare(`DELETE FROM categories WHERE id = ?`).bind(row.id),
    auditStatement(c, { action: "category.delete", entityType: "category", targetId: row.id, metadata: { name: row.name } }),
  ]);
  return noContent(c);
});

/* Colours, sizes, materials, patterns */

function kindOf(c: Context<AppEnv>): (typeof KINDS)[KindPath] {
  const kind = KINDS[c.req.param("kind") as KindPath];
  if (!kind) throw notFound("Taxonomy");
  return kind;
}

adminTaxonomyRoutes.get("/:kind", can("taxonomy.view"), async (c) => {
  const kind = kindOf(c);
  const db = c.env.DB;
  const [{ results }, usage] = await Promise.all([
    db.prepare(`SELECT * FROM taxonomy_terms WHERE kind = ? ORDER BY sort_order, name`).bind(kind).all<TermRow>(),
    usageCounts(db),
  ]);
  return ok(c, results.map((row) => termDto(row, usage)));
});

adminTaxonomyRoutes.post("/:kind", can("taxonomy.create"), async (c) => {
  const kind = kindOf(c);
  const input = await body(c, termSchema);
  if (kind === "color" && !input.hex) input.hex = "#d8c7ae";
  const db = c.env.DB;
  const termId = newId();
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO taxonomy_terms (id, kind, slug, name, hex, measurement, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          termId,
          kind,
          input.slug ?? slugify(input.name),
          input.name,
          kind === "color" ? input.hex : null,
          kind === "size" ? input.measurement ?? null : kind === "material" || kind === "pattern" ? input.description ?? null : null,
          input.sortOrder ?? 0,
          input.isActive === false ? 0 : 1,
        ),
      auditStatement(c, { action: `taxonomy.${kind}.create`, entityType: kind, targetId: termId, metadata: { name: input.name } }),
    ]);
  } catch (error) {
    slugConflict(error);
  }
  const row = await db.prepare(`SELECT * FROM taxonomy_terms WHERE id = ?`).bind(termId).first<TermRow>();
  return created(c, termDto(row!, new Map()));
});

adminTaxonomyRoutes.patch("/:kind/:id", can("taxonomy.update"), async (c) => {
  const kind = kindOf(c);
  const input = await body(c, termSchema.partial());
  const db = c.env.DB;
  const row = await db.prepare(`SELECT * FROM taxonomy_terms WHERE id = ? AND kind = ?`).bind(c.req.param("id"), kind).first<TermRow>();
  if (!row) throw notFound("Taxonomy term");
  const detail = kind === "size" ? input.measurement : kind === "material" || kind === "pattern" ? input.description : undefined;
  try {
    await db.batch([
      db
        .prepare(`UPDATE taxonomy_terms SET slug = ?, name = ?, hex = ?, measurement = ?, sort_order = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(
          input.slug ?? row.slug,
          input.name ?? row.name,
          kind === "color" ? input.hex ?? row.hex : null,
          detail === undefined ? row.measurement : detail,
          input.sortOrder ?? row.sort_order,
          input.isActive === undefined ? row.is_active : input.isActive ? 1 : 0,
          row.id,
        ),
      auditStatement(c, { action: `taxonomy.${kind}.update`, entityType: kind, targetId: row.id, metadata: input }),
    ]);
  } catch (error) {
    slugConflict(error);
  }
  const updated = await db.prepare(`SELECT * FROM taxonomy_terms WHERE id = ?`).bind(row.id).first<TermRow>();
  return ok(c, termDto(updated!, await usageCounts(db)));
});

adminTaxonomyRoutes.delete("/:kind/:id", can("taxonomy.delete"), async (c) => {
  const kind = kindOf(c);
  const db = c.env.DB;
  const row = await db.prepare(`SELECT * FROM taxonomy_terms WHERE id = ? AND kind = ?`).bind(c.req.param("id"), kind).first<TermRow>();
  if (!row) throw notFound("Taxonomy term");
  const used = (await usageCounts(db)).get(row.id) ?? 0;
  if (used > 0) throw conflict("IN_USE", `${row.name} is used by ${used} product(s). Deactivate it instead.`);
  await db.batch([
    db.prepare(`DELETE FROM taxonomy_terms WHERE id = ?`).bind(row.id),
    auditStatement(c, { action: `taxonomy.${kind}.delete`, entityType: kind, targetId: row.id, metadata: { name: row.name } }),
  ]);
  return noContent(c);
});
