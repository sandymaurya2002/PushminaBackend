import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../db/prisma'
import { requirePermission } from '../../middleware/authorize'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { created, noContent, ok, paginated } from '../../utils/response'
import { NotFoundError } from '../../utils/errors'
import { env } from '../../config/env'
import { audit } from './audit'

export const adminSeoRouter = Router()

const ENTITY_TYPES = [
  'HOME',
  'PRODUCT',
  'CATEGORY',
  'COLLECTION',
  'BLOG_POST',
  'BLOG_CATEGORY',
  'BLOG_INDEX',
  'PAGE',
  'LANDING',
  'CUSTOM',
] as const

const seoBody = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().max(200).nullable().optional(),
  path: z.string().trim().max(500).nullable().optional(),
  title: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(400).nullable().optional(),
  keywords: z.array(z.string().trim().max(60)).max(30).default([]),
  canonicalUrl: z.string().trim().max(500).nullable().optional(),
  ogTitle: z.string().trim().max(200).nullable().optional(),
  ogDescription: z.string().trim().max(400).nullable().optional(),
  ogImageUrl: z.string().trim().max(500).nullable().optional(),
  ogType: z.string().trim().max(40).default('website'),
  twitterCard: z.string().trim().max(40).default('summary_large_image'),
  robotsIndex: z.boolean().default(true),
  robotsFollow: z.boolean().default(true),
  structuredData: z.record(z.string(), z.unknown()).nullable().optional(),
  changeFrequency: z
    .enum(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'])
    .default('weekly'),
  priority: z.coerce.number().min(0).max(1).default(0.7),
})

adminSeoRouter.get(
  '/',
  requirePermission('seo.view'),
  validateQuery(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      entityType: z.enum(ENTITY_TYPES).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = validated<{ page: number; limit: number; entityType?: string }>(req)
    const where = query.entityType ? { entityType: query.entityType as never } : {}

    const [entries, total] = await Promise.all([
      prisma.seoMeta.findMany({
        where,
        orderBy: [{ entityType: 'asc' }, { updatedAt: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.seoMeta.count({ where }),
    ])

    return paginated(res, entries, total, query.page, query.limit)
  }),
)

/**
 * Upsert by (entityType, entityId).
 *
 * The admin panel edits SEO from inside the product, collection or article
 * form, so it never knows whether a row already exists — one endpoint that
 * creates or updates removes an entire round trip and a class of race.
 */
adminSeoRouter.put(
  '/',
  requirePermission('seo.update'),
  validateBody(seoBody),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof seoBody>

    const existing = await prisma.seoMeta.findFirst({
      where: { entityType: input.entityType, entityId: input.entityId ?? null },
    })

    const data = {
      ...input,
      entityId: input.entityId ?? null,
      structuredData: (input.structuredData ?? undefined) as never,
    }

    const entry = existing
      ? await prisma.seoMeta.update({ where: { id: existing.id }, data })
      : await prisma.seoMeta.create({ data })

    await audit(req, existing ? 'updated' : 'created', 'SeoMeta', entry.id, existing, entry)
    return existing ? ok(res, entry) : created(res, entry)
  }),
)

adminSeoRouter.delete(
  '/:id',
  requirePermission('seo.update'),
  asyncHandler(async (req, res) => {
    await prisma.seoMeta.delete({ where: { id: req.params.id } })
    await audit(req, 'deleted', 'SeoMeta', req.params.id)
    return noContent(res)
  }),
)

/**
 * Live preview of how the entry will appear on a search results page and when
 * shared, including the truncation search engines actually apply.
 */
adminSeoRouter.post(
  '/preview',
  requirePermission('seo.view'),
  validateBody(
    z.object({
      title: z.string().max(400).default(''),
      description: z.string().max(1000).default(''),
      path: z.string().max(500).default('/'),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { title, description, path } = req.body as {
      title: string
      description: string
      path: string
    }

    const truncate = (value: string, max: number): string =>
      value.length <= max ? value : `${value.slice(0, value.lastIndexOf(' ', max))}…`

    return ok(res, {
      google: {
        title: truncate(title, 60),
        titleLength: title.length,
        titleWarning: title.length > 60 ? 'Likely to be truncated in search results.' : null,
        description: truncate(description, 158),
        descriptionLength: description.length,
        descriptionWarning:
          description.length > 158
            ? 'Likely to be truncated.'
            : description.length < 70
              ? 'Short — consider using more of the available space.'
              : null,
        url: `${env.STOREFRONT_URL}${path}`,
      },
    })
  }),
)

/* ------------------------------------------------------------------ *
 * Redirects
 * ------------------------------------------------------------------ */

adminSeoRouter.get(
  '/redirects',
  requirePermission('seo.view'),
  asyncHandler(async (_req, res) => {
    const redirects = await prisma.redirect.findMany({ orderBy: { createdAt: 'desc' } })
    return ok(res, redirects)
  }),
)

adminSeoRouter.post(
  '/redirects',
  requirePermission('seo.update'),
  validateBody(
    z.object({
      fromPath: z.string().trim().min(1).max(500).startsWith('/', 'Start the path with /'),
      toPath: z.string().trim().min(1).max(500),
      statusCode: z.union([z.literal(301), z.literal(302), z.literal(308)]).default(301),
      isActive: z.boolean().default(true),
    }),
  ),
  asyncHandler(async (req, res) => {
    const redirect = await prisma.redirect.create({ data: req.body })
    await audit(req, 'created', 'Redirect', redirect.id, null, redirect)
    return created(res, redirect)
  }),
)

adminSeoRouter.delete(
  '/redirects/:id',
  requirePermission('seo.update'),
  asyncHandler(async (req, res) => {
    await prisma.redirect.delete({ where: { id: req.params.id } })
    return noContent(res)
  }),
)

/**
 * SEO health check — finds pages that will underperform before they are
 * indexed, rather than after.
 */
adminSeoRouter.get(
  '/audit',
  requirePermission('seo.view'),
  asyncHandler(async (_req, res) => {
    const [noImages, noAlt, shortDescriptions, missingSeo, duplicateTitles] = await Promise.all([
      prisma.product.count({ where: { status: 'PUBLISHED', images: { none: {} } } }),
      prisma.productImage.count({ where: { alt: '' } }),
      prisma.product.findMany({
        where: { status: 'PUBLISHED', description: { equals: '' } },
        select: { id: true, slug: true, name: true },
        take: 20,
      }),
      prisma.product.count({ where: { status: 'PUBLISHED' } }),
      prisma.$queryRaw<Array<{ title: string; count: bigint }>>`
        SELECT "title", COUNT(*) AS count
        FROM seo_meta
        WHERE "title" IS NOT NULL
        GROUP BY "title"
        HAVING COUNT(*) > 1
        LIMIT 20
      `,
    ])

    const withSeo = await prisma.seoMeta.count({ where: { entityType: 'PRODUCT' } })

    return ok(res, {
      issues: {
        productsWithoutImages: noImages,
        imagesWithoutAltText: noAlt,
        productsWithoutDescription: shortDescriptions,
        productsWithoutCustomSeo: Math.max(0, missingSeo - withSeo),
        duplicateTitles: duplicateTitles.map((row) => ({
          title: row.title,
          count: Number(row.count),
        })),
      },
    })
  }),
)
