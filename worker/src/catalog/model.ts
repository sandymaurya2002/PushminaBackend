import { asRecord, asStringArray, parseJson, placeholders, toIso, toRupees } from "../lib/util";

export const BADGES = ["NEW", "BESTSELLER", "LIMITED", "HANDCRAFTED", "EXCLUSIVE"] as const;
export const GENDERS = ["WOMEN", "MEN", "UNISEX"] as const;
export const COLLECTION_GROUPS = ["WOMEN", "MEN", "COLLECTIONS", "GIFTING", "CATEGORY"] as const;
export const BADGE_WEIGHT: Record<string, number> = { EXCLUSIVE: 24, LIMITED: 16, BESTSELLER: 12, NEW: 8, HANDCRAFTED: 0 };

export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  price_paise: number;
  stock: number;
  product_json: string;
  category_id: string | null;
  compare_at_price_paise: number | null;
  cost_price_paise: number | null;
  published_at: string | null;
  low_stock_threshold: number;
  popularity: number;
  sold_count: number;
  created_at: string;
  updated_at: string;
}

export interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  color_id: string | null;
  size_id: string | null;
  price_paise: number | null;
  compare_at_price_paise: number | null;
  stock: number;
  is_active: number;
  sort_order: number;
}

export interface ImageRow {
  id: string;
  product_id: string;
  media_id: string | null;
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  is_primary: number;
  sort_order: number;
}

export interface TermRow {
  id: string;
  kind: "color" | "size" | "material" | "pattern";
  slug: string;
  name: string;
  hex: string | null;
  measurement: string | null;
  sort_order: number;
  is_active: number;
}

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  gender: string | null;
  image_url: string | null;
  sort_order: number;
  is_active: number;
}

export interface CollectionRow {
  id: string;
  slug: string;
  name: string;
  collection_json: string;
  is_active: number;
  sort_order: number;
  updated_at: string;
}

export interface ProductDetails {
  tagline: string;
  description: string;
  story: string[];
  gender: (typeof GENDERS)[number];
  materialId: string | null;
  patternId: string | null;
  craft: string;
  colorIds: string[];
  sizeIds: string[];
  badges: string[];
  specifications: Array<{ label: string; value: string }>;
  careInstructions: string[];
  countryOfOrigin: string;
  faqs: Array<{ question: string; answer: string }>;
  relatedProductIds: string[];
  isFeatured: boolean;
  isTrending: boolean;
  isNewArrival: boolean;
  railOrder: { trending?: number; featured?: number; newArrival?: number };
  rating?: { average: number; count: number };
}

export interface CollectionDetails {
  heading: string | null;
  description: string;
  seoContent: string[];
  group: (typeof COLLECTION_GROUPS)[number];
  bannerUrl: string | null;
  bannerAlt: string | null;
  includeCategoryIds: string[];
  relatedCollectionIds: string[];
  faqs: Array<{ question: string; answer: string }>;
  hidden: boolean;
  featured: boolean;
}

function pairs<K extends string>(value: unknown, a: K, b: K): Array<Record<K, string>> {
  return (Array.isArray(value) ? value : [])
    .map(asRecord)
    .filter((entry) => typeof entry[a] === "string" && typeof entry[b] === "string" && entry[a] && entry[b])
    .map((entry) => ({ [a]: entry[a], [b]: entry[b] }) as Record<K, string>);
}

export function readProductDetails(json: string): ProductDetails {
  const raw = asRecord(parseJson(json, {}));
  const gender = String(raw.gender ?? "UNISEX").toUpperCase();
  const rating = asRecord(raw.rating);
  return {
    tagline: String(raw.tagline ?? ""),
    description: String(raw.description ?? ""),
    story: asStringArray(raw.story),
    gender: (GENDERS as readonly string[]).includes(gender) ? (gender as ProductDetails["gender"]) : "UNISEX",
    materialId: typeof raw.materialId === "string" ? raw.materialId : null,
    patternId: typeof raw.patternId === "string" ? raw.patternId : null,
    craft: String(raw.craft ?? ""),
    colorIds: asStringArray(raw.colorIds),
    sizeIds: asStringArray(raw.sizeIds),
    badges: asStringArray(raw.badges).map((badge) => badge.toUpperCase()).filter((badge) => (BADGES as readonly string[]).includes(badge)),
    specifications: pairs(raw.specifications, "label", "value"),
    careInstructions: asStringArray(raw.careInstructions),
    countryOfOrigin: String(raw.countryOfOrigin ?? "India") || "India",
    faqs: pairs(raw.faqs, "question", "answer"),
    relatedProductIds: asStringArray(raw.relatedProductIds),
    isFeatured: raw.isFeatured === true,
    isTrending: raw.isTrending === true,
    isNewArrival: raw.isNewArrival === true,
    railOrder: {
      ...(typeof raw.trendingOrder === "number" ? { trending: raw.trendingOrder } : {}),
      ...(typeof raw.featuredOrder === "number" ? { featured: raw.featuredOrder } : {}),
      ...(typeof raw.newArrivalOrder === "number" ? { newArrival: raw.newArrivalOrder } : {}),
    },
    ...(Number(rating.count) > 0 && Number(rating.average) > 0 ? { rating: { average: Number(rating.average), count: Number(rating.count) } } : {}),
  };
}

export function readCollectionDetails(json: string): CollectionDetails {
  const raw = asRecord(parseJson(json, {}));
  const group = String(raw.group ?? "COLLECTIONS").toUpperCase();
  return {
    heading: typeof raw.heading === "string" && raw.heading ? raw.heading : null,
    description: String(raw.description ?? ""),
    seoContent: asStringArray(raw.seoContent),
    group: (COLLECTION_GROUPS as readonly string[]).includes(group) ? (group as CollectionDetails["group"]) : "COLLECTIONS",
    bannerUrl: typeof raw.bannerUrl === "string" && raw.bannerUrl ? raw.bannerUrl : null,
    bannerAlt: typeof raw.bannerAlt === "string" && raw.bannerAlt ? raw.bannerAlt : null,
    includeCategoryIds: asStringArray(raw.includeCategoryIds),
    relatedCollectionIds: asStringArray(raw.relatedCollectionIds),
    faqs: pairs(raw.faqs, "question", "answer"),
    hidden: raw.hidden === true,
    featured: raw.featured === true,
  };
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

export interface Catalog {
  products: ProductRow[];
  variants: Map<string, VariantRow[]>;
  images: Map<string, ImageRow[]>;
  links: Map<string, Array<{ collection_id: string; sort_order: number }>>;
  terms: Map<string, TermRow>;
  categories: Map<string, CategoryRow>;
  collections: Map<string, CollectionRow>;
}

function group<T, K extends keyof T>(rows: T[], key: K): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const id = String(row[key]);
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push(row);
  }
  return map;
}

export interface LoadOptions {
  /** Only PUBLISHED products (storefront). */
  publishedOnly?: boolean;
  productIds?: string[];
}

/** Loads products plus every related row in one D1 round trip. */
export async function loadCatalog(db: D1Database, options: LoadOptions = {}): Promise<Catalog> {
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (options.publishedOnly) filters.push(`p.status = 'PUBLISHED'`);
  if (options.productIds) {
    if (!options.productIds.length) filters.push("0");
    else {
      filters.push(`p.id IN (${placeholders(options.productIds.length)})`);
      binds.push(...options.productIds);
    }
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const scope = `SELECT p.id FROM products p ${where}`;

  const [products, variants, images, links, terms, categories, collections] = await db.batch([
    db.prepare(`SELECT p.* FROM products p ${where}`).bind(...binds),
    db.prepare(`SELECT * FROM product_variants WHERE product_id IN (${scope}) ORDER BY sort_order, created_at`).bind(...binds),
    db.prepare(`SELECT * FROM product_images WHERE product_id IN (${scope}) ORDER BY is_primary DESC, sort_order, created_at`).bind(...binds),
    db.prepare(`SELECT * FROM product_collections WHERE product_id IN (${scope})`).bind(...binds),
    db.prepare(`SELECT * FROM taxonomy_terms ORDER BY sort_order, name`),
    db.prepare(`SELECT * FROM categories ORDER BY sort_order, name`),
    db.prepare(`SELECT * FROM collections ORDER BY sort_order, name`),
  ]);

  return {
    products: (products?.results ?? []) as unknown as ProductRow[],
    variants: group((variants?.results ?? []) as unknown as VariantRow[], "product_id"),
    images: group((images?.results ?? []) as unknown as ImageRow[], "product_id"),
    links: group((links?.results ?? []) as unknown as Array<{ product_id: string; collection_id: string; sort_order: number }>, "product_id"),
    terms: new Map(((terms?.results ?? []) as unknown as TermRow[]).map((row) => [row.id, row])),
    categories: new Map(((categories?.results ?? []) as unknown as CategoryRow[]).map((row) => [row.id, row])),
    collections: new Map(((collections?.results ?? []) as unknown as CollectionRow[]).map((row) => [row.id, row])),
  };
}

/* ------------------------------------------------------------------ *
 * Mapping
 * ------------------------------------------------------------------ */

export type MediaResolver = (url: string | null | undefined) => string;

export function mediaResolver(base: string): MediaResolver {
  return (url) => {
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith("/media/")) return `${base}${url}`;
    return url;
  };
}

export interface ProductView {
  row: ProductRow;
  details: ProductDetails;
  variants: VariantRow[];
  activeVariants: VariantRow[];
  images: ImageRow[];
  category: CategoryRow | null;
  material: TermRow | null;
  pattern: TermRow | null;
  colors: TermRow[];
  sizes: TermRow[];
  collectionIds: string[];
  inventory: number;
  featuredScore: number;
}

export function viewProduct(catalog: Catalog, row: ProductRow): ProductView {
  const details = readProductDetails(row.product_json);
  const variants = catalog.variants.get(row.id) ?? [];
  const activeVariants = variants.filter((variant) => variant.is_active === 1);
  const term = (id: string | null, kind: TermRow["kind"]) => {
    const found = id ? catalog.terms.get(id) : undefined;
    return found && found.kind === kind ? found : null;
  };
  const termsFor = (ids: string[], kind: TermRow["kind"]) =>
    ids.map((id) => term(id, kind)).filter((entry): entry is TermRow => Boolean(entry));

  // Colours and sizes come from the explicit lists plus whatever active variants use.
  const colorIds = [...new Set([...details.colorIds, ...activeVariants.map((variant) => variant.color_id).filter((id): id is string => Boolean(id))])];
  const sizeIds = [...new Set([...details.sizeIds, ...activeVariants.map((variant) => variant.size_id).filter((id): id is string => Boolean(id))])];

  const inventory = variants.length ? activeVariants.reduce((sum, variant) => sum + variant.stock, 0) : row.stock;
  const featuredScore = details.badges.reduce((total, badge) => total + (BADGE_WEIGHT[badge] ?? 0), row.popularity) + (details.isFeatured ? 1000 : 0);

  return {
    row,
    details,
    variants,
    activeVariants,
    images: catalog.images.get(row.id) ?? [],
    category: row.category_id ? catalog.categories.get(row.category_id) ?? null : null,
    material: term(details.materialId, "material"),
    pattern: term(details.patternId, "pattern"),
    colors: termsFor(colorIds, "color"),
    sizes: termsFor(sizeIds, "size"),
    collectionIds: (catalog.links.get(row.id) ?? []).map((link) => link.collection_id),
    inventory,
    featuredScore,
  };
}

function imageDto(image: ImageRow, resolve: MediaResolver, fallbackAlt: string) {
  return {
    url: resolve(image.url),
    alt: image.alt || fallbackAlt,
    width: image.width ?? 1200,
    height: image.height ?? 1500,
    ...(image.is_primary ? { isPrimary: true } : {}),
  };
}

function variantDto(view: ProductView, variant: VariantRow, catalog: Catalog) {
  const price = variant.price_paise ?? view.row.price_paise;
  const compare = variant.compare_at_price_paise ?? view.row.compare_at_price_paise;
  return {
    id: variant.id,
    sku: variant.sku,
    colorSlug: variant.color_id ? catalog.terms.get(variant.color_id)?.slug : undefined,
    sizeSlug: variant.size_id ? catalog.terms.get(variant.size_id)?.slug : undefined,
    price: toRupees(price),
    compareAtPrice: compare && compare > price ? toRupees(compare) : undefined,
    inventory: Math.max(0, variant.stock),
  };
}

/** Storefront shape, matching the Next.js `Product` type. Never includes cost price or drafts. */
export function publicProduct(view: ProductView, catalog: Catalog, resolve: MediaResolver, mode: "full" | "card" = "full") {
  const { row, details } = view;
  const collectionSlugs = view.collectionIds
    .map((id) => catalog.collections.get(id))
    .filter((collection): collection is CollectionRow => Boolean(collection && collection.is_active === 1))
    .map((collection) => collection.slug);
  const images = view.images.map((image) => imageDto(image, resolve, row.name));
  const relatedSlugs = details.relatedProductIds
    .map((id) => catalog.products.find((product) => product.id === id))
    .filter((product): product is ProductRow => Boolean(product && product.status === "PUBLISHED"))
    .map((product) => product.slug);

  const base = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: details.tagline,
    gender: details.gender.toLowerCase(),
    categorySlug: view.category?.slug ?? "",
    categoryName: view.category?.name,
    collectionSlugs,
    material: view.material?.name ?? "",
    materialSlug: view.material?.slug ?? "",
    pattern: view.pattern?.name ?? "",
    patternSlug: view.pattern?.slug ?? "",
    price: toRupees(row.price_paise),
    compareAtPrice: row.compare_at_price_paise && row.compare_at_price_paise > row.price_paise ? toRupees(row.compare_at_price_paise) : undefined,
    currency: "INR",
    images: mode === "card" ? images.slice(0, 2) : images,
    colors: view.colors.map((color) => ({ name: color.name, slug: color.slug, hex: color.hex ?? "#d8c7ae" })),
    sizes: view.sizes.map((size) => ({ name: size.name, slug: size.slug, ...(size.measurement ? { measurement: size.measurement } : {}) })),
    variants: view.activeVariants.map((variant) => variantDto(view, variant, catalog)),
    inventory: Math.max(0, view.inventory),
    badges: details.badges.map((badge) => badge.toLowerCase()),
    publishedAt: (toIso(row.published_at) ?? toIso(row.created_at) ?? "").slice(0, 10),
    popularity: row.popularity,
    ...(details.rating ? { rating: details.rating } : {}),
  };
  if (mode === "card") return base;
  return {
    ...base,
    description: details.description,
    story: details.story,
    craft: details.craft,
    specifications: details.specifications,
    careInstructions: details.careInstructions,
    countryOfOrigin: details.countryOfOrigin,
    faqs: details.faqs,
    relatedSlugs,
  };
}

export function stockState(view: ProductView): "in" | "low" | "out" {
  if (view.inventory <= 0) return "out";
  if (view.inventory <= view.row.low_stock_threshold) return "low";
  return "in";
}

/** Admin shape: storefront DTO plus merchandising flags and the editable `raw` record. */
export function adminProduct(view: ProductView, catalog: Catalog, resolve: MediaResolver) {
  const { row, details } = view;
  return {
    ...publicProduct(view, catalog, resolve, "full"),
    status: row.status,
    isFeatured: details.isFeatured,
    isTrending: details.isTrending,
    isNewArrival: details.isNewArrival,
    stockState: stockState(view),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    raw: {
      status: row.status,
      gender: details.gender,
      categoryId: row.category_id,
      materialId: details.materialId,
      patternId: details.patternId,
      colorIds: details.colorIds,
      sizeIds: details.sizeIds,
      collectionIds: view.collectionIds,
      badges: details.badges,
      relatedProductIds: details.relatedProductIds,
      costPrice: row.cost_price_paise === null ? null : toRupees(row.cost_price_paise),
      lowStockThreshold: row.low_stock_threshold,
      stock: row.stock,
      soldCount: row.sold_count,
      images: view.images.map((image) => ({
        id: image.id,
        mediaId: image.media_id,
        url: image.url,
        previewUrl: resolve(image.url),
        alt: image.alt,
        width: image.width ?? 1200,
        height: image.height ?? 1500,
        isPrimary: image.is_primary === 1,
      })),
      variants: view.variants.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        colorId: variant.color_id,
        sizeId: variant.size_id,
        price: toRupees(variant.price_paise ?? row.price_paise),
        compareAtPrice: variant.compare_at_price_paise === null ? null : toRupees(variant.compare_at_price_paise),
        inventory: variant.stock,
        isActive: variant.is_active === 1,
      })),
    },
  };
}

export function adminProductRow(view: ProductView, resolve: MediaResolver) {
  const primary = view.images[0];
  return {
    id: view.row.id,
    slug: view.row.slug,
    name: view.row.name,
    status: view.row.status,
    price: toRupees(view.row.price_paise),
    compareAtPrice: view.row.compare_at_price_paise === null ? null : toRupees(view.row.compare_at_price_paise),
    inventory: view.inventory,
    variantCount: view.variants.length,
    stockState: stockState(view),
    isFeatured: view.details.isFeatured,
    isTrending: view.details.isTrending,
    isNewArrival: view.details.isNewArrival,
    category: { id: view.category?.id ?? "", name: view.category?.name ?? "—" },
    material: { id: view.material?.id ?? "", name: view.material?.name ?? "—" },
    image: primary ? { url: resolve(primary.url), alt: primary.alt || view.row.name } : null,
    _count: { reviews: 0, orderItems: view.row.sold_count },
    updatedAt: toIso(view.row.updated_at),
  };
}

export function publicCollection(row: CollectionRow, catalog: Catalog, resolve: MediaResolver, productCount?: number) {
  const details = readCollectionDetails(row.collection_json);
  return {
    slug: row.slug,
    name: row.name,
    heading: details.heading ?? undefined,
    description: details.description,
    seoContent: details.seoContent,
    group: details.group.toLowerCase(),
    bannerImage: {
      url: resolve(details.bannerUrl),
      alt: details.bannerAlt ?? `${row.name} collection`,
      width: 1800,
      height: 620,
    },
    includeCategorySlugs: details.includeCategoryIds.map((id) => catalog.categories.get(id)?.slug).filter(Boolean),
    relatedSlugs: details.relatedCollectionIds
      .map((id) => catalog.collections.get(id))
      .filter((collection) => collection && collection.is_active === 1)
      .map((collection) => collection!.slug),
    faqs: details.faqs,
    hidden: details.hidden,
    featured: details.featured,
    ...(productCount !== undefined ? { productCount } : {}),
  };
}

/** Membership rule: linked directly, or the product's category is aggregated by the collection. */
export function inCollection(view: ProductView, collection: CollectionRow): boolean {
  if (view.collectionIds.includes(collection.id)) return true;
  const details = readCollectionDetails(collection.collection_json);
  return Boolean(view.row.category_id && details.includeCategoryIds.includes(view.row.category_id));
}
