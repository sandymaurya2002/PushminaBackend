import { Router } from 'express'
import { z } from 'zod'
import { optionalAuth, requireAuth } from '../../middleware/authenticate'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { paymentLimiter, publicWriteLimiter } from '../../middleware/rate-limit'
import { asyncHandler } from '../../utils/async-handler'
import { created, ok, paginated } from '../../utils/response'
import * as service from './order.service'

export const orderRouter = Router()

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

const addressSchema = z.object({
  fullName: z.string().trim().min(2, 'Please enter your full name.').max(120),
  email: z.string().trim().toLowerCase().email('Please enter a valid email address.'),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s]{10,15}$/, 'Please enter a valid phone number.'),
  line1: z.string().trim().min(4, 'Please enter your address.').max(200),
  line2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().min(2, 'Please enter your city.').max(80),
  state: z.string().trim().min(2, 'Please enter your state.').max(80),
  postalCode: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, 'Please enter a valid 6-digit PIN code.'),
  country: z.string().trim().max(80).default('India'),
})

const createOrderSchema = z.object({
  address: addressSchema,
  billingAddress: addressSchema.optional().nullable(),
  shippingMethod: z.enum(['standard', 'express']).default('standard'),
  paymentMethod: z.enum(['UPI', 'CARD', 'NETBANKING', 'WALLET', 'COD']),
  giftMessage: z.string().trim().max(500).optional(),
  customerNote: z.string().trim().max(1000).optional(),
})

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  status: z
    .enum([
      'PENDING',
      'PLACED',
      'CONFIRMED',
      'PROCESSING',
      'SHIPPED',
      'DELIVERED',
      'CANCELLED',
      'RETURNED',
    ])
    .optional(),
})

const trackSchema = z.object({
  orderNumber: z
    .string()
    .trim()
    .regex(/^PSH-\d{6}$/i, 'Order numbers look like PSH-104287.'),
  email: z.string().trim().toLowerCase().email('Enter the email address you ordered with.'),
})

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * Checkout works signed-out — a guest order is keyed to the email address, and
 * is claimable later by registering with the same address.
 */
orderRouter.post(
  '/',
  optionalAuth,
  paymentLimiter,
  validateBody(createOrderSchema),
  asyncHandler(async (req, res) => {
    const order = await service.createOrder({
      userId: req.user?.id,
      sessionId: req.sessionId,
      ...req.body,
    })
    return created(res, order)
  }),
)

/** Guest tracking: order number plus the email it was placed with. */
orderRouter.post(
  '/track',
  publicWriteLimiter,
  validateBody(trackSchema),
  asyncHandler(async (req, res) => {
    const order = await service.trackOrder(req.body.orderNumber, req.body.email)
    return ok(res, order)
  }),
)

orderRouter.get(
  '/',
  requireAuth,
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuerySchema>>(req)
    const { orders, total } = await service.listOrdersForCustomer(req.user!.id, query)
    return paginated(res, orders, total, query.page, query.limit)
  }),
)

orderRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) =>
    ok(res, await service.getOrderForCustomer(req.params.id, req.user!.id)),
  ),
)

orderRouter.post(
  '/:id/cancel',
  requireAuth,
  validateBody(z.object({ reason: z.string().trim().max(500).optional() })),
  asyncHandler(async (req, res) =>
    ok(res, await service.cancelOwnOrder(req.params.id, req.user!.id, req.body.reason)),
  ),
)
