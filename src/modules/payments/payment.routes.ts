import { Router } from 'express'
import { z } from 'zod'
import { optionalAuth, requireAuth } from '../../middleware/authenticate'
import { validateBody, validateQuery, validated } from '../../middleware/validate'
import { paymentLimiter } from '../../middleware/rate-limit'
import { asyncHandler } from '../../utils/async-handler'
import { ok, paginated } from '../../utils/response'
import { getRawBody } from './webhook-raw-body'
import { BadRequestError, NotFoundError } from '../../utils/errors'
import { prisma } from '../../db/prisma'
import * as service from './payment.service'
import { isMockProvider } from './providers'
import { MockPaymentProvider } from './providers/mock'

export const paymentRouter = Router()

const initiateSchema = z.object({
  orderId: z.string().min(1),
  method: z.enum(['UPI', 'CARD', 'NETBANKING', 'WALLET', 'COD']),
})

const verifySchema = z.object({
  providerOrderId: z.string().min(1),
  providerPaymentId: z.string().min(1),
  signature: z.string().min(1),
})

/**
 * Starts a payment.
 *
 * The X-Idempotency-Key header makes a retried request return the original
 * attempt instead of creating a second one — so a dropped connection or an
 * impatient double-click cannot produce two charges.
 */
paymentRouter.post(
  '/initiate',
  optionalAuth,
  paymentLimiter,
  validateBody(initiateSchema),
  asyncHandler(async (req, res) => {
    const result = await service.initiatePayment({
      orderId: req.body.orderId,
      method: req.body.method,
      idempotencyKey: req.get('X-Idempotency-Key') ?? undefined,
    })
    return ok(res, result)
  }),
)

/**
 * Confirms a payment reported by the browser.
 *
 * The request body is a *claim*, not evidence. It is only believed once the
 * signature verifies against the gateway secret and the amount matches.
 */
paymentRouter.post(
  '/verify',
  optionalAuth,
  paymentLimiter,
  validateBody(verifySchema),
  asyncHandler(async (req, res) => {
    const result = await service.verifyAndCapture(req.body)
    return ok(res, {
      success: true,
      alreadyProcessed: result.alreadyProcessed,
      order: result.order,
      payment: result.payment,
    })
  }),
)

/**
 * Gateway webhook.
 *
 * No authentication middleware — the gateway cannot hold a token. The
 * signature over the raw body is the authentication, and duplicate deliveries
 * are absorbed by the unique event id in payment_webhook_events.
 */
paymentRouter.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const rawBody = getRawBody(req)
    if (!rawBody) throw new BadRequestError('Missing webhook body')

    const signature =
      req.get('x-razorpay-signature') ?? req.get('x-webhook-signature') ?? ''

    const result = await service.handleWebhook(rawBody, signature)

    // Always 200 on a valid signature, so the gateway stops retrying.
    return res.status(200).json({ success: true, ...result })
  }),
)

paymentRouter.get(
  '/history',
  requireAuth,
  validateQuery(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = validated<{ page: number; limit: number }>(req)
    const { payments, total } = await service.getPaymentHistoryForCustomer(
      req.user!.id,
      query,
    )
    return paginated(res, payments, total, query.page, query.limit)
  }),
)

paymentRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.id, order: { userId: req.user!.id } },
      include: {
        order: { select: { id: true, orderNumber: true, placedAt: true, status: true } },
        refunds: true,
      },
    })
    if (!payment) throw new NotFoundError('Payment')
    return ok(res, payment)
  }),
)

paymentRouter.post(
  '/refund-request',
  requireAuth,
  validateBody(
    z.object({
      orderId: z.string().min(1),
      reason: z.string().trim().min(5, 'Please tell us why.').max(500),
    }),
  ),
  asyncHandler(async (req, res) => {
    // Ownership check before anything else — a customer may only request a
    // refund against their own order.
    const order = await prisma.order.findFirst({
      where: { id: req.body.orderId, userId: req.user!.id },
      select: { id: true },
    })
    if (!order) throw new NotFoundError('Order')

    const refund = await service.requestRefund({
      orderId: req.body.orderId,
      reason: req.body.reason,
      requestedById: req.user!.id,
    })
    return ok(res, refund, { message: 'Refund requested. Our team will review it shortly.' })
  }),
)

/* ------------------------------------------------------------------ *
 * Local development helper
 * ------------------------------------------------------------------ */

/**
 * Produces the signature a real gateway would return, so the whole checkout
 * can be driven end to end offline. Registered only when the mock provider is
 * active, so it cannot exist on a store with real credentials.
 */
if (isMockProvider()) {
  paymentRouter.post(
    '/mock/sign',
    validateBody(
      z.object({ providerOrderId: z.string().min(1), providerPaymentId: z.string().min(1) }),
    ),
    asyncHandler(async (req, res) => {
      const provider = new MockPaymentProvider()
      return ok(res, {
        signature: provider.signForTest(req.body.providerOrderId, req.body.providerPaymentId),
        note: 'Mock signature for local testing only.',
      })
    }),
  )
}
