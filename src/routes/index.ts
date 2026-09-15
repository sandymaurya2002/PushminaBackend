import { Router } from 'express'
import { catalogRouter } from '../modules/catalog/catalog.routes'
import { authRouter } from '../modules/auth/auth.routes'
import { cartRouter } from '../modules/cart/cart.routes'
import { wishlistRouter } from '../modules/wishlist/wishlist.routes'
import { orderRouter } from '../modules/orders/order.routes'
import { paymentRouter } from '../modules/payments/payment.routes'
import { blogRouter } from '../modules/blog/blog.routes'
import { contentRouter } from '../modules/content/content.routes'
import { seoRouter } from '../modules/seo/seo.routes'
import { reviewRouter } from '../modules/reviews/review.routes'
import { notificationRouter } from '../modules/notifications/notification.routes'
import { adminRouter } from '../modules/admin'
import { authLimiter } from '../middleware/rate-limit'
import { validateBody } from '../middleware/validate'
import { adminLoginSchema, refreshSchema } from '../modules/auth/auth.schema'
import * as authController from '../modules/auth/auth.controller'
import { requireAdmin } from '../middleware/authenticate'

/**
 * API v1 root.
 *
 * Routers are mounted in two trees:
 *   /api/v1/...        public + authenticated customer surface
 *   /api/v1/admin/...  staff surface, every route behind requireAdmin
 */
export const apiRouter = Router()

apiRouter.get('/', (_req, res) => {
  res.json({
    success: true,
    data: {
      name: 'Pushmina API',
      version: 'v1',
      documentation: '/api/v1/docs',
    },
  })
})

/* ------------------------------------------------------------------ *
 * Public storefront
 * ------------------------------------------------------------------ */
apiRouter.use('/auth', authRouter)
apiRouter.use('/cart', cartRouter)
apiRouter.use('/wishlist', wishlistRouter)
apiRouter.use('/orders', orderRouter)
apiRouter.use('/payments', paymentRouter)
apiRouter.use('/blog', blogRouter)
apiRouter.use('/content', contentRouter)
apiRouter.use('/seo', seoRouter)
apiRouter.use('/reviews', reviewRouter)
apiRouter.use('/notifications', notificationRouter)

/* ------------------------------------------------------------------ *
 * Admin
 *
 * The login endpoints sit outside `adminRouter` because they are what issues
 * the token that `requireAdmin` then demands.
 * ------------------------------------------------------------------ */
apiRouter.post(
  '/admin/auth/login',
  authLimiter,
  validateBody(adminLoginSchema),
  authController.adminLogin,
)
apiRouter.post('/admin/auth/refresh', validateBody(refreshSchema), authController.adminRefresh)
apiRouter.post('/admin/auth/logout', authController.adminLogout)
apiRouter.get('/admin/auth/me', requireAdmin, authController.adminMe)
apiRouter.post('/admin/auth/change-password', requireAdmin, authController.adminChangePassword)

apiRouter.use('/admin', adminRouter)

// Mounted last at the root so its /products, /collections and /categories
// paths cannot shadow the prefixed routers above.
apiRouter.use('/', catalogRouter)
