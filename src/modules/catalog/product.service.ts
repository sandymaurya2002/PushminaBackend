import { Prisma, type ProductBadge } from '@prisma/client'
import { prisma } from '../../db/prisma'
import {
  productInclude,
  toProductCardDto,
  toProductDto,
  type ProductWithRelations,
} from './catalog.dto'
import { toNumber } from '../../utils/money'
import { NotFoundError } from '../../utils/errors'

/**
 * Catalogue querying.
 *
 * This is the backend counterpart of the website's own src/services/catalog.ts
 * and reproduces its behaviour exactly — the same filter semantics, the same
 * five sorts, and facet counts computed against the collection scope rather
 * than the filtered result, so counts never collapse to zero as a customer
 * narrows down.
 */

export type SortKey = 'featured' | 'newest' | 'price-low' | 'price-high' | 'best-selling'

export interface ProductFilters {
  category: string[]
  color: string[]
  material: string[]
  size: string[]
  pattern: string[]
  collection: string[]
  availability: string[]
  minPrice?: number
  maxPrice?: number
}

export const EMPTY_FILTERS: ProductFilters = {
  category: [],
  color: [],
  material: [],
  size: [],
  pattern: [],
  collection: [],
  availability: [],
}

const BADGE_WEIGHT: Record<ProductBadge, number> = {
  EXCLUSIVE: 24,
  LIMITED: 16,
  BESTSELLER: 12,
  NEW: 8,
  HANDCRAFTED: 0,
}

/** Recalculates and persists the denormalised Featured ranking. */
export async function recomputeFeaturedScore(
  productId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<number> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { popularity: true, badges: { select: { badge: true } } },
  })
  if (!product) return 0

  const score = product.badges.reduce(
    (total, entry) => total + (BADGE_WEIGHT[entry.badge] ?? 0),
    product.popularity,
  )

  await tx.product.update({ where: { id: productId }, data: { featuredScore: score } })
  return score
}

/* ------------------------------------------------------------------ *
 * WHERE construction
 * ------------------------------------------------------------------ */

/** Only published products are ever visible to the storefront. */
const PUBLISHED: Prisma.ProductWhereInput = { status: 'PUBLISHED' }

function buildFilterWhere(filters: ProductFilters): Prisma.ProductWhereInput[] {
  const clauses: Prisma.ProductWhereInput[] = []

  if (filters.category.length) clauses.push({ category: { slug: { in: filters.category } } })
  if (filters.material.length) clauses.push({ material: { slug: { in: filters.material } } })
  if (filters.pattern.length) clauses.push({ pattern: { slug: { in: filters.pattern } } })

  if (filters.collection.length) {
    clauses.push({ collections: { some: { collection: { slug: { in: filters.collection } } } } })
  }
  if (filters.color.length) {
    clauses.push({ colors: { some: { color: { slug: { in: filters.color } } } } })
  }
  if (filters.size.length) {
    clauses.push({ sizes: { some: { size: { slug: { in: filters.size } } } } })
  }

  // Mirrors the storefront: sold-out lines are hidden unless "Include out of
  // stock" is ticked, and ticking "In stock" alone hides them explicitly.
  const includeOutOfStock = filters.availability.includes('out-of-stock')
  if (!includeOutOfStock) {
    clauses.push({ variants: { some: { isActive: true, inventory: { gt: 0 } } } })
  }

  if (filters.minPrice !== undefined) clauses.push({ price: { gte: filters.minPrice } })
  if (filters.maxPrice !== undefined) clauses.push({ price: { lte: filters.maxPrice } })

  return clauses
}

/**
 * Resolves a collection to its membership rule: products that name it directly,
 * plus every product whose primary category the collection aggregates.
 */
async function collectionScopeWhere(slug: string): Promise<Prisma.ProductWhereInput | null> {
  const collection = await prisma.collection.findUnique({
    where: { slug },
    select: { id: true, includeCategories: { select: { categoryId: true } } },
  })
  if (!collection) return null

  const categoryIds = collection.includeCategories.map((entry) => entry.categoryId)

  return {
    OR: [
      { collections: { some: { collectionId: collection.id } } },
      ...(categoryIds.length ? [{ categoryId: { in: categoryIds } }] : []),
    ],
  }
}

function buildOrderBy(sort: SortKey): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case 'newest':
      return [{ publishedAt: 'desc' }, { createdAt: 'desc' }]
    case 'price-low':
      return [{ price: 'asc' }, { name: 'asc' }]
    case 'price-high':
      return [{ price: 'desc' }, { name: 'asc' }]
    case 'best-selling':
      return [{ popularity: 'desc' }, { name: 'asc' }]
    case 'featured':
    default:
      return [{ featuredScore: 'desc' }, { popularity: 'desc' }, { name: 'asc' }]
  }
}

/* ------------------------------------------------------------------ *
 * Facets
 * ------------------------------------------------------------------ */

export interface FilterOption {
  label: string
  value: string
  count: number
  hex?: string
}

export interface FilterFacets {
  category: FilterOption[]
  color: FilterOption[]
  material: FilterOption[]
  size: FilterOption[]
  pattern: FilterOption[]
  collection: FilterOption[]
  availability: FilterOption[]
  priceRange: { min: number; max: number }
}

/**
 * Facet counts for a scope.
 *
 * Deliberately computed from the *scope* (the collection, or the whole
 * catalogue) and not from the filtered result set, so a customer who selects
 * "Ivory" still sees how many Cream pieces they could switch to.
 */
async function buildFacets(scope: Prisma.ProductWhereInput): Promise<FilterFacets> {
  const products = await prisma.product.findMany({
    where: scope,
    select: {
      price: true,
      category: { select: { slug: true, name: true } },
      material: { select: { slug: true, name: true } },
      pattern: { select: { slug: true, name: true } },
      colors: { select: { color: { select: { slug: true, name: true, hex: true } } } },
      sizes: { select: { size: { select: { slug: true, name: true } } } },
      collections: { select: { collection: { select: { slug: true, name: true } } } },
      variants: { where: { isActive: true }, select: { inventory: true } },
    },
  })

  const tally = new Map<string, Map<string, { label: string; count: number; hex?: string }>>()

  const add = (group: string, value: string, label: string, hex?: string) => {
    if (!tally.has(group)) tally.set(group, new Map())
    const bucket = tally.get(group)!
    const existing = bucket.get(value)
    if (existing) existing.count += 1
    else bucket.set(value, { label, count: 1, hex })
  }

  let inStock = 0
  let outOfStock = 0
  let min = Number.POSITIVE_INFINITY
  let max = 0

  for (const product of products) {
    const price = toNumber(product.price)
    if (price < min) min = price
    if (price > max) max = price

    add('category', product.category.slug, product.category.name)
    add('material', product.material.slug, product.material.name)
    add('pattern', product.pattern.slug, product.pattern.name)

    // De-duplicated per product: a product with three ivory variants must count
    // once towards "Ivory", not three times.
    for (const slug of new Set(product.colors.map((entry) => entry.color.slug))) {
      const color = product.colors.find((entry) => entry.color.slug === slug)!.color
      add('color', color.slug, color.name, color.hex)
    }
    for (const slug of new Set(product.sizes.map((entry) => entry.size.slug))) {
      const size = product.sizes.find((entry) => entry.size.slug === slug)!.size
      add('size', size.slug, size.name)
    }
    for (const entry of product.collections) {
      add('collection', entry.collection.slug, entry.collection.name)
    }

    const total = product.variants.reduce((sum, variant) => sum + variant.inventory, 0)
    if (total > 0) inStock += 1
    else outOfStock += 1
  }

  const toOptions = (group: string): FilterOption[] =>
    Array.from(tally.get(group)?.entries() ?? [])
      .map(([value, entry]) => ({
        value,
        label: entry.label,
        count: entry.count,
        ...(entry.hex ? { hex: entry.hex } : {}),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  return {
    category: toOptions('category'),
    color: toOptions('color'),
    material: toOptions('material'),
    size: toOptions('size'),
    pattern: toOptions('pattern'),
    collection: toOptions('collection'),
    availability: [
      { label: 'In Stock', value: 'in-stock', count: inStock },
      { label: 'Include Out of Stock', value: 'out-of-stock', count: outOfStock },
    ],
    priceRange: {
      min: Number.isFinite(min) ? min : 0,
      max,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Public queries
 * ------------------------------------------------------------------ */

export interface QueryOptions {
  collectionSlug?: string
  filters?: ProductFilters
  sort?: SortKey
  search?: string
  page?: number
  limit?: number
  includeFacets?: boolean
}

export async function queryProducts(options: QueryOptions = {}) {
  const {
    collectionSlug,
    filters = EMPTY_FILTERS,
    sort = 'featured',
    search,
    page = 1,
    limit = 24,
    includeFacets = true,
  } = options

  const scopeClauses: Prisma.ProductWhereInput[] = [PUBLISHED]

  if (collectionSlug) {
    const scope = await collectionScopeWhere(collectionSlug)
    // An unknown collection must yield nothing, not the entire catalogue.
    if (!scope) {
      return {
        products: [],
        total: 0,
        facets: await buildFacets({ id: '__none__' }),
      }
    }
    scopeClauses.push(scope)
  }

  if (search?.trim()) {
    scopeClauses.push(buildSearchWhere(search.trim()))
  }

  const scopeWhere: Prisma.ProductWhereInput = { AND: scopeClauses }
  const where: Prisma.ProductWhereInput = {
    AND: [...scopeClauses, ...buildFilterWhere(filters)],
  }

  const [rows, total, facets] = await Promise.all([
    prisma.product.findMany({
      where,
      include: productInclude,
      orderBy: buildOrderBy(sort),
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.product.count({ where }),
    includeFacets ? buildFacets(scopeWhere) : Promise.resolve(null),
  ])

  return {
    products: (rows as ProductWithRelations[]).map(toProductCardDto),
    total,
    facets,
  }
}

export async function getProductBySlug(slug: string) {
  const product = await prisma.product.findFirst({
    where: { slug, status: 'PUBLISHED' },
    include: productInclude,
  })
  if (!product) throw new NotFoundError('Product')
  return toProductDto(product as ProductWithRelations)
}

export async function getProductsBySlugs(slugs: string[]) {
  if (slugs.length === 0) return []

  const rows = await prisma.product.findMany({
    where: { slug: { in: slugs }, status: 'PUBLISHED' },
    include: productInclude,
  })

  // Preserve the caller's ordering — "recently viewed" is ordered data.
  const bySlug = new Map(rows.map((row) => [row.slug, row]))
  return slugs
    .map((slug) => bySlug.get(slug))
    .filter((row): row is (typeof rows)[number] => Boolean(row))
    .map((row) => toProductCardDto(row as ProductWithRelations))
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function buildSearchWhere(term: string): Prisma.ProductWhereInput {
  const tokens = term.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)

  // Every token must match somewhere (AND of ORs), which is what makes
  // "ivory pashmina" narrower than either word alone.
  return {
    AND: tokens.map((token) => ({
      OR: [
        { name: { contains: token, mode: 'insensitive' as const } },
        { tagline: { contains: token, mode: 'insensitive' as const } },
        { description: { contains: token, mode: 'insensitive' as const } },
        { craft: { contains: token, mode: 'insensitive' as const } },
        { material: { name: { contains: token, mode: 'insensitive' as const } } },
        { pattern: { name: { contains: token, mode: 'insensitive' as const } } },
        { category: { name: { contains: token, mode: 'insensitive' as const } } },
        { colors: { some: { color: { name: { contains: token, mode: 'insensitive' as const } } } } },
        {
          collections: {
            some: { collection: { name: { contains: token, mode: 'insensitive' as const } } },
          },
        },
      ],
    })),
  }
}

/** Instant search for the header overlay: products plus matching collections. */
export async function searchCatalog(term: string, limit = 8) {
  const needle = term.trim()
  if (needle.length < 2) return { products: [], collections: [], total: 0 }

  const where: Prisma.ProductWhereInput = { AND: [PUBLISHED, buildSearchWhere(needle)] }

  const [rows, total, collections] = await Promise.all([
    prisma.product.findMany({
      where,
      include: productInclude,
      // A name match should outrank a description match; featuredScore then
      // breaks ties towards the pieces we actually want to sell.
      orderBy: [{ featuredScore: 'desc' }, { popularity: 'desc' }],
      take: limit,
    }),
    prisma.product.count({ where }),
    prisma.collection.findMany({
      where: {
        isHidden: false,
        OR: [
          { name: { contains: needle, mode: 'insensitive' } },
          { description: { contains: needle, mode: 'insensitive' } },
        ],
      },
      select: { slug: true, name: true },
      take: 4,
    }),
  ])

  const exactFirst = (rows as ProductWithRelations[]).sort((a, b) => {
    const aName = a.name.toLowerCase().includes(needle.toLowerCase()) ? 1 : 0
    const bName = b.name.toLowerCase().includes(needle.toLowerCase()) ? 1 : 0
    return bName - aName
  })

  return {
    products: exactFirst.map(toProductCardDto),
    collections,
    total,
  }
}

/* ------------------------------------------------------------------ *
 * Merchandising
 * ------------------------------------------------------------------ */

async function merchandised(
  flag: 'isFeatured' | 'isTrending' | 'isNewArrival',
  orderField: 'featuredOrder' | 'trendingOrder' | 'newArrivalOrder',
  limit: number,
) {
  const rows = await prisma.product.findMany({
    where: { ...PUBLISHED, [flag]: true },
    include: productInclude,
    orderBy: [{ [orderField]: 'asc' }, { featuredScore: 'desc' }],
    take: limit,
  })
  return (rows as ProductWithRelations[]).map(toProductCardDto)
}

/**
 * Trending, Featured and New Arrivals return exactly what the admin selected
 * and in the order the admin set. If the admin has not curated a list yet, we
 * fall back to a sensible automatic one rather than rendering an empty rail.
 */
export async function getTrending(limit = 8) {
  const curated = await merchandised('isTrending', 'trendingOrder', limit)
  if (curated.length > 0) return curated

  const rows = await prisma.product.findMany({
    where: PUBLISHED,
    include: productInclude,
    orderBy: { popularity: 'desc' },
    take: limit,
  })
  return (rows as ProductWithRelations[]).map(toProductCardDto)
}

export async function getFeatured(limit = 8) {
  const curated = await merchandised('isFeatured', 'featuredOrder', limit)
  if (curated.length > 0) return curated

  const rows = await prisma.product.findMany({
    where: PUBLISHED,
    include: productInclude,
    orderBy: { featuredScore: 'desc' },
    take: limit,
  })
  return (rows as ProductWithRelations[]).map(toProductCardDto)
}

export async function getNewArrivals(limit = 8) {
  const curated = await merchandised('isNewArrival', 'newArrivalOrder', limit)
  if (curated.length > 0) return curated

  const rows = await prisma.product.findMany({
    where: PUBLISHED,
    include: productInclude,
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  })
  return (rows as ProductWithRelations[]).map(toProductCardDto)
}

export async function getBestSellers(limit = 8) {
  const rows = await prisma.product.findMany({
    where: PUBLISHED,
    include: productInclude,
    orderBy: { popularity: 'desc' },
    take: limit,
  })
  return (rows as ProductWithRelations[]).map(toProductCardDto)
}

/**
 * Related products: explicit admin-curated links first, then products that
 * share collections, category or material, scored and ranked.
 */
export async function getRelatedProducts(slug: string, limit = 4) {
  const product = await prisma.product.findFirst({
    where: { slug, status: 'PUBLISHED' },
    select: {
      id: true,
      categoryId: true,
      materialId: true,
      collections: { select: { collectionId: true } },
      relatedFrom: {
        orderBy: { sortOrder: 'asc' },
        select: { target: { select: { slug: true, status: true } } },
      },
    },
  })
  if (!product) throw new NotFoundError('Product')

  const explicitSlugs = product.relatedFrom
    .filter((entry) => entry.target.status === 'PUBLISHED')
    .map((entry) => entry.target.slug)

  const explicit = await getProductsBySlugs(explicitSlugs.slice(0, limit))
  if (explicit.length >= limit) return explicit

  const collectionIds = product.collections.map((entry) => entry.collectionId)

  const candidates = await prisma.product.findMany({
    where: {
      ...PUBLISHED,
      id: { not: product.id },
      slug: { notIn: explicitSlugs },
      OR: [
        { collections: { some: { collectionId: { in: collectionIds } } } },
        { categoryId: product.categoryId },
        { materialId: product.materialId },
      ],
    },
    include: productInclude,
    take: 40,
  })

  const scored = (candidates as ProductWithRelations[])
    .map((candidate) => {
      const shared = candidate.collections.filter((entry) =>
        collectionIds.includes(entry.collectionId),
      ).length
      const sameCategory = candidate.categoryId === product.categoryId ? 3 : 0
      const sameMaterial = candidate.materialId === product.materialId ? 2 : 0
      return { candidate, score: shared + sameCategory + sameMaterial }
    })
    .sort((a, b) => b.score - a.score || b.candidate.popularity - a.candidate.popularity)
    .slice(0, limit - explicit.length)
    .map((entry) => toProductCardDto(entry.candidate))

  return [...explicit, ...scored]
}
