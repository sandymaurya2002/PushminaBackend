import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../db/prisma'
import { requireAuth } from '../../middleware/authenticate'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { noContent, ok, paginated } from '../../utils/response'
import { NotFoundError } from '../../utils/errors'
import * as service from './notification.service'

export const notificationRouter = Router()

notificationRouter.use(requireAuth)

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unreadOnly: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((value) => value === 'true' || value === true),
})

notificationRouter.get(
  '/',
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuery>>(req)
    const result = await service.listForCustomer(req.user!.id, query)
    return paginated(res, result.items, result.total, query.page, query.limit, {
      unreadCount: result.unreadCount,
    })
  }),
)

/** Polled by the header bell; kept deliberately cheap. */
notificationRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) =>
    ok(res, { count: await service.unreadCount({ userId: req.user!.id }) }),
  ),
)

notificationRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const count = await service.markRead(req.params.id, { userId: req.user!.id })
    if (count === 0) throw new NotFoundError('Notification')
    return ok(res, { message: 'Marked as read.' })
  }),
)

notificationRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const count = await service.markAllRead({ userId: req.user!.id })
    return ok(res, { marked: count })
  }),
)

notificationRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const count = await service.remove(req.params.id, { userId: req.user!.id })
    if (count === 0) throw new NotFoundError('Notification')
    return noContent(res)
  }),
)

/* ------------------------------------------------------------------ *
 * Preferences
 * ------------------------------------------------------------------ */

notificationRouter.get(
  '/preferences',
  asyncHandler(async (req, res) => {
    const preferences = await prisma.notificationPreference.findMany({
      where: { userId: req.user!.id },
    })
    return ok(res, preferences)
  }),
)

notificationRouter.put(
  '/preferences',
  validateBody(
    z.object({
      channel: z.enum(['IN_APP', 'EMAIL', 'PUSH']),
      type: z.string().min(1),
      enabled: z.boolean(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { channel, type, enabled } = req.body as {
      channel: 'IN_APP' | 'EMAIL' | 'PUSH'
      type: string
      enabled: boolean
    }

    const preference = await prisma.notificationPreference.upsert({
      where: {
        userId_channel_type: {
          userId: req.user!.id,
          channel,
          type: type as never,
        },
      },
      update: { enabled },
      create: { userId: req.user!.id, channel, type: type as never, enabled },
    })

    return ok(res, preference)
  }),
)
