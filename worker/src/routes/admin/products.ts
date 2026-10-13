import { Hono, type Context } from "hono";
import { z } from "zod";
import { hasPermission } from "../../auth/permissions";
import { adminProduct, adminProductRow, BADGES, GENDERS, loadCatalog, readProductDetails, viewProduct, type ProductView, type VariantRow } from "../../catalog/model";
import { matchesSearch, sortViews } from "../../catalog/query";
import { auditStatement } from "../../lib/audit";
import { badRequest, conflict, forbidden, isStockViolation, isUniqueViolation, notFound, validationError } from "../../lib/errors";
import { created, ok, paginated } from "../../lib/http";
import { asRecord, newId, nowIso, parseJson, slugify, toPaise } from "../../lib/util";
import { body, id, money, query } from "../../lib/validation";
import { can, currentUser } from "../../middleware/auth";
import type { AppEnv } from "../../types";
import { resolverFor } from "../catalog";

const MEDIA_URL = /^\/media\/[a-z]+\/[0-9a-f-]{36}\.(jpg|png|webp|avif|gif)$/;

const optionalId = z
  .union([id, z.literal(""), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

const variantSchema = z.object({
  id: z.string().max(64).optional(),
  sku: z.string().trim().min(2, "SKU is required.").max(64).regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dots, dashes and underscores."),
  colorId: optionalId,
  sizeId: optionalId,
  price: money.nullable().optional(),
  compareAtPrice: money.nullable().optional(),
  inventory: z.coerce.number().int().min(0).max(1_000_000).default(0),
  isActive: z.boolean().default(true),
});

const imageSchema = z.object({
  id: z.string().max(64).optional(),
  url: z
    .string()
    .trim()
    .max(500)
    .refine((url) => MEDIA_URL.test(url) || /^https:\/\/[^\s"'<>]+$/.test(url), "Use an uploaded image (/media/...) or an https:// URL."),
  alt: z.string().trim().max(300).default(""),
  width: z.coerce.number().int().min(1).max(20_000).nullable().optional(),
  height: z.coerce.number().int().min(1).max(20_000).nullable().optional(),
  isPrimary: z.boolean().default(false),
});

const pair = <A extends string, B extends string>(a: A, b: B, maxA: number, maxB: number) =>
  z.object({ [a]: z.string().trim().min(1).max(maxA), [b]: z.string().trim().min(1).max(maxB) } as Record<A | B, z.ZodString>);

export const productSchema = z.object({
  name: z.string().trim().min(2, "Name is required.").max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  tagline: z.string().trim().max(300).default(""),
  description: z.string().trim().max(10_000).default(""),
  story: z.array(z.string().trim().max(4000)).max(20).default([]),
  gender: z.enum(GENDERS).default("UNISEX"),
  categoryId: optionalId,
  materialId: optionalId,
  patternId: optionalId,
  craft: z.string().trim().max(200).default(""),
  countryOfOrigin: z.string().trim().max(80).default("India"),
  weight: z.string().trim().max(80).nullable().optional(),
  finish: z.string().trim().max(80).nullable().optional(),
  price: money,
  compareAtPrice: money.nullable().optional(),
  costPrice: money.nullable().optional(),
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).default("DRAFT"),
  isFeatured: z.boolean().default(false),
  isTrending: z.boolean().default(false),
  isNewArrival: z.boolean().default(false),
  popularity: z.coerce.number().int().min(0).max(1_000_000).default(0),
  lowStockThreshold: z.coerce.number().int().min(0).max(100_000).default(6),
  careInstructions: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  colorIds: z.array(id).max(50).default([]),
  sizeIds: z.array(id).max(50).default([]),
  collectionIds: z.array(id).max(50).default([]),
  badges: z.array(z.enum(BADGES)).max(BADGES.length).default([]),
  relatedProductIds: z.array(id).max(24).default([]),
  images: z.array(imageSchema).max(20).default([]),
  variants: z.array(variantSchema).max(100).default([]),
  specifications: z.array(pair("label", "value", 80, 300)).max(40).default([]),
  faqs: z.array(pair("question", "answer", 300, 2000)).max(30).default([]),
});
type ProductInput = z.output<typeof productSchema>;

const PRESERVED_JSON_KEYS = ["trendingOrder", "featuredOrder", "newArrivalOrder", "rating"];

function productJson(input: ProductInput, previous?: string): string {
  const kept = asRecord(parseJson(previous ?? "{}", {}));
  const specs = input.specifications.filter((spec) => spec.label !== "Weight" && spec.label !== "Finish");
  if (input.weight) specs.push({ label: "Weight", value: input.weight });
  if (input.finish) specs.push({ label: "Finish", value: input.finish });
  return JSON.stringify({
    ...Object.fromEntries(PRESERVED_JSON_KEYS.filter((key) => key in kept).map((key) => [key, kept[key]])),
    tagline: input.tagline,
    description: input.description,
    story: input.story.filter(Boolean),
    gender: input.gender,
    materialId: input.materialId,
    patternId: input.patternId,
    craft: input.craft,
    colorIds: [...new Set(input.colorIds)],
    sizeIds: [...new Set(input.sizeIds)],
    badges: [...new Set(input.badges)],
    specifications: specs,
    careInstructions: input.careInstructions,
    countryOfOrigin: input.countryOfOrigin || "India",
    faqs: input.faqs,
    relatedProductIds: [...new Set(input.relatedProductIds)],
    isFeatured: input.isFeatured,
    isTrending: input.isTrending,
    isNewArrival: input.isNewArrival,
  });
}

/** Rejects references to taxonomy, categories, collections or products that do not exist. */
async function validateReferences(db: D1Database, input: ProductInput, selfId?: string) {
  const termIds = [
    ...input.colorIds,
    ...input.sizeIds,
    ...(input.materialId ? [input.materialId] : []),
    ...(input.patternId ? [input.patternId] : []),
    ...input.variants.flatMap((variant) => [variant.colorId, variant.sizeId]).filter((value): value is string => Boolean(value)),
  ];
  const unique = <T,>(values: T[]) => [...new Set(values)];
  const ids = (values: string[]) => (values.length ? values : ["__none__"]);
  const [terms, categories, collections, products] = await db.batch([
    db.prepare(`SELECT id, kind FROM taxonomy_terms WHERE id IN (${ids(unique(termIds)).map(() => "?").join(",")})`).bind(...ids(unique(termIds))),
    db.prepare(`SELECT id FROM categories WHERE id = ?`).bind(input.categoryId ?? "__none__"),
    db.prepare(`SELECT id FROM collections WHERE id IN (${ids(unique(input.collectionIds)).map(() => "?").join(",")})`).bind(...ids(unique(input.collectionIds))),
    db
      .prepare(`SELECT id FROM products WHERE id IN (${ids(unique(input.relatedProductIds)).map(() => "?").join(",")})`)
      .bind(...ids(unique(input.relatedProductIds))),
  ]);
  const kinds = new Map(((terms?.results ?? []) as Array<{ id: string; kind: string }>).map((row) => [row.id, row.kind]));
  const errors: Record<string, string> = {};
  const expectKind = (field: string, value: string | null | undefined, kind: string) => {
    if (value && kinds.get(value) !== kind) errors[field] = `Unknown ${kind}.`;
  };
  expectKind("materialId", input.materialId, "material");
  expectKind("patternId", input.patternId, "pattern");
  input.colorIds.forEach((value, index) => expectKind(`colorIds.${index}`, value, "color"));
  input.sizeIds.forEach((value, index) => expectKind(`sizeIds.${index}`, value, "size"));
  input.variants.forEach((variant, index) => {
    expectKind(`variants.${index}.colorId`, variant.colorId, "color");
    expectKind(`variants.${index}.sizeId`, variant.sizeId, "size");
  });
  if (input.categoryId && !(categories?.results ?? []).length) errors.categoryId = "Unknown category.";
  const foundCollections = new Set(((collections?.results ?? []) as Array<{ id: string }>).map((row) => row.id));
  input.collectionIds.forEach((value, index) => {
    if (!foundCollections.has(value)) errors[`collectionIds.${index}`] = "Unknown collection.";
  });
  const foundProducts = new Set(((products?.results ?? []) as Array<{ id: string }>).map((row) => row.id));
  input.relatedProductIds.forEach((value, index) => {
    if (!foundProducts.has(value) || value === selfId) errors[`relatedProductIds.${index}`] = "Unknown related product.";
  });

  const skus = input.variants.map((variant) => variant.sku.toLowerCase());
  skus.forEach((sku, index) => {
    if (skus.indexOf(sku) !== index) errors[`variants.${index}.sku`] = "Duplicate SKU.";
  });
  const combos = input.variants.map((variant) => `${variant.colorId ?? ""}|${variant.sizeId ?? ""}`);
  combos.forEach((combo, index) => {
    if (combos.indexOf(combo) !== index) errors[`variants.${index}`] = "Duplicate colour and size combination.";
  });
  if (input.compareAtPrice != null && input.compareAtPrice > 0 && input.compareAtPrice <= input.price) {
    errors.compareAtPrice = "Compare-at price must be higher than the price.";
  }
  if (input.images.filter((image) => image.isPrimary).length > 1) errors.images = "Only one image can be primary.";
  if (input.status === "PUBLISHED") {
    if (!input.categoryId) errors.categoryId = "Choose a category before publishing.";
    if (!input.images.length) errors.images = "Add at least one image before publishing.";
  }
  if (Object.keys(errors).length) throw validationError(errors);
}

function translateWriteError(error: unknown): never {
  const message = String((error as Error)?.message ?? error);
  if (isUniqueViolation(error) && /products\.slug/.test(message)) throw conflict("SLUG_TAKEN", "Another product already uses this slug.", { slug: "Already in use." });
  if (isUniqueViolation(error) && /sku/i.test(message)) throw conflict("SKU_TAKEN", "A variant SKU is already used by another product.", { variants: "SKU already in use." });
  if (isStockViolation(error)) throw conflict("INSUFFICIENT_STOCK", "Stock cannot go below zero (orders may have been placed meanwhile). Reload and try again.");
  throw error;
}

interface SaveContext {
  c: Context<AppEnv>;
  input: ProductInput;
  productId: string;
  existing?: { row: ProductView["row"]; variants: VariantRow[]; hasOrders: Set<string> };
}

function variantSort(input: ProductInput) {
  return input.variants.map((variant, index) => ({ ...variant, sortOrder: index }));
}

/** Builds every statement for a product save so it commits (or fails) as one batch. */
function saveStatements({ c, input, productId, existing }: SaveContext): D1PreparedStatement[] {
  const db = c.env.DB;
  const actor = currentUser(c).userId;
  const statements: D1PreparedStatement[] = [];
  const movement = (variantId: string | null, delta: number, reason: string, note: string) =>
    db
      .prepare(`INSERT INTO inventory_movements (id, product_id, variant_id, delta, reason, note, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId(), productId, variantId, delta, reason, note, actor);

  const slug = input.slug ?? slugify(input.name);
  const values = [
    slug,
    input.name,
    input.status,
    toPaise(input.price),
    productJson(input, existing?.row.product_json),
    input.categoryId,
    input.compareAtPrice ? toPaise(input.compareAtPrice) : null,
    input.costPrice != null ? toPaise(input.costPrice) : null,
    input.lowStockThreshold,
    input.popularity,
  ];

  if (!existing) {
    statements.push(
      db
        .prepare(
          `INSERT INTO products (slug, name, status, price_paise, product_json, category_id, compare_at_price_paise, cost_price_paise, low_stock_threshold, popularity, id, published_at, stock)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(...values, productId, input.status === "PUBLISHED" ? nowIso() : null),
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE products SET slug = ?1, name = ?2, status = ?3, price_paise = ?4, product_json = ?5, category_id = ?6, compare_at_price_paise = ?7,
                  cost_price_paise = ?8, low_stock_threshold = ?9, popularity = ?10,
                  published_at = CASE WHEN ?3 = 'PUBLISHED' AND published_at IS NULL THEN ?12 ELSE published_at END,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?11`,
        )
        .bind(...values, productId, nowIso()),
    );
  }

  const previous = new Map((existing?.variants ?? []).map((variant) => [variant.id, variant]));
  const kept = new Set<string>();

  // A product that gains its first variants hands stock tracking over to them.
  if (existing && !existing.variants.length && input.variants.length && existing.row.stock > 0) {
    statements.push(db.prepare(`UPDATE products SET stock = stock - ? WHERE id = ?`).bind(existing.row.stock, productId));
    statements.push(movement(null, -existing.row.stock, "CORRECTION", "Stock moved to variants"));
  }

  for (const variant of variantSort(input)) {
    const price = variant.price != null ? toPaise(variant.price) : null;
    const pricePaise = price === toPaise(input.price) ? null : price;
    const compare = variant.compareAtPrice ? toPaise(variant.compareAtPrice) : null;
    const current = variant.id ? previous.get(variant.id) : undefined;
    if (current) {
      kept.add(current.id);
      statements.push(
        db
          .prepare(
            `UPDATE product_variants SET sku = ?, color_id = ?, size_id = ?, price_paise = ?, compare_at_price_paise = ?, is_active = ?, sort_order = ?,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND product_id = ?`,
          )
          .bind(variant.sku, variant.colorId, variant.sizeId, pricePaise, compare, variant.isActive ? 1 : 0, variant.sortOrder, current.id, productId),
      );
      // Applied as a delta from what we read, so orders placed meanwhile are not overwritten.
      const delta = variant.inventory - current.stock;
      if (delta !== 0) {
        statements.push(db.prepare(`UPDATE product_variants SET stock = stock + ? WHERE id = ?`).bind(delta, current.id));
        statements.push(movement(current.id, delta, "ADJUSTMENT", "Product editor"));
      }
    } else {
      const variantId = newId();
      statements.push(
        db
          .prepare(
            `INSERT INTO product_variants (id, product_id, sku, color_id, size_id, price_paise, compare_at_price_paise, stock, is_active, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(variantId, productId, variant.sku, variant.colorId, variant.sizeId, pricePaise, compare, variant.inventory, variant.isActive ? 1 : 0, variant.sortOrder),
      );
      if (variant.inventory > 0) statements.push(movement(variantId, variant.inventory, "INITIAL", "Variant created"));
    }
  }

  for (const variant of existing?.variants ?? []) {
    if (kept.has(variant.id)) continue;
    statements.push(db.prepare(`DELETE FROM cart_items WHERE variant_id = ?`).bind(variant.id));
    if (existing?.hasOrders.has(variant.id)) {
      // Ordered variants are retired, not deleted, so order history stays resolvable.
      statements.push(db.prepare(`UPDATE product_variants SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(variant.id));
    } else {
      statements.push(db.prepare(`DELETE FROM product_variants WHERE id = ?`).bind(variant.id));
      if (variant.stock > 0) statements.push(movement(variant.id, -variant.stock, "CORRECTION", "Variant removed"));
    }
  }

  statements.push(db.prepare(`DELETE FROM product_images WHERE product_id = ?`).bind(productId));
  const hasPrimary = input.images.some((image) => image.isPrimary);
  input.images.forEach((image, index) => {
    const key = image.url.startsWith("/media/") ? image.url.slice("/media/".length) : null;
    statements.push(
      db
        .prepare(
          `INSERT INTO product_images (id, product_id, media_id, url, alt, width, height, is_primary, sort_order)
           VALUES (?, ?, (SELECT id FROM media_objects WHERE object_key = ?), ?, ?,
                   COALESCE(?, (SELECT width FROM media_objects WHERE object_key = ?)),
                   COALESCE(?, (SELECT height FROM media_objects WHERE object_key = ?)), ?, ?)`,
        )
        .bind(newId(), productId, key, image.url, image.alt, image.width ?? null, key, image.height ?? null, key, image.isPrimary || (!hasPrimary && index === 0) ? 1 : 0, index),
    );
  });

  statements.push(db.prepare(`DELETE FROM product_collections WHERE product_id = ?`).bind(productId));
  [...new Set(input.collectionIds)].forEach((collectionId, index) => {
    statements.push(db.prepare(`INSERT INTO product_collections (product_id, collection_id, sort_order) VALUES (?, ?, ?)`).bind(productId, collectionId, index));
  });

  return statements;
}

/** Field-level permissions on top of the route permission. */
function assertFieldPermissions(c: Context<AppEnv>, input: ProductInput, before?: { status: string; details: ProductView["details"]; stockChanged: boolean }) {
  const role = currentUser(c).adminRole;
  const publishing = input.status === "PUBLISHED" && before?.status !== "PUBLISHED";
  if (publishing && !hasPermission(role, "products.publish")) throw forbidden("You do not have permission to publish products.");
  const merchChanged =
    input.isFeatured !== (before?.details.isFeatured ?? false) ||
    input.isTrending !== (before?.details.isTrending ?? false) ||
    input.isNewArrival !== (before?.details.isNewArrival ?? false);
  if (merchChanged && !hasPermission(role, "products.merchandise")) throw forbidden("You do not have permission to change merchandising flags.");
  const stockChanged = before ? before.stockChanged : input.variants.some((variant) => variant.inventory > 0);
  if (stockChanged && !hasPermission(role, "inventory.adjust")) throw forbidden("You do not have permission to change stock levels.");
}

async function loadAdminProduct(c: Context<AppEnv>, productId: string) {
  const catalog = await loadCatalog(c.env.DB);
  const row = catalog.products.find((product) => product.id === productId);
  if (!row) throw notFound("Product");
  return adminProduct(viewProduct(catalog, row), catalog, resolverFor(c));
}

export const adminProductRoutes = new Hono<AppEnv>();

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(80).optional(),
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(),
  stock: z.enum(["in", "low", "out"]).optional(),
  flag: z.enum(["featured", "trending", "new"]).optional(),
  category: z.string().max(64).optional(),
  sort: z.enum(["newest", "oldest", "name", "price-low", "price-high", "stock-low", "updated", "featured"]).default("newest"),
});

adminProductRoutes.get("/", can("products.view"), async (c) => {
  const input = query(c, listSchema);
  const catalog = await loadCatalog(c.env.DB);
  let views = catalog.products.map((row) => viewProduct(catalog, row));
  if (input.q) views = views.filter((view) => matchesSearch(view, input.q!));
  if (input.status) views = views.filter((view) => view.row.status === input.status);
  if (input.category) views = views.filter((view) => view.row.category_id === input.category || view.category?.slug === input.category);
  if (input.stock) {
    views = views.filter((view) => (input.stock === "out" ? view.inventory <= 0 : input.stock === "low" ? view.inventory > 0 && view.inventory <= view.row.low_stock_threshold : view.inventory > view.row.low_stock_threshold));
  }
  if (input.flag) {
    const rail = input.flag === "new" ? "newArrival" : input.flag;
    const key = input.flag === "new" ? "isNewArrival" : input.flag === "featured" ? "isFeatured" : "isTrending";
    views = views.filter((view) => view.details[key]).sort((a, b) => (a.details.railOrder[rail] ?? 1e9) - (b.details.railOrder[rail] ?? 1e9));
  } else {
    const time = (value: string) => Date.parse(value.replace(" ", "T")) || 0;
    const sorters: Record<string, (a: ProductView, b: ProductView) => number> = {
      newest: (a, b) => time(b.row.created_at) - time(a.row.created_at),
      oldest: (a, b) => time(a.row.created_at) - time(b.row.created_at),
      updated: (a, b) => time(b.row.updated_at) - time(a.row.updated_at),
      name: (a, b) => a.row.name.localeCompare(b.row.name),
      "price-low": (a, b) => a.row.price_paise - b.row.price_paise,
      "price-high": (a, b) => b.row.price_paise - a.row.price_paise,
      "stock-low": (a, b) => a.inventory - b.inventory,
    };
    views = input.sort === "featured" ? sortViews(views, "featured") : views.sort(sorters[input.sort]);
  }
  const resolve = resolverFor(c);
  const start = (input.page - 1) * input.limit;
  const counts = {
    all: catalog.products.length,
    published: catalog.products.filter((row) => row.status === "PUBLISHED").length,
    draft: catalog.products.filter((row) => row.status === "DRAFT").length,
    archived: catalog.products.filter((row) => row.status === "ARCHIVED").length,
  };
  return paginated(c, views.slice(start, start + input.limit).map((view) => adminProductRow(view, resolve)), views.length, input.page, input.limit, { counts });
});

adminProductRoutes.get("/:id", can("products.view"), async (c) => ok(c, await loadAdminProduct(c, c.req.param("id"))));

adminProductRoutes.post("/", can("products.create"), async (c) => {
  const input = await body(c, productSchema);
  assertFieldPermissions(c, input);
  await validateReferences(c.env.DB, input);
  const productId = newId();
  const statements = saveStatements({ c, input, productId });
  statements.push(auditStatement(c, { action: "product.create", entityType: "product", targetId: productId, metadata: { name: input.name, status: input.status } }));
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    translateWriteError(error);
  }
  return created(c, await loadAdminProduct(c, productId));
});

async function update(c: Context<AppEnv>) {
  const productId = c.req.param("id")!;
  const input = await body(c, productSchema);
  const db = c.env.DB;
  const [productRows, variantRows, orderedRows] = await db.batch([
    db.prepare(`SELECT * FROM products WHERE id = ?`).bind(productId),
    db.prepare(`SELECT * FROM product_variants WHERE product_id = ?`).bind(productId),
    db.prepare(`SELECT DISTINCT variant_id FROM order_items WHERE product_id = ? AND variant_id <> ''`).bind(productId),
  ]);
  const row = productRows?.results[0] as ProductView["row"] | undefined;
  if (!row) throw notFound("Product");
  const variants = (variantRows?.results ?? []) as unknown as VariantRow[];
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  const stockChanged =
    input.variants.some((variant) => (variant.id && byId.has(variant.id) ? byId.get(variant.id)!.stock !== variant.inventory : variant.inventory > 0)) ||
    variants.some((variant) => variant.stock > 0 && !input.variants.some((entry) => entry.id === variant.id));
  assertFieldPermissions(c, input, { status: row.status, details: readProductDetails(row.product_json), stockChanged });
  await validateReferences(db, input, productId);

  const statements = saveStatements({
    c,
    input,
    productId,
    existing: { row, variants, hasOrders: new Set(((orderedRows?.results ?? []) as Array<{ variant_id: string }>).map((entry) => entry.variant_id)) },
  });
  statements.push(
    auditStatement(c, {
      action: input.status !== row.status ? `product.update.status.${input.status.toLowerCase()}` : "product.update",
      entityType: "product",
      targetId: productId,
      metadata: { name: input.name, from: row.status, to: input.status },
    }),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    translateWriteError(error);
  }
  return ok(c, await loadAdminProduct(c, productId));
}

adminProductRoutes.put("/:id", can("products.update"), update);
adminProductRoutes.patch("/:id", can("products.update"), update);

adminProductRoutes.patch("/:id/status", can("products.publish"), async (c) => {
  const { status } = await body(c, z.object({ status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]) }));
  const db = c.env.DB;
  const productId = c.req.param("id");
  const product = await loadAdminProduct(c, productId);
  if (status === "PUBLISHED" && (!product.raw.categoryId || !product.raw.images.length)) {
    throw validationError({ status: "Add a category and at least one image before publishing." });
  }
  await db.batch([
    db
      .prepare(
        `UPDATE products SET status = ?1, published_at = CASE WHEN ?1 = 'PUBLISHED' AND published_at IS NULL THEN ?2 ELSE published_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?3`,
      )
      .bind(status, nowIso(), productId),
    auditStatement(c, { action: `product.status.${status.toLowerCase()}`, entityType: "product", targetId: productId, metadata: { from: product.status } }),
  ]);
  return ok(c, await loadAdminProduct(c, productId));
});

adminProductRoutes.patch("/:id/merchandising", can("products.merchandise"), async (c) => {
  const input = await body(
    c,
    z.object({ isFeatured: z.boolean().optional(), isTrending: z.boolean().optional(), isNewArrival: z.boolean().optional(), popularity: z.coerce.number().int().min(0).max(1_000_000).optional() }),
  );
  const db = c.env.DB;
  const productId = c.req.param("id");
  const exists = await db.prepare(`SELECT id FROM products WHERE id = ?`).bind(productId).first();
  if (!exists) throw notFound("Product");
  const statements: D1PreparedStatement[] = [];
  for (const key of ["isFeatured", "isTrending", "isNewArrival"] as const) {
    if (input[key] !== undefined) {
      statements.push(
        db.prepare(`UPDATE products SET product_json = json_set(product_json, ?, json(?)), updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(`$.${key}`, String(input[key]), productId),
      );
    }
  }
  if (input.popularity !== undefined) statements.push(db.prepare(`UPDATE products SET popularity = ? WHERE id = ?`).bind(input.popularity, productId));
  if (!statements.length) throw badRequest("Nothing to update.");
  statements.push(auditStatement(c, { action: "product.merchandising", entityType: "product", targetId: productId, metadata: input }));
  await db.batch(statements);
  return ok(c, await loadAdminProduct(c, productId));
});

adminProductRoutes.post("/merchandising/reorder", can("products.merchandise"), async (c) => {
  const input = await body(c, z.object({ rail: z.enum(["trending", "featured", "newArrival"]), ids: z.array(id).min(1).max(200) }));
  const db = c.env.DB;
  const key = `$.${input.rail}Order`;
  await db.batch([
    ...input.ids.map((productId, index) => db.prepare(`UPDATE products SET product_json = json_set(product_json, ?, ?) WHERE id = ?`).bind(key, index, productId)),
    auditStatement(c, { action: "product.merchandising.reorder", entityType: "product", metadata: input }),
  ]);
  return ok(c, { rail: input.rail, ids: input.ids });
});

adminProductRoutes.delete("/:id", can("products.delete"), async (c) => {
  const db = c.env.DB;
  const productId = c.req.param("id");
  const row = await db
    .prepare(`SELECT id, name, (SELECT COUNT(*) FROM order_items WHERE product_id = products.id) AS orders FROM products WHERE id = ?`)
    .bind(productId)
    .first<{ id: string; name: string; orders: number }>();
  if (!row) throw notFound("Product");
  if (row.orders > 0) {
    // Ordered products are archived so order history and reports stay intact.
    await db.batch([
      db.prepare(`UPDATE products SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(productId),
      db.prepare(`DELETE FROM cart_items WHERE product_id = ?`).bind(productId),
      auditStatement(c, { action: "product.archive", entityType: "product", targetId: productId, metadata: { name: row.name, reason: "has orders" } }),
    ]);
    return ok(c, { id: productId, archived: true, deleted: false });
  }
  await db.batch([
    db.prepare(`DELETE FROM products WHERE id = ?`).bind(productId),
    auditStatement(c, { action: "product.delete", entityType: "product", targetId: productId, metadata: { name: row.name } }),
  ]);
  return ok(c, { id: productId, archived: false, deleted: true });
});

/* ------------------------------------------------------------------ *
 * Inventory
 * ------------------------------------------------------------------ */

export const adjustSchema = z
  .object({
    variantId: z.string().max(64).nullable().optional(),
    delta: z.coerce.number().int().min(-1_000_000).max(1_000_000).optional(),
    setTo: z.coerce.number().int().min(0).max(1_000_000).optional(),
    reason: z.enum(["ADJUSTMENT", "RESTOCK", "DAMAGE", "CORRECTION", "RETURN"]).default("ADJUSTMENT"),
    note: z.string().trim().max(500).optional(),
  })
  .refine((value) => (value.delta === undefined) !== (value.setTo === undefined), { message: "Send either delta or setTo.", path: ["delta"] })
  .refine((value) => value.delta !== 0, { message: "Delta cannot be zero.", path: ["delta"] });

export async function adjustInventory(c: Context<AppEnv>, productId: string, input: z.output<typeof adjustSchema>) {
  const db = c.env.DB;
  const [productRows, variantRows] = await db.batch([
    db.prepare(`SELECT id, stock FROM products WHERE id = ?`).bind(productId),
    db.prepare(`SELECT id, stock FROM product_variants WHERE product_id = ?`).bind(productId),
  ]);
  const product = productRows?.results[0] as { id: string; stock: number } | undefined;
  if (!product) throw notFound("Product");
  const variants = (variantRows?.results ?? []) as Array<{ id: string; stock: number }>;
  let current: number;
  let target: D1PreparedStatement;
  if (variants.length) {
    const variant = variants.find((entry) => entry.id === input.variantId);
    if (!variant) throw validationError({ variantId: "Choose which variant to adjust." });
    current = variant.stock;
    const delta = input.delta ?? input.setTo! - current;
    target = db.prepare(`UPDATE product_variants SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND product_id = ?`).bind(delta, variant.id, productId);
  } else {
    if (input.variantId) throw validationError({ variantId: "This product has no variants." });
    current = product.stock;
    const delta = input.delta ?? input.setTo! - current;
    target = db.prepare(`UPDATE products SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(delta, productId);
  }
  const delta = input.delta ?? input.setTo! - current;
  if (delta === 0) return { productId, variantId: input.variantId ?? null, delta: 0 };
  try {
    await db.batch([
      target,
      db
        .prepare(`INSERT INTO inventory_movements (id, product_id, variant_id, delta, reason, note, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(newId(), productId, input.variantId ?? null, delta, input.reason, input.note ?? null, currentUser(c).userId),
      auditStatement(c, { action: "inventory.adjust", entityType: "product", targetId: productId, metadata: { variantId: input.variantId ?? null, delta, reason: input.reason, note: input.note } }),
    ]);
  } catch (error) {
    if (isStockViolation(error)) throw conflict("INSUFFICIENT_STOCK", "Stock cannot go below zero.");
    throw error;
  }
  const stock = variants.length
    ? await db.prepare(`SELECT stock FROM product_variants WHERE id = ?`).bind(input.variantId).first<{ stock: number }>()
    : await db.prepare(`SELECT stock FROM products WHERE id = ?`).bind(productId).first<{ stock: number }>();
  return { productId, variantId: input.variantId ?? null, delta, stock: stock?.stock ?? null };
}

adminProductRoutes.post("/:id/inventory", can("inventory.adjust"), async (c) => {
  const input = await body(c, adjustSchema);
  return ok(c, await adjustInventory(c, c.req.param("id"), input));
});

adminProductRoutes.get("/:id/inventory-log", can("inventory.view"), async (c) => {
  const input = query(c, z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) }));
  const db = c.env.DB;
  const productId = c.req.param("id");
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT m.*, v.sku, u.name AS actor_name FROM inventory_movements m
           LEFT JOIN product_variants v ON v.id = m.variant_id LEFT JOIN users u ON u.id = m.actor_id
          WHERE m.product_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ? OFFSET ?`,
      )
      .bind(productId, input.limit, (input.page - 1) * input.limit),
    db.prepare(`SELECT COUNT(*) AS n FROM inventory_movements WHERE product_id = ?`).bind(productId),
  ]);
  return paginated(
    c,
    ((rows?.results ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: row.id,
      variantId: row.variant_id,
      sku: row.sku,
      delta: row.delta,
      reason: row.reason,
      referenceId: row.reference_id,
      note: row.note,
      actor: row.actor_name ?? null,
      createdAt: row.created_at,
    })),
    Number((total?.results[0] as { n: number })?.n ?? 0),
    input.page,
    input.limit,
  );
});