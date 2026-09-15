import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../db/prisma'
import { createCrudRouter } from './crud-factory'
import { requirePermission } from '../../middleware/authorize'
import { validateBody } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { created, noContent, ok } from '../../utils/response'
import { ConflictError, NotFoundError } from '../../utils/errors'
import { uniqueSlug, toSlug } from '../../utils/slug'
import { audit } from './audit'

/**
 * Taxonomy administration — the vocabulary behind every storefront filter.
 *
 * Colours, sizes, materials, patterns and categories are all editable here, and
 * the filter rails, swatches and facet counts on the website update with no
 * deploy. Adding a colour in the admin panel makes it selectable on every
 * collection page the moment a product uses it.
 */

export const taxonomyRouter = Router()

const PERMS = {
  view: 'taxonomy.view',
  create: 'taxonomy.create',
  update: 'taxonomy.update',
  delete: 'taxonomy.delete',
}

/* ------------------------------------------------------------------ *
 * Colours — name, slug, swatch hex, order, active
 * ------------------------------------------------------------------ */

const hex = z
  .string()
  .trim()
  .regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, 'Use a hex colour such as #C9B294.')

taxonomyRouter.use(
  '/colors',
  createCrudRouter({
    model: 'color',
    label: 'Colour',
    permissions: PERMS,
    countRelation: 'products',
    searchFields: ['name', 'slug'],
    createSchema: z.object({
      name: z.string().trim().min(1, 'Give the colour a name.').max(60),
      slug: z.string().trim().max(60).optional(),
      hex,
      sortOrder: z.coerce.number().int().default(0),
      isActive: z.boolean().default(true),
    }),
    updateSchema: z.object({
      name: z.string().trim().min(1).max(60).optional(),
      slug: z.string().trim().max(60).optional(),
      hex: hex.optional(),
      sortOrder: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
    }),
  }),
)

/* ------------------------------------------------------------------ *
 * Sizes
 * ------------------------------------------------------------------ */

taxonomyRouter.use(
  '/sizes',
  createCrudRouter({
    model: 'size',
    label: 'Size',
    permissions: PERMS,
    countRelation: 'products',
    searchFields: ['name', 'slug'],
    createSchema: z.object({
      name: z.string().trim().min(1, 'Give the size a name.').max(80),
      slug: z.string().trim().max(80).optional(),
      measurement: z.string().trim().max(80).nullable().optional(),
      sortOrder: z.coerce.number().int().default(0),
      isActive: z.boolean().default(true),
    }),
    updateSchema: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      slug: z.string().trim().max(80).optional(),
      measurement: z.string().trim().max(80).nullable().optional(),
      sortOrder: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
    }),
  }),
)

/* ------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------ */

taxonomyRouter.use(
  '/materials',
  createCrudRouter({
    model: 'material',
    label: 'Material',
    permissions: PERMS,
    countRelation: 'products',
    searchFields: ['name', 'slug'],
    createSchema: z.object({
      name: z.string().trim().min(1, 'Give the material a name.').max(80),
      slug: z.string().trim().max(80).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      sortOrder: z.coerce.number().int().default(0),
      isActive: z.boolean().default(true),
    }),
    updateSchema: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      slug: z.string().trim().max(80).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      sortOrder: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
    }),
  }),
)

/* ------------------------------------------------------------------ *
 * Patterns
 * ------------------------------------------------------------------ */

taxonomyRouter.use(
  '/patterns',
  createCrudRouter({
    model: 'pattern',
    label: 'Pattern',
    permissions: PERMS,
    countRelation: 'products',
    searchFields: ['name', 'slug'],
    createSchema: z.object({
      name: z.string().trim().min(1, 'Give the pattern a name.').max(80),
      slug: z.string().trim().max(80).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      sortOrder: z.coerce.number().int().default(0),
      isActive: z.boolean().default(true),
    }),
    updateSchema: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      slug: z.string().trim().max(80).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      sortOrder: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
    }),
  }),
)

/* ------------------------------------------------------------------ *
 * Categories — a tree, so handled explicitly rather than via the factory
 * ------------------------------------------------------------------ */

const categoryBody = z.object({
  name: z.string().trim().min(1, 'Give the category a name.').max(80),
  slug: z.string().trim().max(80).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  gender: z.enum(['WOMEN', 'MEN', 'UNISEX']).nullable().optional(),
  parentId: z.string().nullable().optional(),
  imageUrl: z.string().trim().max(500).nullable().optional(),
  imageAlt: z.string().trim().max(300).nullable().optional(),
  sortOrder: z.coerce.number().int().default(0),
  isActive: z.boolean().default(true),
})

taxonomyRouter.get(
  '/categories',
  requirePermission('categories.view'),
  asyncHandler(async (_req, res) => {
    const categories = await prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { products: true } },
        parent: { select: { id: true, name: true } },
      },
    })
    return ok(res, categories)
  }),
)

taxonomyRouter.get(
  '/categories/:id',
  requirePermission('categories.view'),
  asyncHandler(async (req, res) => {
    const category = await prisma.category.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { products: true } }, children: true },
    })
    if (!category) throw new NotFoundError('Category')
    return ok(res, category)
  }),
)

taxonomyRouter.post(
  '/categories',
  requirePermission('categories.create'),
  validateBody(categoryBody),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof categoryBody>
    const slug = await uniqueSlug(input.slug || input.name, async (candidate) =>
      Boolean(await prisma.category.findUnique({ where: { slug: candidate }, select: { id: true } })),
    )

    const category = await prisma.category.create({ data: { ...input, slug } })
    await audit(req, 'created', 'Category', category.id, null, category)
    return created(res, category)
  }),
)

taxonomyRouter.patch(
  '/categories/:id',
  requirePermission('categories.update'),
  validateBody(categoryBody.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.category.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new NotFoundError('Category')

    const input = req.body as Partial<z.infer<typeof categoryBody>>

    // A category cannot be its own parent, which would orphan the subtree.
    if (input.parentId === req.params.id) {
      throw new ConflictError('A category cannot be its own parent.')
    }

    const data: Record<string, unknown> = { ...input }
    if (input.slug && input.slug !== existing.slug) {
      data.slug = await uniqueSlug(toSlug(input.slug), async (candidate) =>
        Boolean(
          await prisma.category.findFirst({
            where: { slug: candidate, NOT: { id: req.params.id } },
            select: { id: true },
          }),
        ),
      )
    }

    const category = await prisma.category.update({ where: { id: req.params.id }, data })
    await audit(req, 'updated', 'Category', category.id, existing, category)
    return ok(res, category)
  }),
)

taxonomyRouter.delete(
  '/categories/:id',
  requirePermission('categories.delete'),
  asyncHandler(async (req, res) => {
    const category = await prisma.category.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { products: true, children: true } } },
    })
    if (!category) throw new NotFoundError('Category')

    if (category._count.products > 0) {
      throw new ConflictError(
        `${category._count.products} product(s) are in this category. Move them first.`,
      )
    }
    if (category._count.children > 0) {
      throw new ConflictError('This category has sub-categories. Remove or move them first.')
    }

    await prisma.category.delete({ where: { id: req.params.id } })
    await audit(req, 'deleted', 'Category', req.params.id, category, null)
    return noContent(res)
  }),
)

taxonomyRouter.post(
  '/categories/reorder',
  requirePermission('categories.update'),
  validateBody(z.object({ ids: z.array(z.string()).min(1).max(500) })),
  asyncHandler(async (req, res) => {
    const { ids } = req.body as { ids: string[] }
    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.category.update({ where: { id }, data: { sortOrder: index } }),
      ),
    )
    return ok(res, { reordered: ids.length })
  }),
)
