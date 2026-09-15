import { Router } from 'express'
import { z, type ZodType } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma'
import { requirePermission } from '../../middleware/authorize'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { created, noContent, ok, paginated } from '../../utils/response'
import { ConflictError, NotFoundError } from '../../utils/errors'
import { audit } from './audit'
import { toSlug, uniqueSlug } from '../../utils/slug'

/**
 * CRUD factory for the simple admin-managed lookup tables.
 *
 * Colours, sizes, materials, patterns and blog tags are structurally identical:
 * a name, a slug, a sort order and an active flag. Hand-writing five nearly
 * identical routers would be five places for a bug to hide, so they share one
 * implementation with per-resource schemas.
 *
 * Anything with real behaviour — products, orders, payments — gets its own
 * router rather than being forced through this.
 */

type DelegateName = 'color' | 'size' | 'material' | 'pattern' | 'blogTag'

interface CrudOptions<TCreate, TUpdate> {
  /** Prisma model delegate key. */
  model: DelegateName
  /** Human label used in errors and audit entries. */
  label: string
  permissions: { view: string; create: string; update: string; delete: string }
  createSchema: ZodType<TCreate>
  updateSchema: ZodType<TUpdate>
  /** Relation counts to expose, e.g. how many products use this colour. */
  countRelation?: string
  searchFields?: string[]
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  q: z.string().trim().max(120).optional(),
  isActive: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true' || value === true)),
})

export function createCrudRouter<
  TCreate extends { name: string; slug?: string },
  TUpdate extends Record<string, unknown>,
>(options: CrudOptions<TCreate, TUpdate>): Router {
  const router = Router()
  // `any` is unavoidable here: Prisma's delegates are structurally different
  // types, and this factory is deliberately generic over five of them. It is
  // contained to this one accessor rather than leaking into the routes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const delegate = () => prisma[options.model] as any

  const include = options.countRelation
    ? { _count: { select: { [options.countRelation]: true } } }
    : undefined

  /* ---------------- List ---------------- */
  router.get(
    '/',
    requirePermission(options.permissions.view),
    validateQuery(listQuerySchema),
    asyncHandler(async (req, res) => {
      const query = validated<z.infer<typeof listQuerySchema>>(req)

      const where: Record<string, unknown> = {}
      if (query.isActive !== undefined) where.isActive = query.isActive
      if (query.q && options.searchFields?.length) {
        where.OR = options.searchFields.map((field) => ({
          [field]: { contains: query.q, mode: 'insensitive' },
        }))
      }

      const [items, total] = await Promise.all([
        delegate().findMany({
          where,
          include,
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        delegate().count({ where }),
      ])

      return paginated(res, items, total, query.page, query.limit)
    }),
  )

  /* ---------------- Read ---------------- */
  router.get(
    '/:id',
    requirePermission(options.permissions.view),
    asyncHandler(async (req, res) => {
      const item = await delegate().findUnique({ where: { id: req.params.id }, include })
      if (!item) throw new NotFoundError(options.label)
      return ok(res, item)
    }),
  )

  /* ---------------- Create ---------------- */
  router.post(
    '/',
    requirePermission(options.permissions.create),
    validateBody(options.createSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as TCreate

      // Slugs are the storefront's filter keys, so they must stay unique and
      // URL-safe whether or not the admin supplied one.
      const slug = await uniqueSlug(input.slug || input.name, async (candidate) =>
        Boolean(await delegate().findUnique({ where: { slug: candidate }, select: { id: true } })),
      )

      const item = await delegate().create({ data: { ...input, slug } })
      await audit(req, 'created', options.label, item.id, null, item)

      return created(res, item)
    }),
  )

  /* ---------------- Update ---------------- */
  router.patch(
    '/:id',
    requirePermission(options.permissions.update),
    validateBody(options.updateSchema),
    asyncHandler(async (req, res) => {
      const existing = await delegate().findUnique({ where: { id: req.params.id } })
      if (!existing) throw new NotFoundError(options.label)

      const input = req.body as TUpdate & { slug?: string; name?: string }
      const data: Record<string, unknown> = { ...input }

      if (input.slug && input.slug !== existing.slug) {
        data.slug = await uniqueSlug(toSlug(input.slug), async (candidate) =>
          Boolean(
            await delegate().findFirst({
              where: { slug: candidate, NOT: { id: req.params.id } },
              select: { id: true },
            }),
          ),
        )
      }

      const item = await delegate().update({ where: { id: req.params.id }, data })
      await audit(req, 'updated', options.label, item.id, existing, item)

      return ok(res, item)
    }),
  )

  /* ---------------- Delete ---------------- */
  router.delete(
    '/:id',
    requirePermission(options.permissions.delete),
    asyncHandler(async (req, res) => {
      const existing = await delegate().findUnique({ where: { id: req.params.id }, include })
      if (!existing) throw new NotFoundError(options.label)

      /* Refuse to delete anything still in use. Cascading would silently strip
         a colour from every product that has it, which is not what "delete"
         should mean here — deactivating is the reversible alternative. */
      const inUse = options.countRelation
        ? ((existing._count as Record<string, number>)?.[options.countRelation] ?? 0)
        : 0

      if (inUse > 0) {
        throw new ConflictError(
          `This ${options.label.toLowerCase()} is used by ${inUse} product${inUse === 1 ? '' : 's'}. ` +
            'Deactivate it instead, or reassign those products first.',
        )
      }

      await delegate().delete({ where: { id: req.params.id } })
      await audit(req, 'deleted', options.label, req.params.id, existing, null)

      return noContent(res)
    }),
  )

  /* ---------------- Reorder ---------------- */
  /**
   * Bulk reorder from a drag-and-drop list. One transaction so the rail can
   * never be left half-reordered.
   */
  router.post(
    '/reorder',
    requirePermission(options.permissions.update),
    validateBody(z.object({ ids: z.array(z.string().min(1)).min(1).max(500) })),
    asyncHandler(async (req, res) => {
      const { ids } = req.body as { ids: string[] }

      await prisma.$transaction(
        ids.map((id, index) =>
          delegate().update({ where: { id }, data: { sortOrder: index } }),
        ) as Prisma.PrismaPromise<unknown>[],
      )

      await audit(req, 'reordered', options.label, undefined, null, { ids })
      return ok(res, { reordered: ids.length })
    }),
  )

  return router
}
