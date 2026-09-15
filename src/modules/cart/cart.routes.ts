import { Router } from 'express'
import { validateBody } from '../../middleware/validate'
import { optionalAuth } from '../../middleware/authenticate'
import * as controller from './cart.controller'

export const cartRouter = Router()

// optionalAuth on every route: the cart works signed-out, and upgrades to the
// account cart the moment a token is present.
cartRouter.use(optionalAuth)

cartRouter.get('/', controller.getCart)
cartRouter.post('/items', validateBody(controller.addItemSchema), controller.addItem)
cartRouter.patch(
  '/items/:itemId',
  validateBody(controller.updateItemSchema),
  controller.updateItem,
)
cartRouter.delete('/items/:itemId', controller.removeItem)
cartRouter.delete('/', controller.clearCart)

cartRouter.post('/coupon', validateBody(controller.couponSchema), controller.applyCoupon)
cartRouter.delete('/coupon', controller.removeCoupon)

cartRouter.get('/validate', controller.validateCart)
