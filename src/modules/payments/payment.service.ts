import type { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma'
import { getPaymentProvider } from './providers'
import { toNumber, round2 } from '../../utils/money'
import { BadRequestError, NotFoundError, PaymentError } from '../../utils/errors'
import { logger } from '../../config/logger'
import { onOrderPaid, updateStatus } from '../orders/order.service'
import { notifyAdmins, notifyCustomer, notifyGuest } from '../notifications/notification.service'
import { templates } from '../email/templates'

/**
 * Payments.
 *
 * Three rules govern everything here:
 *
 *  1. The frontend is never believed. It reports that a payment happened; only
 *     a signature computed with the gateway secret proves it.
 *  2. Nothing is processed twice. Payment initiation is idempotent, and every
 *     webhook is recorded against a unique event id before it is acted upon.
 *  3. Order status and payment status move together, inside one transaction.
 */

const METHOD_MAP: Record<string, PaymentMethod> = {
  upi: 'UPI',
  card: 'CARD',
  netbanking: 'NETBANKING',
  wallet: 'WALLET',
  emi: 'CARD',
  cod: 'COD',
}

function mapMethod(raw?: string): PaymentMethod {
  return METHOD_MAP[(raw ?? '').toLowerCase()] ?? 'OTHER'
}

/* ------------------------------------------------------------------ *
 * Initiation
 * ------------------------------------------------------------------ */

export interface InitiatePaymentInput {
  orderId: string
  method: 'UPI' | 'CARD' | 'NETBANKING' | 'WALLET' | 'COD'
  idempotencyKey?: string
}

export async function initiatePayment(input: InitiatePaymentInput) {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { payments: true },
  })
  if (!order) throw new NotFoundError('Order')

  if (order.status === 'CANCELLED') {
    throw new BadRequestError('This order has been cancelled.')
  }

  // Already settled — returning success rather than erroring makes a double
  // click on "Pay" harmless.
  const captured = order.payments.find((payment) => payment.status === 'CAPTURED')
  if (captured) {
    return { alreadyPaid: true as const, payment: captured, order }
  }

  /* Idempotency: the same key always yields the same payment attempt, so a
     retried request after a dropped connection cannot create a second charge. */
  if (input.idempotencyKey) {
    const existing = await prisma.payment.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    })
    if (existing) {
      return {
        alreadyPaid: false as const,
        payment: existing,
        order,
        providerOrderId: existing.providerOrderId,
        publicKey: getPaymentProvider().name === 'razorpay' ? process.env.RAZORPAY_KEY_ID : 'mock',
        reused: true as const,
      }
    }
  }

  const amount = toNumber(order.total)

  /* Cash on delivery takes no money now. The order proceeds immediately and
     the payment row is left PENDING until the courier collects. */
  if (input.method === 'COD') {
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: 'cod',
        method: 'COD',
        status: 'PENDING',
        amount,
        currency: order.currency,
        idempotencyKey: input.idempotencyKey,
      },
    })

    await updateStatus(order.id, 'PLACED', { note: 'Cash on delivery — awaiting dispatch.' })
    await onOrderPaid(order.id)

    return { alreadyPaid: false as const, payment, order, cod: true as const }
  }

  const provider = getPaymentProvider()

  const providerOrder = await provider.createOrder({
    amount,
    currency: order.currency,
    receipt: order.orderNumber,
    notes: { orderId: order.id, orderNumber: order.orderNumber },
  })

  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: provider.name,
      providerOrderId: providerOrder.providerOrderId,
      method: input.method,
      status: 'CREATED',
      amount,
      currency: order.currency,
      idempotencyKey: input.idempotencyKey,
    },
  })

  logger.info({ orderId: order.id, paymentId: payment.id }, 'Payment initiated')

  return {
    alreadyPaid: false as const,
    payment,
    order,
    providerOrderId: providerOrder.providerOrderId,
    publicKey: providerOrder.publicKey,
    amount,
    currency: order.currency,
  }
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

export interface VerifyPaymentInput {
  providerOrderId: string
  providerPaymentId: string
  signature: string
}

/**
 * Called when the browser reports a completed payment.
 *
 * The client's claim is irrelevant until the signature verifies; the amount is
 * then re-checked against the order, because a valid signature for a ₹100
 * payment must not settle a ₹10,000 order.
 */
export async function verifyAndCapture(input: VerifyPaymentInput) {
  const payment = await prisma.payment.findFirst({
    where: { providerOrderId: input.providerOrderId },
    include: { order: true },
  })
  if (!payment) throw new NotFoundError('Payment')

  // A webhook may already have settled this. Say so rather than double-process.
  if (payment.status === 'CAPTURED') {
    return { payment, order: payment.order, alreadyProcessed: true as const }
  }

  const provider = getPaymentProvider()
  const verification = await provider.verifyPayment(input)

  if (!verification.valid) {
    await markFailed(payment.id, 'SIGNATURE_INVALID', 'Payment signature verification failed.')
    throw new PaymentError('We could not verify this payment. No money has been taken.')
  }

  if (
    verification.amount !== undefined &&
    Math.abs(verification.amount - toNumber(payment.amount)) > 0.01
  ) {
    await markFailed(
      payment.id,
      'AMOUNT_MISMATCH',
      `Gateway reported ₹${verification.amount} against an order of ₹${toNumber(payment.amount)}.`,
    )
    logger.error(
      { paymentId: payment.id, expected: toNumber(payment.amount), actual: verification.amount },
      'Payment amount mismatch — possible tampering',
    )
    throw new PaymentError('The payment amount did not match this order.')
  }

  const settled = await settlePayment(payment.id, {
    providerPaymentId: input.providerPaymentId,
    signature: input.signature,
    // Only overwrite the method when the gateway actually reports one — the
    // customer may pick a different instrument inside the payment widget than
    // the one they selected at checkout, and the gateway is authoritative.
    method: verification.method ? mapMethod(verification.method) : undefined,
    raw: verification.raw,
  })

  return { payment: settled.payment, order: settled.order, alreadyProcessed: false as const }
}

/**
 * The single place a payment becomes CAPTURED and its order moves forward.
 * Both the browser callback and the webhook funnel through here, so the two
 * paths can never disagree.
 */
async function settlePayment(
  paymentId: string,
  details: {
    providerPaymentId: string
    signature?: string
    method?: PaymentMethod
    raw?: unknown
  },
) {
  const result = await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction: a webhook may have landed in the
    // milliseconds since the caller checked.
    const current = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: true },
    })

    if (current.status === 'CAPTURED') {
      return { payment: current, order: current.order, wasAlready: true }
    }

    const payment = await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: 'CAPTURED',
        providerPaymentId: details.providerPaymentId,
        providerSignature: details.signature,
        ...(details.method ? { method: details.method } : {}),
        capturedAt: new Date(),
        authorizedAt: new Date(),
        rawPayload: (details.raw ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })

    // The order must be advanced *before* it is read back for the response.
    // Returning the copy included on the payment row would hand the caller a
    // pre-update snapshot, so the payment-success page would render the order
    // as still PENDING and read as a failure to the customer.
    let order = current.order

    if (current.order.status === 'PENDING') {
      order = await tx.order.update({
        where: { id: current.orderId },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      })
      await tx.orderStatusHistory.create({
        data: {
          orderId: current.orderId,
          fromStatus: 'PENDING',
          toStatus: 'CONFIRMED',
          note: 'Payment captured.',
        },
      })
    }

    return { payment, order, wasAlready: false }
  })

  if (!result.wasAlready) {
    await afterCapture(result.payment.id)
  }

  return result
}

async function afterCapture(paymentId: string): Promise<void> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { order: true },
  })
  if (!payment) return

  const amount = toNumber(payment.amount)
  const email = templates.paymentSuccessful({
    orderNumber: payment.order.orderNumber,
    amount,
    method: payment.method,
  })

  if (payment.order.userId) {
    await notifyCustomer({
      userId: payment.order.userId,
      type: 'PAYMENT_SUCCESSFUL',
      title: 'Payment received',
      body: `Payment of ₹${amount.toLocaleString('en-IN')} for ${payment.order.orderNumber} was successful.`,
      link: `/account/orders/${payment.orderId}`,
      data: { orderId: payment.orderId, paymentId: payment.id },
      email: { to: payment.order.email, template: 'payment-successful', ...email },
    })
  } else {
    await notifyGuest({ to: payment.order.email, template: 'payment-successful', ...email })
  }

  await notifyAdmins({
    type: 'ADMIN_NEW_PAYMENT',
    title: 'Payment received',
    body: `₹${amount.toLocaleString('en-IN')} for ${payment.order.orderNumber}`,
    link: `/payments/${payment.id}`,
    data: { paymentId: payment.id, orderId: payment.orderId },
    permission: 'payments.view',
  })

  await onOrderPaid(payment.orderId)
}

export async function markFailed(
  paymentId: string,
  code: string,
  reason: string,
): Promise<void> {
  const payment = await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'FAILED',
      failureCode: code,
      failureReason: reason,
      failedAt: new Date(),
    },
    include: { order: true },
  })

  const email = templates.paymentFailed({
    orderNumber: payment.order.orderNumber,
    reason,
  })

  if (payment.order.userId) {
    await notifyCustomer({
      userId: payment.order.userId,
      type: 'PAYMENT_FAILED',
      title: 'Payment unsuccessful',
      body: `Payment for ${payment.order.orderNumber} could not be completed. No money has been taken.`,
      link: `/account/orders/${payment.orderId}`,
      data: { orderId: payment.orderId },
      email: { to: payment.order.email, template: 'payment-failed', ...email },
    })
  } else {
    await notifyGuest({ to: payment.order.email, template: 'payment-failed', ...email })
  }

  await notifyAdmins({
    type: 'ADMIN_PAYMENT_FAILED',
    title: 'Payment failed',
    body: `${payment.order.orderNumber} — ${reason}`,
    link: `/payments/${payment.id}`,
    data: { paymentId: payment.id },
    permission: 'payments.view',
  })
}

/* ------------------------------------------------------------------ *
 * Webhooks
 * ------------------------------------------------------------------ */

/**
 * Webhook ingestion.
 *
 * The event is written to payment_webhook_events *first*, against a unique
 * event id. A replayed or duplicated delivery therefore collides on that
 * unique constraint and is recorded as DUPLICATE without being acted on —
 * which is what stops a retried webhook from capturing a payment twice.
 *
 * Always answers 200 once the signature is valid: a non-2xx makes the gateway
 * retry, and retrying a webhook we merely failed to *handle* achieves nothing.
 */
export async function handleWebhook(rawBody: string, signature: string) {
  const provider = getPaymentProvider()
  const verification = provider.verifyWebhook(rawBody, signature)

  if (!verification.valid) {
    logger.warn('Rejected webhook with an invalid signature')
    throw new PaymentError('Invalid webhook signature')
  }

  const existing = await prisma.paymentWebhookEvent.findUnique({
    where: { eventId: verification.eventId },
    select: { id: true, status: true },
  })

  if (existing) {
    logger.info({ eventId: verification.eventId }, 'Duplicate webhook ignored')
    return { duplicate: true, eventId: verification.eventId }
  }

  const event = await prisma.paymentWebhookEvent.create({
    data: {
      provider: provider.name,
      eventId: verification.eventId,
      eventType: verification.eventType,
      signature,
      payload: verification.payload as Prisma.InputJsonValue,
      status: 'RECEIVED',
    },
  })

  try {
    await processWebhookEvent(verification.eventType, verification.payload)
    await prisma.paymentWebhookEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    })
    return { duplicate: false, eventId: verification.eventId, processed: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error({ err: error, eventId: verification.eventId }, 'Webhook processing failed')
    await prisma.paymentWebhookEvent.update({
      where: { id: event.id },
      data: { status: 'FAILED', error: message, processedAt: new Date() },
    })
    // Recorded, not rethrown: the delivery itself was valid.
    return { duplicate: false, eventId: verification.eventId, processed: false }
  }
}

async function processWebhookEvent(
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const entity = (payload.payload as Record<string, unknown>) ?? {}
  const paymentEntity = ((entity.payment as Record<string, unknown>)?.entity ??
    {}) as Record<string, unknown>
  const refundEntity = ((entity.refund as Record<string, unknown>)?.entity ??
    {}) as Record<string, unknown>

  switch (eventType) {
    case 'payment.captured':
    case 'payment.authorized': {
      const providerOrderId = String(paymentEntity.order_id ?? '')
      const providerPaymentId = String(paymentEntity.id ?? '')
      if (!providerOrderId || !providerPaymentId) return

      const payment = await prisma.payment.findFirst({
        where: { providerOrderId },
        select: { id: true, status: true },
      })
      if (!payment || payment.status === 'CAPTURED') return

      await settlePayment(payment.id, {
        providerPaymentId,
        method: mapMethod(String(paymentEntity.method ?? '')),
        raw: paymentEntity,
      })
      break
    }

    case 'payment.failed': {
      const providerOrderId = String(paymentEntity.order_id ?? '')
      if (!providerOrderId) return

      const payment = await prisma.payment.findFirst({
        where: { providerOrderId },
        select: { id: true, status: true },
      })
      // A payment already captured must never be flipped to failed by a late
      // or out-of-order delivery.
      if (!payment || payment.status === 'CAPTURED') return

      await markFailed(
        payment.id,
        String(paymentEntity.error_code ?? 'GATEWAY_FAILURE'),
        String(paymentEntity.error_description ?? 'The payment was declined.'),
      )
      break
    }

    case 'refund.processed': {
      const providerRefundId = String(refundEntity.id ?? '')
      if (!providerRefundId) return

      const refund = await prisma.refund.findUnique({
        where: { providerRefundId },
        select: { id: true, status: true },
      })
      if (!refund || refund.status === 'COMPLETED') return

      await completeRefund(refund.id)
      break
    }

    default:
      logger.debug({ eventType }, 'Unhandled webhook event type')
  }
}

/* ------------------------------------------------------------------ *
 * Refunds
 * ------------------------------------------------------------------ */

export async function requestRefund(input: {
  orderId: string
  amount?: number
  reason?: string
  requestedById?: string
}) {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { payments: { where: { status: 'CAPTURED' } }, refunds: true },
  })
  if (!order) throw new NotFoundError('Order')

  const payment = order.payments[0]
  if (!payment) {
    throw new BadRequestError('There is no captured payment on this order to refund.')
  }

  const alreadyRefunded = order.refunds
    .filter((refund) => ['COMPLETED', 'PROCESSING', 'APPROVED'].includes(refund.status))
    .reduce((sum, refund) => sum + toNumber(refund.amount), 0)

  const refundable = round2(toNumber(payment.amount) - alreadyRefunded)
  const amount = input.amount ?? refundable

  if (amount <= 0) throw new BadRequestError('There is nothing left to refund on this order.')
  if (amount > refundable) {
    throw new BadRequestError(
      `Only ₹${refundable.toLocaleString('en-IN')} remains refundable on this order.`,
    )
  }

  const refund = await prisma.refund.create({
    data: {
      orderId: order.id,
      paymentId: payment.id,
      provider: payment.provider,
      amount,
      reason: input.reason,
      status: 'REQUESTED',
      requestedById: input.requestedById,
    },
  })

  await notifyAdmins({
    type: 'ADMIN_REFUND_REQUEST',
    title: 'Refund requested',
    body: `₹${amount.toLocaleString('en-IN')} on order ${order.orderNumber}`,
    link: `/refunds/${refund.id}`,
    data: { refundId: refund.id, orderId: order.id },
    permission: 'refunds.view',
  })

  return refund
}

/** Approving actually calls the gateway; nothing is refunded before this. */
export async function approveRefund(refundId: string, adminId: string) {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: { payment: true, order: true },
  })
  if (!refund) throw new NotFoundError('Refund')
  if (refund.status !== 'REQUESTED') {
    throw new BadRequestError(`This refund is already ${refund.status.toLowerCase()}.`)
  }
  if (!refund.payment?.providerPaymentId) {
    throw new BadRequestError('The original payment has no gateway reference to refund against.')
  }

  await prisma.refund.update({
    where: { id: refundId },
    data: { status: 'PROCESSING', processedById: adminId },
  })

  try {
    const provider = getPaymentProvider()
    const result = await provider.refund({
      providerPaymentId: refund.payment.providerPaymentId,
      amount: toNumber(refund.amount),
      notes: { orderNumber: refund.order.orderNumber, refundId },
    })

    await prisma.refund.update({
      where: { id: refundId },
      data: {
        providerRefundId: result.providerRefundId,
        rawPayload: (result.raw ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })

    if (result.status === 'processed') {
      await completeRefund(refundId)
    }

    return prisma.refund.findUniqueOrThrow({ where: { id: refundId } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.refund.update({
      where: { id: refundId },
      data: { status: 'FAILED', failureReason: message },
    })
    throw error
  }
}

export async function completeRefund(refundId: string): Promise<void> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: { order: true, payment: true },
  })
  if (!refund || refund.status === 'COMPLETED') return

  await prisma.$transaction(async (tx) => {
    await tx.refund.update({
      where: { id: refundId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })

    if (refund.paymentId && refund.payment) {
      const refunded = round2(toNumber(refund.payment.amountRefunded) + toNumber(refund.amount))
      const fullyRefunded = refunded >= toNumber(refund.payment.amount) - 0.01

      await tx.payment.update({
        where: { id: refund.paymentId },
        data: {
          amountRefunded: refunded,
          status: (fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED') as PaymentStatus,
        },
      })
    }
  })

  const amount = toNumber(refund.amount)
  const email = templates.refundCompleted({
    orderNumber: refund.order.orderNumber,
    amount,
  })

  if (refund.order.userId) {
    await notifyCustomer({
      userId: refund.order.userId,
      type: 'REFUND_COMPLETED',
      title: 'Refund processed',
      body: `₹${amount.toLocaleString('en-IN')} has been refunded for ${refund.order.orderNumber}.`,
      link: `/account/orders/${refund.orderId}`,
      data: { refundId, orderId: refund.orderId },
      email: { to: refund.order.email, template: 'refund-completed', ...email },
    })
  } else {
    await notifyGuest({ to: refund.order.email, template: 'refund-completed', ...email })
  }
}

export async function rejectRefund(refundId: string, adminId: string, reason: string) {
  const refund = await prisma.refund.findUnique({ where: { id: refundId } })
  if (!refund) throw new NotFoundError('Refund')
  if (refund.status !== 'REQUESTED') {
    throw new BadRequestError(`This refund is already ${refund.status.toLowerCase()}.`)
  }

  return prisma.refund.update({
    where: { id: refundId },
    data: { status: 'REJECTED', processedById: adminId, notes: reason },
  })
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function getPaymentHistoryForCustomer(
  userId: string,
  options: { page: number; limit: number },
) {
  const where: Prisma.PaymentWhereInput = { order: { userId } }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        order: { select: { id: true, orderNumber: true, placedAt: true, status: true } },
        refunds: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (options.page - 1) * options.limit,
      take: options.limit,
    }),
    prisma.payment.count({ where }),
  ])

  return { payments, total }
}
