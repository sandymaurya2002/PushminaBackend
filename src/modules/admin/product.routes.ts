import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma'
import { requirePermission } from '../../middleware/authorize'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { created, noContent, ok, paginated } from '../../utils/response'
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors'
import { uniqueSlug, toSlug } from '../../utils/slug'
import { audit } from './audit'
import { recomputeFeaturedScore } from '../catalog/product.service'
import { productInclude, toProductDto, type ProductWithRelations } from '../catalog/catalog.dto'
import { deleteSeoFor } from '../seo/seo.service'
import { toNumber } from '../../utils/money'

export const adminProductRouter = Router()

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

const badgeEnum = z.enum(['NEW', 'BESTSELLER', 'LIMITED', 'HANDCRAFTED', 'EXCLUSIVE'])

const variantInput = z.object({
  id: z.string().optional(),
  sku: z.string().trim().min(1, 'Every variant needs a SKU.').max(60),
  barcode: z.string().trim().max(60).nullable().optional(),
  colorId: z.string().nullable().optional(),
  sizeId: z.string().nullable().optional(),
  price: z.coerce.number().nonnegative(),
  compareAtPrice: z.coerce.number().nonnegative().nullable().optional(),
  inventory: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
})

const imageInput = z.object({
  id: z.string().optional(),
  url: z.string().trim().min(1).max(500),
  alt: z.string().trim().min(1, 'Alt text is required for accessibility and SEO.').max(300),
  width: z.coerce.number().int().positive().default(800),
  height: z.coerce.number().int().positive().default(1000),
  isPrimary: z.boolean().default(false),
})

const productBody = z.object({
  name: z.string().trim().min(2, 'Give the product a name.').max(200),
  slug: z.string().trim().max(200).optional(),
  tagline: z.string().trim().min(1, 'A one-line hook is required.').max(300),
  description: z.string().trim().min(1, 'A description is required.').max(5000),
  story: z.array(z.string().trim().max(3000)).default([]),

  gender: z.enum(['WOMEN', 'MEN', 'UNISEX']).default('WOMEN'),
  categoryId: z.string().min(1, 'Choose a category.'),
  materialId: z.string().min(1, 'Choose a material.'),
  patternId: z.string().min(1, 'Choose a pattern.'),
  craft: z.string().trim().min(1).max(300),
  countryOfOrigin: z.string().trim().max(80).default('India'),
  weight: z.string().trim().max(60).nullable().optional(),
  finish: z.string().trim().max(200).nullable().optional(),

  price: z.coerce.number().nonnegative('Price cannot be negative.'),
  compareAtPrice: z.coerce.number().nonnegative().nullable().optional(),
  costPrice: z.coerce.number().nonnegative().nullable().optional(),
  saleStartsAt: z.coerce.date().nullable().optional(),
  saleEndsAt: z.coerce.date().nullable().optional(),

  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'),
  isFeatured: z.boolean().default(false),
  isTrending: z.boolean().default(false),
  isNewArrival: z.boolean().default(false),
  featuredOrder: z.coerce.number().int().default(0),
  trendingOrder: z.coerce.number().int().default(0),
  newArrivalOrder: z.coerce.number().int().default(0),

  popularity: z.coerce.number().int().min(0).max(100).default(0),
  lowStockThreshold: z.coerce.number().int().min(0).default(6),
  careInstructions: z.array(z.string().trim().max(500)).default([]),

  colorIds: z.array(z.string()).default([]),
  sizeIds: z.array(z.string()).default([]),
  collectionIds: z.array(z.string()).default([]),
  badges: z.array(badgeEnum).default([]),
  relatedProductIds: z.array(z.string()).default([]),

  images: z.array(imageInput).default([]),
  variants: z.array(variantInput).default([]),
  specifications: z
    .array(z.object({ label: z.string().trim().max(80), value: z.string().trim().max(300) }))
    .default([]),
  faqs: z
    .array(z.object({ question: z.string().trim().max(300), answer: z.string().trim().max(2000) }))
    .default([]),
})

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(160).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  categoryId: z.string().optional(),
  materialId: z.string().optional(),
  stock: z.enum(['in', 'low', 'out']).optional(),
  flag: z.enum(['featured', 'trending', 'new']).optional(),
  sort: z
    .enum(['newest', 'oldest', 'name', 'price-low', 'price-high', 'stock-low', 'popularity'])
    .default('newest'),
})

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Replaces a product's child rows wholesale inside the caller's transaction.
 *
 * Diffing images, variants and specs individually would be a great deal of
 * code guarding against very little: these collections are small, and the
 * admin form always submits the complete intended state.
 *
 * Variants are the exception — they are matched by id where supplied, so
 * editing a product does not destroy and recreate rows that orders reference.
 */
async function writeChildren(
  tx: Prisma.TransactionClient,
  productId: string,
  input: z.infer<typeof productBody>,
): Promise<void> {
  await tx.productImage.deleteMany({ where: { productId } })
  if (input.images.length) {
    await tx.productImage.createMany({
      data: input.images.map((image, index) => ({
        productId,
        url: image.url,
        alt: image.alt,
        width: image.width,
        height: image.height,
        isPrimary: image.isPrimary || index === 0,
        sortOrder: index,
      })),
    })
  }

  await tx.productColor.deleteMany({ where: { productId } })
  if (input.colorIds.length) {
    await tx.productColor.createMany({
      data: input.colorIds.map((colorId, index) => ({ productId, colorId, sortOrder: index })),
      skipDuplicates: true,
    })
  }

  await tx.productSize.deleteMany({ where: { productId } })
  if (input.sizeIds.length) {
    await tx.productSize.createMany({
      data: input.sizeIds.map((sizeId, index) => ({ productId, sizeId, sortOrder: index })),
      skipDuplicates: true,
    })
  }

  await tx.productSpecification.deleteMany({ where: { productId } })
  if (input.specifications.length) {
    await tx.productSpecification.createMany({
      data: input.specifications.map((spec, index) => ({ productId, ...spec, sortOrder: index })),
    })
  }

  await tx.productFaq.deleteMany({ where: { productId } })
  if (input.faqs.length) {
    await tx.productFaq.createMany({
      data: input.faqs.map((faq, index) => ({ productId, ...faq, sortOrder: index })),
    })
  }

  await tx.productBadgeLink.deleteMany({ where: { productId } })
  if (input.badges.length) {
    await tx.productBadgeLink.createMany({
      data: input.badges.map((badge) => ({ productId, badge })),
      skipDuplicates: true,
    })
  }

  await tx.productCollection.deleteMany({ where: { productId } })
  if (input.collectionIds.length) {
    await tx.productCollection.createMany({
      data: input.collectionIds.map((collectionId, index) => ({
        productId,
        collectionId,
        sortOrder: index,
      })),
      skipDuplicates: true,
    })
  }

  await tx.productRelation.deleteMany({ where: { sourceId: productId } })
  const relatedIds = input.relatedProductIds.filter((id) => id !== productId)
  if (relatedIds.length) {
    await tx.productRelation.createMany({
      data: relatedIds.map((targetId, index) => ({ sourceId: productId, targetId, sortOrder: index })),
      skipDuplicates: true,
    })
  }

  /* Variants: keep existing rows by id so order history and inventory logs
     stay attached; remove only those the admin actually deleted. */
  const keepIds = input.variants.map((variant) => variant.id).filter(Boolean) as string[]
  await tx.productVariant.deleteMany({
    where: { productId, ...(keepIds.length ? { id: { notIn: keepIds } } : {}) },
  })

  for (const variant of input.variants) {
    const data = {
      sku: variant.sku,
      barcode: variant.barcode ?? null,
      colorId: variant.colorId ?? null,
      sizeId: variant.sizeId ?? null,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice ?? null,
      inventory: variant.inventory,
      isActive: variant.isActive,
    }

    if (variant.id) {
      await tx.productVariant.update({ where: { id: variant.id }, data })
    } else {
      await tx.productVariant.create({ data: { productId, ...data } })
    }
  }
}

/* ------------------------------------------------------------------ *
 * List
 * ------------------------------------------------------------------ */

adminProductRouter.get(
  '/',
  requirePermission('products.view'),
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuery>>(req)

    const where: Prisma.ProductWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.materialId ? { materialId: query.materialId } : {}),
      ...(query.flag === 'featured' ? { isFeatured: true } : {}),
      ...(query.flag === 'trending' ? { isTrending: true } : {}),
      ...(query.flag === 'new' ? { isNewArrival: true } : {}),
      ...(query.stock === 'out' ? { variants: { every: { inventory: 0 } } } : {}),
      ...(query.stock === 'low'
        ? { variants: { every: { inventory: { lte: 6, gt: 0 } } } }
        : {}),
      ...(query.stock === 'in' ? { variants: { some: { inventory: { gt: 0 } } } } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { slug: { contains: query.q, mode: 'insensitive' } },
              { tagline: { contains: query.q, mode: 'insensitive' } },
              { variants: { some: { sku: { contains: query.q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    }

    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      query.sort === 'oldest'
        ? [{ createdAt: 'asc' }]
        : query.sort === 'name'
          ? [{ name: 'asc' }]
          : query.sort === 'price-low'
            ? [{ price: 'asc' }]
            : query.sort === 'price-high'
              ? [{ price: 'desc' }]
              : query.sort === 'popularity'
                ? [{ popularity: 'desc' }]
                : [{ createdAt: 'desc' }]

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          price: true,
          compareAtPrice: true,
          isFeatured: true,
          isTrending: true,
          isNewArrival: true,
          popularity: true,
          createdAt: true,
          publishedAt: true,
          lowStockThreshold: true,
          category: { select: { id: true, name: true } },
          material: { select: { id: true, name: true } },
          images: { where: { isPrimary: true }, take: 1, select: { url: true, alt: true } },
          variants: { select: { inventory: true, isActive: true } },
          _count: { select: { reviews: true, orderItems: true } },
        },
      }),
      prisma.product.count({ where }),
    ])

    const rows = products.map((product) => {
      const inventory = product.variants.reduce((sum, v) => sum + v.inventory, 0)
      return {
        ...product,
        price: toNumber(product.price),
        compareAtPrice: product.compareAtPrice ? toNumber(product.compareAtPrice) : null,
        inventory,
        variantCount: product.variants.length,
        stockState:
          inventory === 0 ? 'out' : inventory <= product.lowStockThreshold ? 'low' : 'in',
        image: product.images[0] ?? null,
        variants: undefined,
        images: undefined,
      }
    })

    return paginated(res, rows, total, query.page, query.limit)
  }),
)

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

adminProductRouter.get(
  '/:id',
  requirePermission('products.view'),
  asyncHandler(async (req, res) => {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: productInclude,
    })
    if (!product) throw new NotFoundError('Product')

    const seo = await prisma.seoMeta.findFirst({
      where: { entityType: 'PRODUCT', entityId: product.id },
    })

    // Admin needs raw ids for the form; the storefront DTO gives the preview.
    return ok(res, {
      ...toProductDto(product as ProductWithRelations),
      raw: {
        categoryId: product.categoryId,
        materialId: product.materialId,
        patternId: product.patternId,
        status: product.status,
        gender: product.gender,
        colorIds: product.colors.map((entry) => entry.colorId),
        sizeIds: product.sizes.map((entry) => entry.sizeId),
        collectionIds: product.collections.map((entry) => entry.collectionId),
        badges: product.badges.map((entry) => entry.badge),
        relatedProductIds: product.relatedFrom.map((entry) => entry.targetId),
        variants: product.variants,
        images: product.images,
        costPrice: product.costPrice ? toNumber(product.costPrice) : null,
        lowStockThreshold: product.lowStockThreshold,
        featuredOrder: product.featuredOrder,
        trendingOrder: product.trendingOrder,
        newArrivalOrder: product.newArrivalOrder,
      },
      seo,
    })
  }),
)

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

adminProductRouter.post(
  '/',
  requirePermission('products.create'),
  validateBody(productBody),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof productBody>

    const slug = await uniqueSlug(input.slug || input.name, async (candidate) =>
      Boolean(await prisma.product.findUnique({ where: { slug: candidate }, select: { id: true } })),
    )

    const duplicateSkus = await prisma.productVariant.findMany({
      where: { sku: { in: input.variants.map((v) => v.sku) } },
      select: { sku: true },
    })
    if (duplicateSkus.length) {
      throw new ConflictError(
        `These SKUs are already in use: ${duplicateSkus.map((v) => v.sku).join(', ')}`,
      )
    }

    const product = await prisma.$transaction(async (tx) => {
      const record = await tx.product.create({
        data: {
          slug,
          name: input.name,
          tagline: input.tagline,
          description: input.description,
          story: input.story,
          gender: input.gender,
          categoryId: input.categoryId,
          materialId: input.materialId,
          patternId: input.patternId,
          craft: input.craft,
          countryOfOrigin: input.countryOfOrigin,
          weight: input.weight ?? null,
          finish: input.finish ?? null,
          price: input.price,
          compareAtPrice: input.compareAtPrice ?? null,
          costPrice: input.costPrice ?? null,
          saleStartsAt: input.saleStartsAt ?? null,
          saleEndsAt: input.saleEndsAt ?? null,
          status: input.status,
          isFeatured: input.isFeatured,
          isTrending: input.isTrending,
          isNewArrival: input.isNewArrival,
          featuredOrder: input.featuredOrder,
          trendingOrder: input.trendingOrder,
          newArrivalOrder: input.newArrivalOrder,
          popularity: input.popularity,
          lowStockThreshold: input.lowStockThreshold,
          careInstructions: input.careInstructions,
          publishedAt: input.status === 'PUBLISHED' ? new Date() : null,
        },
      })

      await writeChildren(tx, record.id, input)
      return record
    })

    await recomputeFeaturedScore(product.id)
    await audit(req, 'created', 'Product', product.id, null, { name: product.name, slug })

    return created(res, product)
  }),
)

/* ------------------------------------------------------------------ *
 * Update
 * ------------------------------------------------------------------ */

adminProductRouter.put(
  '/:id',
  requirePermission('products.update'),
  validateBody(productBody),
  asyncHandler(async (req, res) => {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Product')

    const input = req.body as z.infer<typeof productBody>

    let slug = existing.slug
    if (input.slug && input.slug !== existing.slug) {
      slug = await uniqueSlug(toSlug(input.slug), async (candidate) =>
        Boolean(
          await prisma.product.findFirst({
            where: { slug: candidate, NOT: { id: req.params.id } },
            select: { id: true },
          }),
        ),
      )
    }

    // A SKU must be unique across the whole catalogue, not just this product.
    const clashing = await prisma.productVariant.findMany({
      where: {
        sku: { in: input.variants.map((v) => v.sku) },
        productId: { not: req.params.id },
      },
      select: { sku: true },
    })
    if (clashing.length) {
      throw new ConflictError(
        `These SKUs belong to another product: ${clashing.map((v) => v.sku).join(', ')}`,
      )
    }

    const product = await prisma.$transaction(async (tx) => {
      const record = await tx.product.update({
        where: { id: req.params.id },
        data: {
          slug,
          name: input.name,
          tagline: input.tagline,
          description: input.description,
          story: input.story,
          gender: input.gender,
          categoryId: input.categoryId,
          materialId: input.materialId,
          patternId: input.patternId,
          craft: input.craft,
          countryOfOrigin: input.countryOfOrigin,
          weight: input.weight ?? null,
          finish: input.finish ?? null,
          price: input.price,
          compareAtPrice: input.compareAtPrice ?? null,
          costPrice: input.costPrice ?? null,
          saleStartsAt: input.saleStartsAt ?? null,
          saleEndsAt: input.saleEndsAt ?? null,
          status: input.status,
          isFeatured: input.isFeatured,
          isTrending: input.isTrending,
          isNewArrival: input.isNewArrival,
          featuredOrder: input.featuredOrder,
          trendingOrder: input.trendingOrder,
          newArrivalOrder: input.newArrivalOrder,
          popularity: input.popularity,
          lowStockThreshold: input.lowStockThreshold,
          careInstructions: input.careInstructions,
          // Stamped the first time it goes live, and never overwritten after.
          publishedAt:
            input.status === 'PUBLISHED' && !existing.publishedAt
              ? new Date()
              : existing.publishedAt,
        },
      })

      await writeChildren(tx, record.id, input)
      return record
    })

    await recomputeFeaturedScore(product.id)
    await audit(req, 'updated', 'Product', product.id, existing, product)

    return ok(res, product)
  }),
)

/* ------------------------------------------------------------------ *
 * Status & merchandising
 * ------------------------------------------------------------------ */

adminProductRouter.patch(
  '/:id/status',
  requirePermission('products.publish'),
  validateBody(z.object({ status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']) })),
  asyncHandler(async (req, res) => {
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { publishedAt: true, status: true },
    })
    if (!existing) throw new NotFoundError('Product')

    const { status } = req.body as { status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' }

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        status,
        publishedAt:
          status === 'PUBLISHED' && !existing.publishedAt ? new Date() : existing.publishedAt,
      },
    })

    await audit(req, status.toLowerCase(), 'Product', product.id, existing, { status })
    return ok(res, product)
  }),
)

/**
 * Trending / featured / new-arrival flags.
 *
 * The storefront rails render exactly what is set here, in exactly this order.
 */
adminProductRouter.patch(
  '/:id/merchandising',
  requirePermission('products.merchandise'),
  validateBody(
    z.object({
      isFeatured: z.boolean().optional(),
      isTrending: z.boolean().optional(),
      isNewArrival: z.boolean().optional(),
      featuredOrder: z.coerce.number().int().optional(),
      trendingOrder: z.coerce.number().int().optional(),
      newArrivalOrder: z.coerce.number().int().optional(),
      popularity: z.coerce.number().int().min(0).max(100).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: req.body,
    })
    await recomputeFeaturedScore(product.id)
    await audit(req, 'merchandised', 'Product', product.id, null, req.body)
    return ok(res, product)
  }),
)

/** Drag-and-drop ordering for a merchandised rail. */
adminProductRouter.post(
  '/merchandising/reorder',
  requirePermission('products.merchandise'),
  validateBody(
    z.object({
      rail: z.enum(['featured', 'trending', 'newArrival']),
      ids: z.array(z.string()).min(1).max(200),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { rail, ids } = req.body as { rail: string; ids: string[] }
    const field =
      rail === 'featured' ? 'featuredOrder' : rail === 'trending' ? 'trendingOrder' : 'newArrivalOrder'

    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.product.update({ where: { id }, data: { [field]: index } }),
      ),
    )

    await audit(req, 'reordered', 'Product', undefined, null, { rail, ids })
    return ok(res, { reordered: ids.length })
  }),
)

/* ------------------------------------------------------------------ *
 * Inventory
 * ------------------------------------------------------------------ */

adminProductRouter.post(
  '/variants/:variantId/inventory',
  requirePermission('inventory.adjust'),
  validateBody(
    z.object({
      change: z.coerce.number().int(),
      note: z.string().trim().max(300).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { change, note } = req.body as { change: number; note?: string }

    const variant = await prisma.productVariant.findUnique({
      where: { id: req.params.variantId },
      select: { id: true, inventory: true, sku: true },
    })
    if (!variant) throw new NotFoundError('Variant')

    if (variant.inventory + change < 0) {
      throw new BadRequestError(
        `That would take ${variant.sku} to ${variant.inventory + change}. Stock cannot go negative.`,
      )
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.productVariant.update({
        where: { id: variant.id },
        data: { inventory: { increment: change } },
      })

      await tx.inventoryLog.create({
        data: {
          variantId: variant.id,
          change,
          resulting: result.inventory,
          reason: 'MANUAL_ADJUSTMENT',
          note,
          createdById: req.admin!.id,
        },
      })

      return result
    })

    await audit(req, 'adjusted-stock', 'ProductVariant', variant.id, variant, updated)
    return ok(res, updated)
  }),
)

adminProductRouter.get(
  '/variants/:variantId/inventory-log',
  requirePermission('inventory.view'),
  asyncHandler(async (req, res) => {
    const logs = await prisma.inventoryLog.findMany({
      where: { variantId: req.params.variantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return ok(res, logs)
  }),
)

/* ------------------------------------------------------------------ *
 * Delete
 * ------------------------------------------------------------------ */

adminProductRouter.delete(
  '/:id',
  requirePermission('products.delete'),
  asyncHandler(async (req, res) => {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { orderItems: true } } },
    })
    if (!product) throw new NotFoundError('Product')

    /* A product that has been ordered is never deleted — order history would
       lose its link and reporting would silently change. Archiving keeps the
       record intact while removing it from the storefront. */
    if (product._count.orderItems > 0) {
      throw new ConflictError(
        `This product appears in ${product._count.orderItems} order line(s), so it cannot be deleted. ` +
          'Set its status to Archived instead — it will disappear from the website but order history stays intact.',
      )
    }

    await prisma.product.delete({ where: { id: req.params.id } })
    await deleteSeoFor('PRODUCT', req.params.id)
    await audit(req, 'deleted', 'Product', req.params.id, product, null)

    return noContent(res)
  }),
)
