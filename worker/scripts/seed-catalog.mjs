#!/usr/bin/env node
/**
 * Imports the launch catalogue (taxonomy, categories, collections, products,
 * variants, images and opening stock) from prisma/seed-data.json into D1.
 *
 *   node scripts/seed-catalog.mjs [--local] [--file path] [--image-base https://www.pashmore.com] [--status PUBLISHED|DRAFT] [--dry-run] [--resume]
 *
 * Safety:
 * - Refuses to run if the catalogue tables already hold rows, so it can never
 *   overwrite or mix with data entered through the admin. --resume lifts that
 *   check to finish an interrupted run of this same seed.
 * - Only INSERT OR IGNORE statements with IDs derived from slugs: re-running
 *   is a no-op, and nothing is updated or deleted.
 * - Relative image paths become absolute URLs on --image-base (the storefront
 *   that already hosts them); nothing is uploaded to R2.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executeFile, query, sqlString, target } from "./d1.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const where = target();
const file = arg("file", fileURLToPath(new URL("../../prisma/seed-data.json", import.meta.url)));
const imageBase = arg("image-base", "https://www.pashmore.com").replace(/\/+$/, "");
const status = arg("status", "PUBLISHED").toUpperCase();
const dryRun = process.argv.includes("--dry-run");
const resume = process.argv.includes("--resume");

if (!/^https:\/\/[^/\s]+$/.test(imageBase)) throw new Error("--image-base must be an https origin");
if (!["PUBLISHED", "DRAFT"].includes(status)) throw new Error("--status must be PUBLISHED or DRAFT");

const data = JSON.parse(readFileSync(file, "utf8"));

/** Stable UUID-shaped id from a namespace and a natural key. */
const stableId = (...parts) => {
  const hex = createHash("sha256").update(`pashmore-seed:${parts.join(":")}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const paise = (rupees) => Math.round(Number(rupees) * 100);
const absolute = (url) => (/^https:\/\//.test(url) ? url : url?.startsWith("/") ? `${imageBase}${url}` : null);
const upper = (value) => String(value ?? "").toUpperCase();
const v = sqlString;
const n = (value) => (value === null || value === undefined ? "NULL" : String(Number(value)));

const KINDS = { colors: "color", sizes: "size", materials: "material", patterns: "pattern" };
const termId = {};
const statements = [];

for (const [plural, kind] of Object.entries(KINDS)) {
  termId[kind] = new Map();
  (data.taxonomy[plural] ?? []).forEach((term, index) => {
    const id = stableId("term", kind, term.slug);
    termId[kind].set(term.slug, id);
    statements.push(
      `INSERT OR IGNORE INTO taxonomy_terms (id, kind, slug, name, hex, measurement, sort_order) VALUES (${v(id)}, ${v(kind)}, ${v(term.slug)}, ${v(term.name)}, ${v(kind === "color" ? term.hex : null)}, ${v(kind === "size" ? term.measurement : term.description ?? null)}, ${index});`,
    );
  });
}

const categoryId = new Map();
(data.taxonomy.categories ?? []).forEach((category, index) => {
  const id = stableId("category", category.slug);
  categoryId.set(category.slug, id);
  const gender = ["WOMEN", "MEN", "UNISEX"].includes(upper(category.gender)) ? upper(category.gender) : null;
  statements.push(
    `INSERT OR IGNORE INTO categories (id, slug, name, description, gender, image_url, sort_order) VALUES (${v(id)}, ${v(category.slug)}, ${v(category.name)}, ${v(category.description ?? "")}, ${v(gender)}, ${v(absolute(category.image?.url) ?? null)}, ${index});`,
  );
});

const collectionId = new Map(data.collections.map((collection) => [collection.slug, stableId("collection", collection.slug)]));
const productId = new Map(data.products.map((product) => [product.slug, stableId("product", product.slug)]));
const known = (map, slugs) => (slugs ?? []).filter((slug) => map.has(slug)).map((slug) => map.get(slug));

data.collections.forEach((collection, index) => {
  const group = ["WOMEN", "MEN", "COLLECTIONS", "GIFTING", "CATEGORY"].includes(upper(collection.group)) ? upper(collection.group) : "COLLECTIONS";
  const json = {
    heading: collection.heading ?? null,
    description: collection.description ?? "",
    seoContent: collection.seoContent ?? [],
    group,
    bannerUrl: absolute(collection.bannerImage?.url) ?? null,
    bannerAlt: collection.bannerImage?.alt ?? null,
    includeCategoryIds: known(categoryId, collection.includeCategorySlugs),
    relatedCollectionIds: known(collectionId, collection.relatedSlugs),
    faqs: collection.faqs ?? [],
    hidden: false,
    featured: collection.featured === true,
  };
  statements.push(
    `INSERT OR IGNORE INTO collections (id, slug, name, collection_json, is_active, sort_order) VALUES (${v(collectionId.get(collection.slug))}, ${v(collection.slug)}, ${v(collection.name)}, ${v(JSON.stringify(json))}, 1, ${index});`,
  );
});

const BADGES = ["NEW", "BESTSELLER", "LIMITED", "HANDCRAFTED", "EXCLUSIVE"];
const problems = [];

// The source data derives SKUs from slug prefixes, so some collide. OR IGNORE would
// silently drop the later variant and its stock; give it a stable product suffix instead.
const usedSkus = new Set();
const renamedSkus = [];
for (const product of data.products) {
  for (const variant of product.variants ?? []) {
    let sku = String(variant.sku);
    if (usedSkus.has(sku.toLowerCase())) {
      sku = `${sku}-${stableId("sku", product.slug).slice(0, 4).toUpperCase()}`;
      renamedSkus.push(`${product.slug}: ${variant.sku} -> ${sku}`);
    }
    if (usedSkus.has(sku.toLowerCase())) throw new Error(`Could not make SKU ${variant.sku} unique for ${product.slug}`);
    usedSkus.add(sku.toLowerCase());
    variant.sku = sku;
  }
}
if (renamedSkus.length) console.log(`Renamed ${renamedSkus.length} duplicate SKUs:\n  ${renamedSkus.join("\n  ")}`);

data.products.forEach((product, productIndex) => {
  const id = productId.get(product.slug);
  const badges = (product.badges ?? []).map(upper).filter((badge) => BADGES.includes(badge));
  const variants = product.variants ?? [];
  if (!categoryId.has(product.categorySlug)) problems.push(`${product.slug}: unknown category ${product.categorySlug}`);
  if (!product.images?.length) problems.push(`${product.slug}: no images`);
  if (!variants.length) problems.push(`${product.slug}: no variants`);

  const json = {
    tagline: product.tagline ?? "",
    description: product.description ?? "",
    story: product.story ?? [],
    gender: ["WOMEN", "MEN", "UNISEX"].includes(upper(product.gender)) ? upper(product.gender) : "UNISEX",
    materialId: termId.material.get(product.materialSlug) ?? null,
    patternId: termId.pattern.get(product.patternSlug) ?? null,
    craft: product.craft ?? "",
    colorIds: known(termId.color, (product.colors ?? []).map((color) => color.slug)),
    sizeIds: known(termId.size, (product.sizes ?? []).map((size) => size.slug)),
    badges,
    specifications: product.specifications ?? [],
    careInstructions: product.careInstructions ?? [],
    countryOfOrigin: product.countryOfOrigin || "India",
    faqs: product.faqs ?? [],
    relatedProductIds: known(productId, product.relatedSlugs).filter((related) => related !== id),
    isFeatured: badges.includes("BESTSELLER"),
    isTrending: badges.includes("BESTSELLER"),
    isNewArrival: badges.includes("NEW"),
    ...(product.rating?.count > 0 ? { rating: { average: Number(product.rating.average), count: Number(product.rating.count) } } : {}),
  };
  const publishedAt = status === "PUBLISHED" ? new Date(Date.parse(product.publishedAt) || Date.now()).toISOString() : null;
  const compareAt = product.compareAtPrice > product.price ? paise(product.compareAtPrice) : null;

  statements.push(
    `INSERT OR IGNORE INTO products (id, slug, name, status, price_paise, stock, product_json, category_id, compare_at_price_paise, published_at, popularity) VALUES (${v(id)}, ${v(product.slug)}, ${v(product.name)}, ${v(status)}, ${paise(product.price)}, 0, ${v(JSON.stringify(json))}, ${v(categoryId.get(product.categorySlug) ?? null)}, ${n(compareAt)}, ${v(publishedAt)}, ${n(product.popularity ?? 0)});`,
  );

  variants.forEach((variant, index) => {
    const variantId = stableId("variant", product.slug, variant.sku);
    const price = variant.price != null && paise(variant.price) !== paise(product.price) ? paise(variant.price) : null;
    const variantCompare = variant.compareAtPrice > (variant.price ?? product.price) ? paise(variant.compareAtPrice) : null;
    const stock = Math.max(0, Math.trunc(Number(variant.inventory) || 0));
    // The insert trigger adds this stock to products.stock.
    statements.push(
      `INSERT OR IGNORE INTO product_variants (id, product_id, sku, color_id, size_id, price_paise, compare_at_price_paise, stock, sort_order) VALUES (${v(variantId)}, ${v(id)}, ${v(variant.sku)}, ${v(termId.color.get(variant.colorSlug) ?? null)}, ${v(termId.size.get(variant.sizeSlug) ?? null)}, ${n(price)}, ${n(variantCompare)}, ${stock}, ${index});`,
    );
    if (stock > 0) {
      statements.push(
        `INSERT OR IGNORE INTO inventory_movements (id, product_id, variant_id, delta, reason, note) VALUES (${v(stableId("movement", variantId))}, ${v(id)}, ${v(variantId)}, ${stock}, 'INITIAL', 'Catalogue seed');`,
      );
    }
  });

  const hasPrimary = product.images.some((image) => image.isPrimary);
  product.images.forEach((image, index) => {
    const url = absolute(image.url);
    if (!url) return problems.push(`${product.slug}: unusable image ${image.url}`);
    statements.push(
      `INSERT OR IGNORE INTO product_images (id, product_id, url, alt, width, height, is_primary, sort_order) VALUES (${v(stableId("image", product.slug, index))}, ${v(id)}, ${v(url)}, ${v(image.alt ?? "")}, ${n(image.width ?? null)}, ${n(image.height ?? null)}, ${image.isPrimary || (!hasPrimary && index === 0) ? 1 : 0}, ${index});`,
    );
  });

  known(collectionId, product.collectionSlugs).forEach((collection) => {
    statements.push(`INSERT OR IGNORE INTO product_collections (product_id, collection_id, sort_order) VALUES (${v(id)}, ${v(collection)}, ${productIndex});`);
  });
});

if (problems.length && status === "PUBLISHED") {
  console.error(`Refusing to publish products with problems:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

statements.push(
  `INSERT OR IGNORE INTO audit_events (id, user_id, action, entity_type, metadata_json) VALUES (${v(stableId("audit", "catalog.seed"))}, NULL, 'catalog.seed', 'product', ${v(JSON.stringify({ products: data.products.length, collections: data.collections.length, status, imageBase }))});`,
);

const summary = `${data.products.length} products, ${data.collections.length} collections, ${categoryId.size} categories, ${Object.values(termId).reduce((sum, map) => sum + map.size, 0)} taxonomy terms, ${statements.length} statements`;

if (dryRun) {
  console.log(`Dry run (${summary}). First statements:\n${statements.slice(0, 5).join("\n")}`);
  process.exit(0);
}

const [counts] = query(
  `SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM categories) AS categories, (SELECT COUNT(*) FROM collections) AS collections, (SELECT COUNT(*) FROM taxonomy_terms) AS terms`,
  where,
);
const existing = Object.entries(counts).filter(([, count]) => Number(count) > 0);
if (existing.length && !resume) {
  console.error(`The catalogue is not empty (${existing.map(([table, count]) => `${table}: ${count}`).join(", ")}). Nothing was changed.`);
  console.error("Use --resume only to finish an interrupted run of this seed.");
  process.exit(1);
}

executeFile(statements.join("\n"), where);
const [after] = query(
  `SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COALESCE(SUM(stock), 0) FROM products) AS stock, (SELECT COUNT(*) FROM product_variants) AS variants, (SELECT COUNT(*) FROM product_images) AS images, (SELECT COUNT(*) FROM collections) AS collections`,
  where,
);
console.log(`Seeded the ${where === "--remote" ? "live" : "local"} catalogue (${summary}).`);
console.log(after);
