import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../middleware/authenticate'
import { validateBody } from '../../middleware/validate'
import { asyncHandler } from '../../utils/async-handler'
import { ok, noContent } from '../../utils/response'
import * as service from './wishlist.service'

export const wishlistRouter = Router()

wishlistRouter.use(requireAuth)

wishlistRouter.get(
  '/',
  asyncHandler(async (req, res) => ok(res, await service.listWishlist(req.user!.id))),
)

wishlistRouter.get(
  '/slugs',
  asyncHandler(async (req, res) => ok(res, await service.listSlugs(req.user!.id))),
)

wishlistRouter.post(
  '/toggle',
  validateBody(z.object({ slug: z.string().min(1) })),
  asyncHandler(async (req, res) => ok(res, await service.toggle(req.user!.id, req.body.slug))),
)

wishlistRouter.post(
  '/merge',
  validateBody(z.object({ slugs: z.array(z.string()).max(200) })),
  asyncHandler(async (req, res) => {
    const merged = await service.merge(req.user!.id, req.body.slugs)
    return ok(res, { merged, slugs: await service.listSlugs(req.user!.id) })
  }),
)

wishlistRouter.delete(
  '/:slug',
  asyncHandler(async (req, res) => {
    await service.remove(req.user!.id, req.params.slug)
    return noContent(res)
  }),
)

wishlistRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    await service.clear(req.user!.id)
    return noContent(res)
  }),
)
