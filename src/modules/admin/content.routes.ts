import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../db/prisma'
import { requirePermission } from '../../middleware/authorize'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { created, noContent, ok, paginated } from '../../utils/response'
import { ConflictError, NotFoundError } from '../../utils/errors'
import { toSlug, uniqueSlug } from '../../utils/slug'
import { audit } from './audit'
import { deleteSeoFor } from '../seo/seo.service'

export const adminContentRouter = Router()

/* ================================================================== *
 * Collections
 * ================================================================== */

const collectionBody = z.object({
  name: z.string().trim().min(1, 'Give the collection a name.').max(120),
  slug: z.string().trim().max(120).optional(),
  heading: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().min(1, 'A description is required.').max(2000),
  seoContent: z.array(z.string().trim().max(4000)).default([]),
  group: z.enum(['WOMEN', 'MEN', 'COLLECTIONS', 'GIFTING', 'CATEGORY']),
  bannerUrl: z.string().trim().max(500).nullable().optional(),
  bannerAlt: z.string().trim().max(300).nullable().optional(),
  isHidden: z.boolean().default(false),
  isFeatured: z.boolean().default(false),
  sortOrder: z.coerce.number().int().default(0),
  includeCategoryIds: z.array(z.string()).default([]),
  relatedCollectionIds: z.array(z.string()).default([]),
  productIds: z.array(z.string()).default([]),
  faqs: z
    .array(z.object({ question: z.string().trim().max(300), answer: z.string().trim().max(2000) }))
    .default([]),
})

adminContentRouter.get(
  '/collections',
  requirePermission('collections.view'),
  validateQuery(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      group: z.string().optional(),
      q: z.string().trim().max(120).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = validated<{ page: number; limit: number; group?: string; q?: string }>(req)

    const where = {
      ...(query.group ? { group: query.group.toUpperCase() as never } : {}),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
    }

    const [collections, total] = await Promise.all([
      prisma.collection.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { _count: { select: { products: true } } },
      }),
      prisma.collection.count({ where }),
    ])

    return paginated(res, collections, total, query.page, query.limit)
  }),
)

adminContentRouter.get(
  '/collections/:id',
  requirePermission('collections.view'),
  asyncHandler(async (req, res) => {
    const collection = await prisma.collection.findUnique({
      where: { id: req.params.id },
      include: {
        includeCategories: { select: { categoryId: true } },
        relatedFrom: { select: { targetId: true }, orderBy: { sortOrder: 'asc' } },
        faqs: { orderBy: { sortOrder: 'asc' } },
        products: { select: { productId: true }, orderBy: { sortOrder: 'asc' } },
      },
    })
    if (!collection) throw new NotFoundError('Collection')

    const seo = await prisma.seoMeta.findFirst({
      where: { entityType: 'COLLECTION', entityId: collection.id },
    })

    return ok(res, {
      ...collection,
      includeCategoryIds: collection.includeCategories.map((entry) => entry.categoryId),
      relatedCollectionIds: collection.relatedFrom.map((entry) => entry.targetId),
      productIds: collection.products.map((entry) => entry.productId),
      seo,
    })
  }),
)

async function writeCollectionRelations(
  collectionId: string,
  input: z.infer<typeof collectionBody>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.collectionCategory.deleteMany({ where: { collectionId } })
    if (input.includeCategoryIds.length) {
      await tx.collectionCategory.createMany({
        data: input.includeCategoryIds.map((categoryId) => ({ collectionId, categoryId })),
        skipDuplicates: true,
      })
    }

    await tx.collectionRelation.deleteMany({ where: { sourceId: collectionId } })
    const related = input.relatedCollectionIds.filter((id) => id !== collectionId)
    if (related.length) {
      await tx.collectionRelation.createMany({
        data: related.map((targetId, index) => ({
          sourceId: collectionId,
          targetId,
          sortOrder: index,
        })),
        skipDuplicates: true,
      })
    }

    await tx.collectionFaq.deleteMany({ where: { collectionId } })
    if (input.faqs.length) {
      await tx.collectionFaq.createMany({
        data: input.faqs.map((faq, index) => ({ collectionId, ...faq, sortOrder: index })),
      })
    }

    await tx.productCollection.deleteMany({ where: { collectionId } })
    if (input.productIds.length) {
      await tx.productCollection.createMany({
        data: input.productIds.map((productId, index) => ({
          collectionId,
          productId,
          sortOrder: index,
        })),
        skipDuplicates: true,
      })
    }
  })
}

adminContentRouter.post(
  '/collections',
  requirePermission('collections.create'),
  validateBody(collectionBody),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof collectionBody>

    const slug = await uniqueSlug(input.slug || input.name, async (candidate) =>
      Boolean(
        await prisma.collection.findUnique({ where: { slug: candidate }, select: { id: true } }),
      ),
    )

    const collection = await prisma.collection.create({
      data: {
        slug,
        name: input.name,
        heading: input.heading ?? null,
        description: input.description,
        seoContent: input.seoContent,
        group: input.group,
        bannerUrl: input.bannerUrl ?? null,
        bannerAlt: input.bannerAlt ?? null,
        isHidden: input.isHidden,
        isFeatured: input.isFeatured,
        sortOrder: input.sortOrder,
      },
    })

    await writeCollectionRelations(collection.id, input)
    await audit(req, 'created', 'Collection', collection.id, null, collection)

    return created(res, collection)
  }),
)

adminContentRouter.put(
  '/collections/:id',
  requirePermission('collections.update'),
  validateBody(collectionBody),
  asyncHandler(async (req, res) => {
    const existing = await prisma.collection.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Collection')

    const input = req.body as z.infer<typeof collectionBody>

    let slug = existing.slug
    if (input.slug && input.slug !== existing.slug) {
      slug = await uniqueSlug(toSlug(input.slug), async (candidate) =>
        Boolean(
          await prisma.collection.findFirst({
            where: { slug: candidate, NOT: { id: req.params.id } },
            select: { id: true },
          }),
        ),
      )
    }

    const collection = await prisma.collection.update({
      where: { id: req.params.id },
      data: {
        slug,
        name: input.name,
        heading: input.heading ?? null,
        description: input.description,
        seoContent: input.seoContent,
        group: input.group,
        bannerUrl: input.bannerUrl ?? null,
        bannerAlt: input.bannerAlt ?? null,
        isHidden: input.isHidden,
        isFeatured: input.isFeatured,
        sortOrder: input.sortOrder,
      },
    })

    await writeCollectionRelations(collection.id, input)
    await audit(req, 'updated', 'Collection', collection.id, existing, collection)

    return ok(res, collection)
  }),
)

adminContentRouter.delete(
  '/collections/:id',
  requirePermission('collections.delete'),
  asyncHandler(async (req, res) => {
    const collection = await prisma.collection.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { products: true, landingPages: true } } },
    })
    if (!collection) throw new NotFoundError('Collection')

    if (collection._count.landingPages > 0) {
      throw new ConflictError(
        'A landing page points at this collection. Repoint or remove it first.',
      )
    }

    await prisma.collection.delete({ where: { id: req.params.id } })
    await deleteSeoFor('COLLECTION', req.params.id)
    await audit(req, 'deleted', 'Collection', req.params.id, collection, null)

    return noContent(res)
  }),
)

/* ================================================================== *
 * Banners
 * ================================================================== */

const bannerBody = z.object({
  placement: z.enum([
    'HOME_HERO',
    'HOME_FEATURED',
    'HOME_GIFTING',
    'HOME_CATEGORY_CARD',
    'HOME_EDITORIAL',
    'HOME_SOCIAL',
    'COLLECTION_HEADER',
    'ANNOUNCEMENT',
    'PROMO_STRIP',
  ]),
  eyebrow: z.string().trim().max(120).nullable().optional(),
  heading: z.string().trim().min(1, 'A heading is required.').max(200),
  subheading: z.string().trim().max(500).nullable().optional(),
  body: z.string().trim().max(2000).nullable().optional(),
  imageUrl: z.string().trim().max(500).nullable().optional(),
  imageAlt: z.string().trim().max(300).nullable().optional(),
  href: z.string().trim().max(500).nullable().optional(),
  ctaLabel: z.string().trim().max(80).nullable().optional(),
  secondaryHref: z.string().trim().max(500).nullable().optional(),
  secondaryCtaLabel: z.string().trim().max(80).nullable().optional(),
  sortOrder: z.coerce.number().int().default(0),
  isActive: z.boolean().default(true),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
})

adminContentRouter.get(
  '/banners',
  requirePermission('banners.view'),
  asyncHandler(async (_req, res) => {
    const banners = await prisma.banner.findMany({
      orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
    })
    return ok(res, banners)
  }),
)

adminContentRouter.post(
  '/banners',
  requirePermission('banners.create'),
  validateBody(bannerBody),
  asyncHandler(async (req, res) => {
    const banner = await prisma.banner.create({ data: req.body })
    await audit(req, 'created', 'Banner', banner.id, null, banner)
    return created(res, banner)
  }),
)

adminContentRouter.patch(
  '/banners/:id',
  requirePermission('banners.update'),
  validateBody(bannerBody.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.banner.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Banner')

    const banner = await prisma.banner.update({ where: { id: req.params.id }, data: req.body })
    await audit(req, 'updated', 'Banner', banner.id, existing, banner)
    return ok(res, banner)
  }),
)

adminContentRouter.delete(
  '/banners/:id',
  requirePermission('banners.delete'),
  asyncHandler(async (req, res) => {
    await prisma.banner.delete({ where: { id: req.params.id } })
    await audit(req, 'deleted', 'Banner', req.params.id)
    return noContent(res)
  }),
)

/* ================================================================== *
 * Homepage sections
 * ================================================================== */

adminContentRouter.get(
  '/homepage-sections',
  requirePermission('content.view'),
  asyncHandler(async (_req, res) => {
    const sections = await prisma.homepageSection.findMany({ orderBy: { sortOrder: 'asc' } })
    return ok(res, sections)
  }),
)

adminContentRouter.patch(
  '/homepage-sections/:id',
  requirePermission('content.update'),
  validateBody(
    z.object({
      heading: z.string().trim().max(200).nullable().optional(),
      subheading: z.string().trim().max(500).nullable().optional(),
      href: z.string().trim().max(500).nullable().optional(),
      linkLabel: z.string().trim().max(80).nullable().optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.coerce.number().int().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const section = await prisma.homepageSection.update({
      where: { id: req.params.id },
      data: req.body,
    })
    await audit(req, 'updated', 'HomepageSection', section.id, null, section)
    return ok(res, section)
  }),
)

adminContentRouter.post(
  '/homepage-sections/reorder',
  requirePermission('content.update'),
  validateBody(z.object({ ids: z.array(z.string()).min(1).max(100) })),
  asyncHandler(async (req, res) => {
    const { ids } = req.body as { ids: string[] }
    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.homepageSection.update({ where: { id }, data: { sortOrder: index } }),
      ),
    )
    await audit(req, 'reordered', 'HomepageSection', undefined, null, { ids })
    return ok(res, { reordered: ids.length })
  }),
)

/* ================================================================== *
 * Pages
 * ================================================================== */

const pageBody = z.object({
  slug: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1, 'A title is required.').max(200),
  eyebrow: z.string().trim().max(120).nullable().optional(),
  intro: z.string().trim().max(2000).nullable().optional(),
  heroUrl: z.string().trim().max(500).nullable().optional(),
  heroAlt: z.string().trim().max(300).nullable().optional(),
  sections: z.array(z.record(z.string(), z.unknown())).default([]),
  faqs: z
    .array(z.object({ question: z.string().trim().max(300), answer: z.string().trim().max(2000) }))
    .default([]),
  updatedLabel: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).default('PUBLISHED'),
})

adminContentRouter.get(
  '/pages',
  requirePermission('content.view'),
  asyncHandler(async (_req, res) => {
    const pages = await prisma.page.findMany({ orderBy: { title: 'asc' } })
    return ok(res, pages)
  }),
)

adminContentRouter.get(
  '/pages/:id',
  requirePermission('content.view'),
  asyncHandler(async (req, res) => {
    const page = await prisma.page.findUnique({ where: { id: req.params.id } })
    if (!page) throw new NotFoundError('Page')
    const seo = await prisma.seoMeta.findFirst({
      where: { entityType: 'PAGE', entityId: page.slug },
    })
    return ok(res, { ...page, seo })
  }),
)

adminContentRouter.post(
  '/pages',
  requirePermission('content.create'),
  validateBody(pageBody),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof pageBody>
    const slug = await uniqueSlug(input.slug || input.title, async (candidate) =>
      Boolean(await prisma.page.findUnique({ where: { slug: candidate }, select: { id: true } })),
    )

    const page = await prisma.page.create({
      data: { ...input, slug, sections: input.sections as never, faqs: input.faqs as never },
    })
    await audit(req, 'created', 'Page', page.id, null, page)
    return created(res, page)
  }),
)

adminContentRouter.put(
  '/pages/:id',
  requirePermission('content.update'),
  validateBody(pageBody),
  asyncHandler(async (req, res) => {
    const existing = await prisma.page.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Page')

    const input = req.body as z.infer<typeof pageBody>

    // System pages (shipping, returns, privacy, terms) keep their slug: the
    // storefront routes to them by that exact path.
    const slug = existing.isSystem ? existing.slug : (input.slug ?? existing.slug)

    const page = await prisma.page.update({
      where: { id: req.params.id },
      data: { ...input, slug, sections: input.sections as never, faqs: input.faqs as never },
    })

    await audit(req, 'updated', 'Page', page.id, existing, page)
    return ok(res, page)
  }),
)

adminContentRouter.delete(
  '/pages/:id',
  requirePermission('content.delete'),
  asyncHandler(async (req, res) => {
    const page = await prisma.page.findUnique({ where: { id: req.params.id } })
    if (!page) throw new NotFoundError('Page')
    if (page.isSystem) {
      throw new ConflictError(
        'This is a system page the storefront links to directly. Unpublish it instead of deleting it.',
      )
    }

    await prisma.page.delete({ where: { id: req.params.id } })
    await deleteSeoFor('PAGE', page.slug)
    await audit(req, 'deleted', 'Page', req.params.id, page, null)
    return noContent(res)
  }),
)

/* ================================================================== *
 * Navigation
 * ================================================================== */

const navBody = z.object({
  group: z.enum(['HEADER', 'FOOTER', 'MOBILE']),
  parentId: z.string().nullable().optional(),
  columnTitle: z.string().trim().max(120).nullable().optional(),
  label: z.string().trim().min(1, 'A label is required.').max(120),
  href: z.string().trim().min(1, 'A link is required.').max(500),
  isHighlighted: z.boolean().default(false),
  imageUrl: z.string().trim().max(500).nullable().optional(),
  imageAlt: z.string().trim().max(300).nullable().optional(),
  eyebrow: z.string().trim().max(120).nullable().optional(),
  heading: z.string().trim().max(200).nullable().optional(),
  ctaLabel: z.string().trim().max(80).nullable().optional(),
  sortOrder: z.coerce.number().int().default(0),
  isActive: z.boolean().default(true),
})

adminContentRouter.get(
  '/navigation',
  requirePermission('navigation.view'),
  asyncHandler(async (_req, res) => {
    const items = await prisma.navigationItem.findMany({
      orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }],
      include: { children: { orderBy: { sortOrder: 'asc' } } },
      where: { parentId: null },
    })
    return ok(res, items)
  }),
)

adminContentRouter.post(
  '/navigation',
  requirePermission('navigation.manage'),
  validateBody(navBody),
  asyncHandler(async (req, res) => {
    const item = await prisma.navigationItem.create({ data: req.body })
    await audit(req, 'created', 'NavigationItem', item.id, null, item)
    return created(res, item)
  }),
)

adminContentRouter.patch(
  '/navigation/:id',
  requirePermission('navigation.manage'),
  validateBody(navBody.partial()),
  asyncHandler(async (req, res) => {
    if ((req.body as { parentId?: string }).parentId === req.params.id) {
      throw new ConflictError('A menu item cannot be its own parent.')
    }
    const item = await prisma.navigationItem.update({
      where: { id: req.params.id },
      data: req.body,
    })
    await audit(req, 'updated', 'NavigationItem', item.id, null, item)
    return ok(res, item)
  }),
)

adminContentRouter.delete(
  '/navigation/:id',
  requirePermission('navigation.manage'),
  asyncHandler(async (req, res) => {
    await prisma.navigationItem.delete({ where: { id: req.params.id } })
    await audit(req, 'deleted', 'NavigationItem', req.params.id)
    return noContent(res)
  }),
)

adminContentRouter.post(
  '/navigation/reorder',
  requirePermission('navigation.manage'),
  validateBody(z.object({ ids: z.array(z.string()).min(1).max(300) })),
  asyncHandler(async (req, res) => {
    const { ids } = req.body as { ids: string[] }
    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.navigationItem.update({ where: { id }, data: { sortOrder: index } }),
      ),
    )
    return ok(res, { reordered: ids.length })
  }),
)

/* ================================================================== *
 * Site settings
 * ================================================================== */

adminContentRouter.get(
  '/settings',
  requirePermission('settings.view'),
  asyncHandler(async (_req, res) => {
    const settings = await prisma.siteSetting.findMany({ orderBy: [{ group: 'asc' }, { key: 'asc' }] })
    return ok(res, settings)
  }),
)

adminContentRouter.put(
  '/settings',
  requirePermission('settings.update'),
  validateBody(
    z.object({
      settings: z
        .array(
          z.object({
            key: z.string().min(1).max(120),
            value: z.unknown(),
            group: z.string().max(60).optional(),
            label: z.string().max(160).optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { settings } = req.body as {
      settings: Array<{ key: string; value: unknown; group?: string; label?: string }>
    }

    await prisma.$transaction(
      settings.map((setting) =>
        prisma.siteSetting.upsert({
          where: { key: setting.key },
          update: {
            value: setting.value as never,
            ...(setting.group ? { group: setting.group } : {}),
            ...(setting.label ? { label: setting.label } : {}),
          },
          create: {
            key: setting.key,
            value: setting.value as never,
            group: setting.group ?? 'general',
            label: setting.label,
          },
        }),
      ),
    )

    await audit(req, 'updated', 'SiteSetting', undefined, null, {
      keys: settings.map((s) => s.key),
    })

    return ok(res, { updated: settings.length })
  }),
)

/* ================================================================== *
 * Landing pages
 * ================================================================== */

const landingBody = z.object({
  slug: z.string().trim().max(120).optional(),
  h1: z.string().trim().min(1, 'An H1 is required.').max(200),
  eyebrow: z.string().trim().max(120).nullable().optional(),
  intro: z.array(z.string().trim().max(3000)).default([]),
  collectionId: z.string().nullable().optional(),
  productHeading: z.string().trim().max(200).nullable().optional(),
  sections: z.array(z.record(z.string(), z.unknown())).default([]),
  faqs: z
    .array(z.object({ question: z.string().trim().max(300), answer: z.string().trim().max(2000) }))
    .default([]),
  internalLinks: z
    .array(z.object({ label: z.string().trim().max(160), href: z.string().trim().max(500) }))
    .default([]),
  bannerUrl: z.string().trim().max(500).nullable().optional(),
  bannerAlt: z.string().trim().max(300).nullable().optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
})

adminContentRouter.get(
  '/landing-pages',
  requirePermission('content.view'),
  asyncHandler(async (_req, res) => {
    const pages = await prisma.landingPage.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { collection: { select: { id: true, name: true, slug: true } } },
    })
    return ok(res, pages)
  }),
)

adminContentRouter.get(
  '/landing-pages/:id',
  requirePermission('content.view'),
  asyncHandler(async (req, res) => {
    const page = await prisma.landingPage.findUnique({ where: { id: req.params.id } })
    if (!page) throw new NotFoundError('Landing page')
    const seo = await prisma.seoMeta.findFirst({
      where: { entityType: 'LANDING', entityId: page.slug },
    })
    return ok(res, { ...page, seo })
  }),
)

adminContentRouter.post(
  '/landing-pages',
  requirePermission('content.create'),
  validateBody(landingBody),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof landingBody>
    const slug = await uniqueSlug(input.slug || input.h1, async (candidate) =>
      Boolean(
        await prisma.landingPage.findUnique({ where: { slug: candidate }, select: { id: true } }),
      ),
    )

    const page = await prisma.landingPage.create({
      data: {
        ...input,
        slug,
        sections: input.sections as never,
        faqs: input.faqs as never,
        internalLinks: input.internalLinks as never,
      },
    })

    await audit(req, 'created', 'LandingPage', page.id, null, page)
    return created(res, page)
  }),
)

adminContentRouter.put(
  '/landing-pages/:id',
  requirePermission('content.update'),
  validateBody(landingBody),
  asyncHandler(async (req, res) => {
    const existing = await prisma.landingPage.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Landing page')

    const input = req.body as z.infer<typeof landingBody>

    const page = await prisma.landingPage.update({
      where: { id: req.params.id },
      data: {
        ...input,
        slug: input.slug ?? existing.slug,
        sections: input.sections as never,
        faqs: input.faqs as never,
        internalLinks: input.internalLinks as never,
      },
    })

    await audit(req, 'updated', 'LandingPage', page.id, existing, page)
    return ok(res, page)
  }),
)

adminContentRouter.delete(
  '/landing-pages/:id',
  requirePermission('content.delete'),
  asyncHandler(async (req, res) => {
    const page = await prisma.landingPage.findUnique({ where: { id: req.params.id } })
    if (!page) throw new NotFoundError('Landing page')

    await prisma.landingPage.delete({ where: { id: req.params.id } })
    await deleteSeoFor('LANDING', page.slug)
    await audit(req, 'deleted', 'LandingPage', req.params.id, page, null)
    return noContent(res)
  }),
)
