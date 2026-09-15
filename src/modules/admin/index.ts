import { Router } from 'express'
import { requireAdmin } from '../../middleware/authenticate'
import { dashboardRouter } from './dashboard.routes'
import { adminProductRouter } from './product.routes'
import { taxonomyRouter } from './taxonomy.routes'
import { adminOrderRouter } from './order.routes'
import { adminPaymentRouter } from './payment.routes'
import { adminCustomerRouter } from './customer.routes'
import { adminContentRouter } from './content.routes'
import { adminBlogRouter } from './blog.routes'
import { adminSeoRouter } from './seo.routes'
import { adminMiscRouter } from './misc.routes'

/**
 * Admin API.
 *
 * `requireAdmin` is applied once, here, to the whole tree. Individual routes
 * then declare the specific permission they need. Mounting the guard at the
 * root means a new admin route cannot accidentally ship unauthenticated —
 * the worst case is that it is reachable by any signed-in staff member, not
 * by the public.
 */
export const adminRouter = Router()

adminRouter.use(requireAdmin)

adminRouter.use('/dashboard', dashboardRouter)
adminRouter.use('/products', adminProductRouter)
adminRouter.use('/taxonomy', taxonomyRouter)
adminRouter.use('/orders', adminOrderRouter)
adminRouter.use('/payments', adminPaymentRouter)
adminRouter.use('/customers', adminCustomerRouter)
adminRouter.use('/content', adminContentRouter)
adminRouter.use('/blog', adminBlogRouter)
adminRouter.use('/seo', adminSeoRouter)

// Media, reviews, contact, newsletter, coupons, notifications, admins, roles
// and the audit log. Mounted last so its paths cannot shadow the routers above.
adminRouter.use('/', adminMiscRouter)
