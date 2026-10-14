import type { Currency } from "../commerce/currency";
import type { Catalog, CollectionRow, ProductView } from "./model";
import { basePrice, inCollection, pricedIn, viewProduct } from "./model";

export const SORTS = ["featured", "newest", "price-low", "price-high", "best-selling"] as const;
export type SortKey = (typeof SORTS)[number];

export interface ProductFilters {
  category: string[];
  color: string[];
  material: string[];
  size: string[];
  pattern: string[];
  collection: string[];
  availability: string[];
  minPrice?: number;
  maxPrice?: number;
}

/**
 * Published products. With a currency, only those that have a price in it:
 * a product without an international price is not offered outside India.
 */
export function publishedViews(catalog: Catalog, currency?: Currency): ProductView[] {
  return catalog.products
    .filter((row) => row.status === "PUBLISHED" && (!currency || pricedIn(row, currency)))
    .map((row) => viewProduct(catalog, row));
}

/** Price in major units of `currency` (callers only pass views priced in it). */
const priceOf = (view: ProductView, currency: Currency) => (basePrice(view.row, currency) ?? 0) / 100;

export function matchesSearch(view: ProductView, term: string): boolean {
  const needle = term.toLowerCase();
  const haystack = [
    view.row.name,
    view.row.slug,
    view.details.tagline,
    view.details.description,
    view.category?.name,
    view.material?.name,
    view.pattern?.name,
    view.details.craft,
    ...view.colors.map((color) => color.name),
    ...view.variants.map((variant) => variant.sku),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return needle.split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

export function applyFilters(views: ProductView[], filters: ProductFilters, catalog: Catalog, currency: Currency = "INR"): ProductView[] {
  const collectionIds = new Set(
    [...catalog.collections.values()].filter((collection) => filters.collection.includes(collection.slug)).map((collection) => collection.id),
  );
  const includeOutOfStock = filters.availability.includes("out-of-stock");
  const price = (view: ProductView) => priceOf(view, currency);

  return views.filter((view) => {
    if (filters.category.length && !filters.category.includes(view.category?.slug ?? "")) return false;
    if (filters.material.length && !filters.material.includes(view.material?.slug ?? "")) return false;
    if (filters.pattern.length && !filters.pattern.includes(view.pattern?.slug ?? "")) return false;
    if (filters.color.length && !view.colors.some((color) => filters.color.includes(color.slug))) return false;
    if (filters.size.length && !view.sizes.some((size) => filters.size.includes(size.slug))) return false;
    if (filters.collection.length && !view.collectionIds.some((id) => collectionIds.has(id))) return false;
    if (!includeOutOfStock && view.inventory <= 0) return false;
    if (filters.minPrice !== undefined && price(view) < filters.minPrice) return false;
    if (filters.maxPrice !== undefined && price(view) > filters.maxPrice) return false;
    return true;
  });
}

export function inCollectionScope(views: ProductView[], collection: CollectionRow): ProductView[] {
  return views.filter((view) => inCollection(view, collection));
}

const byName = (a: ProductView, b: ProductView) => a.row.name.localeCompare(b.row.name);
const published = (view: ProductView) => Date.parse((view.row.published_at ?? view.row.created_at).replace(" ", "T")) || 0;

export function sortViews(views: ProductView[], sort: SortKey, currency: Currency = "INR"): ProductView[] {
  const sorted = [...views];
  const price = (view: ProductView) => priceOf(view, currency);
  switch (sort) {
    case "newest":
      return sorted.sort((a, b) => published(b) - published(a) || byName(a, b));
    case "price-low":
      return sorted.sort((a, b) => price(a) - price(b) || byName(a, b));
    case "price-high":
      return sorted.sort((a, b) => price(b) - price(a) || byName(a, b));
    case "best-selling":
      return sorted.sort((a, b) => b.row.sold_count - a.row.sold_count || b.row.popularity - a.row.popularity || byName(a, b));
    case "featured":
    default:
      return sorted.sort((a, b) => b.featuredScore - a.featuredScore || b.row.popularity - a.row.popularity || byName(a, b));
  }
}

interface FacetOption {
  label: string;
  value: string;
  count: number;
  hex?: string;
}

/** Counts from the scope (collection/search), not the filtered result, so alternatives stay visible. */
export function buildFacets(scope: ProductView[], catalog: Catalog, currency: Currency = "INR") {
  const tally = new Map<string, Map<string, FacetOption>>();
  const add = (group: string, value: string | undefined, label: string | undefined, hex?: string | null) => {
    if (!value || !label) return;
    if (!tally.has(group)) tally.set(group, new Map());
    const bucket = tally.get(group)!;
    const existing = bucket.get(value);
    if (existing) existing.count += 1;
    else bucket.set(value, { value, label, count: 1, ...(hex ? { hex } : {}) });
  };

  let inStock = 0;
  let outOfStock = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const view of scope) {
    const price = priceOf(view, currency);
    min = Math.min(min, price);
    max = Math.max(max, price);
    add("category", view.category?.slug, view.category?.name);
    add("material", view.material?.slug, view.material?.name);
    add("pattern", view.pattern?.slug, view.pattern?.name);
    for (const color of view.colors) add("color", color.slug, color.name, color.hex);
    for (const size of view.sizes) add("size", size.slug, size.name);
    for (const id of view.collectionIds) {
      const collection = catalog.collections.get(id);
      if (collection?.is_active === 1) add("collection", collection.slug, collection.name);
    }
    if (view.inventory > 0) inStock += 1;
    else outOfStock += 1;
  }

  const options = (group: string) =>
    [...(tally.get(group)?.values() ?? [])].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    category: options("category"),
    color: options("color"),
    material: options("material"),
    size: options("size"),
    pattern: options("pattern"),
    collection: options("collection"),
    availability: [
      { label: "In Stock", value: "in-stock", count: inStock },
      { label: "Include Out of Stock", value: "out-of-stock", count: outOfStock },
    ],
    priceRange: { min: Number.isFinite(min) ? min : 0, max },
    currency,
  };
}
