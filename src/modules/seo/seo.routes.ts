import { Router } from 'express'
import { z } from 'zod'
import { validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { ok } from '../../utils/response'
import { NotFoundError } from '../../utils/errors'
import { prisma } from '../../db/prisma'
import * as seo from './seo.service'

export const seoRouter = Router()

/**
 * Resolves the metadata for one storefront path.
 *
 * The Next.js `generateMetadata` for each route calls this, so titles,
 * descriptions, canonical URLs, Open Graph tags and robots directives all
 * become admin-editable without touching frontend code.
 */
seoRouter.get(
  '/resolve',
  validateQuery(
    z.object({
      type: z.enum(['home', 'product', 'collection', 'post', 'page', 'landing']),
      slug: z.string().trim().max(160).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { type, slug } = validated<{ type: string; slug?: string }>(req)

    if (type === 'home') return ok(res, await seo.resolveForHome())
    if (!slug) throw new NotFoundError('SEO entry')

    const resolvers = {
      product: seo.resolveForProduct,
      collection: seo.resolveForCollection,
      post: seo.resolveForPost,
      page: seo.resolveForPage,
      landing: seo.resolveForLanding,
    } as const

    const resolved = await resolvers[type as keyof typeof resolvers](slug)
    if (!resolved) throw new NotFoundError('SEO entry')

    return ok(res, resolved)
  }),
)

/** Feeds the storefront's app/sitemap.ts. */
seoRouter.get(
  '/sitemap',
  asyncHandler(async (_req, res) => ok(res, await seo.buildSitemap())),
)

/**
 * Admin-managed redirects, so a renamed slug does not become a 404 and lose
 * whatever authority the old URL had accumulated.
 */
seoRouter.get(
  '/redirects',
  asyncHandler(async (_req, res) => {
    const redirects = await prisma.redirect.findMany({
      where: { isActive: true },
      select: { fromPath: true, toPath: true, statusCode: true },
    })
    return ok(res, redirects)
  }),
)
