import { Hono, type Context } from "hono";
import { z } from "zod";
import { mediaResolver, publishedCatalog, publicCollection, publicProduct, type Catalog, type CollectionRow } from "../catalog/model";
import { applyFilters, buildFacets, inCollectionScope, matchesSearch, publishedViews, SORTS, sortViews } from "../catalog/query";
import { notFound } from "../lib/errors";
import { ok, pagination } from "../lib/http";
import { csvList, query, slug } from "../lib/validation";
import type { AppEnv } from "../types";

export function resolverFor(c: Context<AppEnv>) {
  return mediaResolver(c.get("config").mediaBaseUrl ?? new URL(c.req.url).origin);
}

/** Prices differ per region, so shared caches must key on how the region was chosen. */
function cachePublic(c: Context<AppEnv>) {
  c.header("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=120");
  c.header("Vary", "X-Client-Country, CF-IPCountry", { append: true });
}

const listSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  sort: z.enum(SORTS).default("featured"),
  q: z.string().trim().max(80).optional(),
  category: csvList,
  color: csvList,
  material: csvList,
  size: csvList,
  pattern: csvList,
  collection: csvList,
  availability: csvList,
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  facets: z.enum(["true", "false", "1", "0"]).optional(),
});

function activeCollection(catalog: Catalog, collectionSlug: string): CollectionRow {
  const collection = [...catalog.collections.values()].find((entry) => entry.slug === collectionSlug && entry.is_active === 1);
  if (!collection) throw notFound("Collection");
  return collection;
}

async function listProducts(c: Context<AppEnv>, collectionSlug?: string) {
  const input = query(c, listSchema);
  const catalog = await publishedCatalog(c.env.DB);
  const currency = c.get("currency");
  let scope = publishedViews(catalog, currency);
  if (collectionSlug) scope = inCollectionScope(scope, activeCollection(catalog, collectionSlug));
  if (input.q) scope = scope.filter((view) => matchesSearch(view, input.q!));

  const filtered = sortViews(applyFilters(scope, input, catalog, currency), input.sort, currency);
  const start = (input.page - 1) * input.limit;
  const resolve = resolverFor(c);
  const items = filtered.slice(start, start + input.limit).map((view) => publicProduct(view, catalog, resolve, "card", currency));
  const includeFacets = input.facets !== "false" && input.facets !== "0";
  cachePublic(c);
  return ok(c, items, {
    ...pagination(filtered.length, input.page, input.limit),
    ...(includeFacets ? { facets: buildFacets(scope, catalog, currency) } : {}),
  });
}

export const catalogRoutes = new Hono<AppEnv>();

catalogRoutes.get("/products", (c) => listProducts(c));

catalogRoutes.get("/products/batch", async (c) => {
  const { slugs } = query(c, z.object({ slugs: csvList }));
  const wanted = slugs.slice(0, 24);
  const catalog = await publishedCatalog(c.env.DB);
  const resolve = resolverFor(c);
  const bySlug = new Map(publishedViews(catalog).map((view) => [view.row.slug, view]));
  cachePublic(c);
  return ok(
    c,
    wanted.map((entry) => bySlug.get(entry)).filter(Boolean).map((view) => publicProduct(view!, catalog, resolve, "card", c.get("currency"))),
  );
});

for (const [path, flag] of [
  ["/products/featured", "isFeatured"],
  ["/products/trending", "isTrending"],
  ["/products/new-arrivals", "isNewArrival"],
] as const) {
  catalogRoutes.get(path, async (c) => {
    const { limit } = query(c, z.object({ limit: z.coerce.number().int().min(1).max(48).default(12) }));
    const catalog = await publishedCatalog(c.env.DB);
    const resolve = resolverFor(c);
    const rail = flag === "isFeatured" ? "featured" : flag === "isTrending" ? "trending" : "newArrival";
    const currency = c.get("currency");
    const views = publishedViews(catalog, currency)
      .filter((view) => view.details[flag])
      .sort((a, b) => (a.details.railOrder[rail] ?? 1e9) - (b.details.railOrder[rail] ?? 1e9) || b.featuredScore - a.featuredScore);
    cachePublic(c);
    return ok(c, views.slice(0, limit).map((view) => publicProduct(view, catalog, resolve, "card", currency)));
  });
}

catalogRoutes.get("/products/:slug", async (c) => {
  const productSlug = slug.safeParse(c.req.param("slug"));
  if (!productSlug.success) throw notFound("Product");
  const catalog = await publishedCatalog(c.env.DB);
  const view = publishedViews(catalog).find((entry) => entry.row.slug === productSlug.data);
  if (!view) throw notFound("Product");
  cachePublic(c);
  return ok(c, publicProduct(view, catalog, resolverFor(c), "full", c.get("currency")));
});

catalogRoutes.get("/products/:slug/related", async (c) => {
  const { limit } = query(c, z.object({ limit: z.coerce.number().int().min(1).max(24).default(4) }));
  const catalog = await publishedCatalog(c.env.DB);
  const currency = c.get("currency");
  const view = publishedViews(catalog).find((entry) => entry.row.slug === c.req.param("slug"));
  if (!view) throw notFound("Product");
  const views = publishedViews(catalog, currency);
  const explicit = view.details.relatedProductIds.map((id) => views.find((entry) => entry.row.id === id)).filter((entry) => entry && entry.inventory > 0);
  const sameCategory = sortViews(
    views.filter((entry) => entry.row.id !== view.row.id && entry.row.category_id === view.row.category_id && entry.inventory > 0),
    "featured",
  );
  const picked = [...new Map([...explicit, ...sameCategory].map((entry) => [entry!.row.id, entry!])).values()].slice(0, limit);
  const resolve = resolverFor(c);
  cachePublic(c);
  return ok(c, picked.map((entry) => publicProduct(entry, catalog, resolve, "card", currency)));
});

catalogRoutes.get("/collections", async (c) => {
  const catalog = await publishedCatalog(c.env.DB);
  const views = publishedViews(catalog, c.get("currency"));
  const resolve = resolverFor(c);
  const collections = [...catalog.collections.values()]
    .filter((collection) => collection.is_active === 1)
    .map((collection) => publicCollection(collection, catalog, resolve, inCollectionScope(views, collection).length));
  cachePublic(c);
  return ok(c, collections);
});

catalogRoutes.get("/collections/:slug", async (c) => {
  const catalog = await publishedCatalog(c.env.DB);
  const collection = activeCollection(catalog, c.req.param("slug"));
  const count = inCollectionScope(publishedViews(catalog, c.get("currency")), collection).length;
  cachePublic(c);
  return ok(c, publicCollection(collection, catalog, resolverFor(c), count));
});

catalogRoutes.get("/collections/:slug/products", (c) => listProducts(c, c.req.param("slug")));

catalogRoutes.get("/categories", async (c) => {
  const catalog = await publishedCatalog(c.env.DB);
  const views = publishedViews(catalog, c.get("currency"));
  const resolve = resolverFor(c);
  cachePublic(c);
  return ok(
    c,
    [...catalog.categories.values()]
      .filter((category) => category.is_active === 1)
      .map((category) => ({
        slug: category.slug,
        name: category.name,
        description: category.description,
        gender: category.gender?.toLowerCase(),
        image: category.image_url ? { url: resolve(category.image_url), alt: category.name } : null,
        sortOrder: category.sort_order,
        productCount: views.filter((view) => view.row.category_id === category.id).length,
      })),
  );
});

catalogRoutes.get("/taxonomy", async (c) => {
  const catalog = await publishedCatalog(c.env.DB);
  const terms = [...catalog.terms.values()].filter((term) => term.is_active === 1);
  const pick = (kind: string) =>
    terms
      .filter((term) => term.kind === kind)
      .map((term) => ({ name: term.name, slug: term.slug, ...(term.hex ? { hex: term.hex } : {}), ...(term.measurement ? { measurement: term.measurement } : {}), sortOrder: term.sort_order }));
  cachePublic(c);
  return ok(c, {
    colors: pick("color"),
    sizes: pick("size"),
    materials: pick("material"),
    patterns: pick("pattern"),
    categories: [...catalog.categories.values()].filter((category) => category.is_active === 1).map((category) => ({ name: category.name, slug: category.slug })),
  });
});

catalogRoutes.get("/search", async (c) => {
  const input = query(c, z.object({ q: z.string().trim().max(80).default(""), limit: z.coerce.number().int().min(1).max(24).default(8) }));
  if (!input.q) return ok(c, { products: [], collections: [], total: 0 });
  const catalog = await publishedCatalog(c.env.DB);
  const needle = input.q.toLowerCase();
  const currency = c.get("currency");
  const matches = sortViews(publishedViews(catalog, currency).filter((view) => matchesSearch(view, input.q)), "featured").sort(
    (a, b) => Number(b.row.name.toLowerCase().startsWith(needle)) - Number(a.row.name.toLowerCase().startsWith(needle)),
  );
  const resolve = resolverFor(c);
  const collections = [...catalog.collections.values()]
    .filter((collection) => collection.is_active === 1 && collection.name.toLowerCase().includes(needle))
    .slice(0, 6)
    .map((collection) => ({ slug: collection.slug, name: collection.name }));
  cachePublic(c);
  return ok(c, {
    products: matches.slice(0, input.limit).map((view) => publicProduct(view, catalog, resolve, "card", currency)),
    collections,
    total: matches.length,
  });
});
