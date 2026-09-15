import { Router } from 'express'
import { z } from 'zod'
import { validateBody } from '../../middleware/validate'
import { requireAuth } from '../../middleware/authenticate'
import { authLimiter } from '../../middleware/rate-limit'
import {
  addressSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './auth.schema'
import * as controller from './auth.controller'

export const authRouter = Router()

/* Credentials — rate limited to blunt password spraying ------------ */
authRouter.post('/register', authLimiter, validateBody(registerSchema), controller.register)
authRouter.post('/login', authLimiter, validateBody(loginSchema), controller.login)
authRouter.post('/refresh', validateBody(refreshSchema), controller.refresh)
authRouter.post('/logout', controller.logout)

authRouter.post(
  '/forgot-password',
  authLimiter,
  validateBody(forgotPasswordSchema),
  controller.forgotPassword,
)
authRouter.post(
  '/reset-password',
  authLimiter,
  validateBody(resetPasswordSchema),
  controller.resetPassword,
)

/* Authenticated customer ------------------------------------------- */
authRouter.get('/me', requireAuth, controller.me)
authRouter.patch('/me', requireAuth, validateBody(updateProfileSchema), controller.updateProfile)
authRouter.post(
  '/change-password',
  requireAuth,
  validateBody(changePasswordSchema),
  controller.changePassword,
)
authRouter.post('/logout-all', requireAuth, controller.logoutEverywhere)

/* Addresses -------------------------------------------------------- */
const idParam = z.object({ id: z.string().min(1) })

authRouter.get('/addresses', requireAuth, controller.listAddresses)
authRouter.post(
  '/addresses',
  requireAuth,
  validateBody(addressSchema),
  controller.createAddress,
)
authRouter.patch(
  '/addresses/:id',
  requireAuth,
  validateBody(addressSchema.partial()),
  controller.updateAddress,
)
authRouter.delete('/addresses/:id', requireAuth, controller.deleteAddress)
authRouter.post('/addresses/:id/default', requireAuth, controller.setDefaultAddress)

void idParam
