import type { Request, Response } from 'express'
import { prisma } from '../../db/prisma'
import { asyncHandler } from '../../utils/async-handler'
import { ok, paginated } from '../../utils/response'
import { validated } from '../../middleware/validate'
import { NotFoundError } from '../../utils/errors'
import {
  getBestSellers,
  getFeatured,
  getNewArrivals,
  getProductBySlug,
  getProductsBySlugs,
  getRelatedProducts,
  getTrending,
  queryProducts,
  searchCatalog,
  type ProductFilters,
} from './product.service'
import {
  toCategoryDto,
  toCollectionDto,
  toColorDto,
  toSizeDto,
  toTermDto,
  type CollectionWithRelations,
} from './catalog.dto'
import type {
  ProductQueryInput,
  collectionListQuerySchema,
} from './catalog.schema'
import type { z } from 'zod'

/* ------------------------------------------------------------------ *
 * Products
 * ------------------------------------------------------------------ */

export const listProducts = asyncHandler(async (req: Request, res: Response) => {
  const query = validated<ProductQueryInput>(req)

  const filters: ProductFilters = {
    category: query.category,
    color: query.color,
    material: query.material,
    size: query.size,
    pattern: query.pattern,
    collection: query.collection,
    availability: query.availability,
    minPrice: query.minPrice,
    maxPrice: query.maxPrice,
  }

  const result = await queryProducts({
    filters,
    sort: query.sort,
    search: query.q,
    page: query.page,
    limit: query.limit,
    includeFacets: query.facets,
  })

  return paginated(res, result.products, result.total, query.page, query.limit, {
    facets: result.facets,
    sort: query.sort,
  })
})

export const getProduct = asyncHandler(async (req: Request, res: Response) => {
  const product = await getProductBySlug(req.params.slug)
  return ok(res, product)
})

export const getRelated = asyncHandler(async (req: Request, res: Response) => {
  const { limit } = validated<{ limit: number }>(req)
  const products = await getRelatedProducts(req.params.slug, limit ?? 4)
  return ok(res, products)
})

/**
 * Resolves a list of slugs, preserving order.
 *
 * Backs "recently viewed" and the guest wishlist, both of which hold only ids
 * on the client so the catalogue never has to ship to the browser.
 */
export const getProductsBatch = asyncHandler(async (req: Request, res: Response) => {
  const { slugs } = validated<{ slugs: string[] }>(req)
  const products = await getProductsBySlugs(slugs)
  return ok(res, products)
})

export const searchProducts = asyncHandler(async (req: Request, res: Response) => {
  const { q, limit } = validated<{ q: string; limit: number }>(req)
  const result = await searchCatalog(q, limit)
  return ok(res, result)
})

/* ------------------------------------------------------------------ *
 * Merchandised rails
 * ------------------------------------------------------------------ */

export const listTrending = asyncHandler(async (req: Request, res: Response) => {
  const { limit } = validated<{ limit: number }>(req)
  return ok(res, await getTrending(limit))
})

export const listFeatured = asyncHandler(async (req: Request, res: Response) => {
  const { limit } = validated<{ limit: number }>(req)
  return ok(res, await getFeatured(limit))
})

export const listNewArrivals = asyncHandler(async (req: Request, res: Response) => {
  const { limit } = validated<{ limit: number }>(req)
  return ok(res, await getNewArrivals(limit))
})

export const listBestSellers = asyncHandler(async (req: Request, res: Response) => {
  const { limit } = validated<{ limit: number }>(req)
  return ok(res, await getBestSellers(limit))
})

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

export const listCategories = asyncHandler(async (_req: Request, res: Response) => {
  const categories = await prisma.category.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { products: { where: { status: 'PUBLISHED' } } } } },
  })
  return ok(res, categories.map(toCategoryDto))
})

export const getCategory = asyncHandler(async (req: Request, res: Response) => {
  const category = await prisma.category.findFirst({
    where: { slug: req.params.slug, isActive: true },
    include: { _count: { select: { products: { where: { status: 'PUBLISHED' } } } } },
  })
  if (!category) throw new NotFoundError('Category')
  return ok(res, toCategoryDto(category))
})

/* ------------------------------------------------------------------ *
 * Collections
 * ------------------------------------------------------------------ */

const collectionInclude = {
  includeCategories: { include: { category: { select: { slug: true } } } },
  relatedFrom: {
    include: { target: { select: { slug: true } } },
    orderBy: { sortOrder: 'asc' as const },
  },
  faqs: { orderBy: { sortOrder: 'asc' as const } },
}

export const listCollections = asyncHandler(async (req: Request, res: Response) => {
  const query = validated<z.infer<typeof collectionListQuerySchema>>(req)

  const collections = await prisma.collection.findMany({
    where: {
      ...(query.includeHidden ? {} : { isHidden: false }),
      ...(query.group ? { group: query.group.toUpperCase() as never } : {}),
      ...(query.featured !== undefined ? { isFeatured: query.featured } : {}),
    },
    include: collectionInclude,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })

  // Counts respect each collection's own membership rule, including the
  // aggregate "pull in every product in these categories" behaviour.
  const withCounts = await Promise.all(
    collections.map(async (collection) => {
      const categoryIds = collection.includeCategories.map((entry) => entry.categoryId)
      const count = await prisma.product.count({
        where: {
          status: 'PUBLISHED',
          OR: [
            { collections: { some: { collectionId: collection.id } } },
            ...(categoryIds.length ? [{ categoryId: { in: categoryIds } }] : []),
          ],
        },
      })
      return toCollectionDto({
        ...(collection as unknown as CollectionWithRelations),
        _count: { products: count },
      })
    }),
  )

  return ok(res, withCounts)
})

export const getCollection = asyncHandler(async (req: Request, res: Response) => {
  const collection = await prisma.collection.findUnique({
    where: { slug: req.params.slug },
    include: collectionInclude,
  })
  if (!collection) throw new NotFoundError('Collection')
  return ok(res, toCollectionDto(collection as unknown as CollectionWithRelations))
})

/**
 * A collection page in one request: the collection, its filtered/sorted
 * products, and the facet counts for its scope.
 */
export const getCollectionProducts = asyncHandler(async (req: Request, res: Response) => {
  const query = validated<ProductQueryInput>(req)

  const collection = await prisma.collection.findUnique({
    where: { slug: req.params.slug },
    include: collectionInclude,
  })
  if (!collection) throw new NotFoundError('Collection')

  const filters: ProductFilters = {
    category: query.category,
    color: query.color,
    material: query.material,
    size: query.size,
    pattern: query.pattern,
    collection: query.collection,
    availability: query.availability,
    minPrice: query.minPrice,
    maxPrice: query.maxPrice,
  }

  const result = await queryProducts({
    collectionSlug: req.params.slug,
    filters,
    sort: query.sort,
    page: query.page,
    limit: query.limit,
    includeFacets: query.facets,
  })

  return paginated(res, result.products, result.total, query.page, query.limit, {
    collection: toCollectionDto(collection as unknown as CollectionWithRelations),
    facets: result.facets,
    sort: query.sort,
  })
})

/* ------------------------------------------------------------------ *
 * Taxonomy — the admin-managed filter vocabulary
 * ------------------------------------------------------------------ */

/**
 * Everything the storefront needs to render its filter rails and swatches.
 *
 * Colours, sizes, materials and patterns are all rows the admin controls, so
 * adding a colour or recolouring a swatch in the admin panel changes the
 * website with no deploy.
 */
export const getTaxonomy = asyncHandler(async (_req: Request, res: Response) => {
  const [colors, sizes, materials, patterns, categories] = await Promise.all([
    prisma.color.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.size.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.material.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.pattern.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  ])

  return ok(res, {
    colors: colors.map(toColorDto),
    sizes: sizes.map(toSizeDto),
    materials: materials.map(toTermDto),
    patterns: patterns.map(toTermDto),
    categories: categories.map(toCategoryDto),
    sortOptions: [
      { label: 'Featured', value: 'featured' },
      { label: 'Newest', value: 'newest' },
      { label: 'Price: Low to High', value: 'price-low' },
      { label: 'Price: High to Low', value: 'price-high' },
      { label: 'Best Selling', value: 'best-selling' },
    ],
    availabilityOptions: [
      { label: 'In Stock', value: 'in-stock' },
      { label: 'Include Out of Stock', value: 'out-of-stock' },
    ],
  })
})

export const listColors = asyncHandler(async (_req: Request, res: Response) => {
  const colors = await prisma.color.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  return ok(res, colors.map(toColorDto))
})
