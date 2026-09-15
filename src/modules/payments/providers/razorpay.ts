import crypto from 'node:crypto'
import Razorpay from 'razorpay'
import { env } from '../../../config/env'
import { fromPaise, toPaise } from '../../../utils/money'
import { PaymentError } from '../../../utils/errors'
import { logger } from '../../../config/logger'
import type {
  CreatePaymentOrderInput,
  CreatePaymentOrderResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  VerifiedPayment,
  VerifyPaymentInput,
  WebhookVerification,
} from './types'

/**
 * Razorpay adapter.
 *
 * Razorpay works in paise; everything above this file works in rupees. The
 * conversion happens only here.
 *
 * Signature verification is the security boundary: the browser tells us a
 * payment succeeded, but only an HMAC computed with the secret — which the
 * browser never sees — proves it.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay'
  readonly isLive = true

  private client: Razorpay

  constructor() {
    this.client = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET,
    })
  }

  async createOrder(input: CreatePaymentOrderInput): Promise<CreatePaymentOrderResult> {
    try {
      const order = await this.client.orders.create({
        amount: toPaise(input.amount),
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes,
      })

      return {
        providerOrderId: order.id,
        amount: fromPaise(Number(order.amount)),
        currency: order.currency,
        publicKey: env.RAZORPAY_KEY_ID,
      }
    } catch (error) {
      logger.error({ err: error }, 'Razorpay order creation failed')
      throw new PaymentError('Could not start the payment. Please try again.')
    }
  }

  /**
   * HMAC-SHA256 over `order_id|payment_id`, keyed with the secret.
   *
   * Compared in constant time: a plain `===` on an HMAC leaks, through timing,
   * how many leading bytes were correct, which is enough to forge one byte at
   * a time.
   */
  async verifyPayment(input: VerifyPaymentInput): Promise<VerifiedPayment> {
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${input.providerOrderId}|${input.providerPaymentId}`)
      .digest('hex')

    const provided = Buffer.from(input.signature)
    const computed = Buffer.from(expected)

    const valid =
      provided.length === computed.length && crypto.timingSafeEqual(provided, computed)

    if (!valid) {
      logger.warn(
        { providerOrderId: input.providerOrderId },
        'Razorpay signature verification failed',
      )
      return { valid: false, providerPaymentId: input.providerPaymentId }
    }

    // Signature proves authenticity; the authoritative amount and status still
    // come from the gateway, never from the client.
    return this.fetchPayment(input.providerPaymentId)
  }

  async fetchPayment(providerPaymentId: string): Promise<VerifiedPayment> {
    try {
      const payment = await this.client.payments.fetch(providerPaymentId)
      return {
        valid: true,
        providerPaymentId,
        method: String(payment.method ?? 'other'),
        amount: fromPaise(Number(payment.amount)),
        status: String(payment.status),
        raw: payment,
      }
    } catch (error) {
      logger.error({ err: error, providerPaymentId }, 'Razorpay payment fetch failed')
      throw new PaymentError('Could not confirm the payment with the gateway.')
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    try {
      const refund = await this.client.payments.refund(input.providerPaymentId, {
        amount: toPaise(input.amount),
        notes: input.notes,
      })

      return {
        providerRefundId: refund.id,
        status: String(refund.status),
        amount: fromPaise(Number(refund.amount)),
        raw: refund,
      }
    } catch (error) {
      logger.error({ err: error }, 'Razorpay refund failed')
      throw new PaymentError('The refund could not be processed by the gateway.')
    }
  }

  /**
   * Webhook signature is an HMAC over the raw request body. Verifying against
   * re-serialised JSON would fail, which is why app.ts preserves the original
   * bytes on webhook routes.
   */
  verifyWebhook(rawBody: string, signature: string): WebhookVerification {
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex')

    const provided = Buffer.from(signature ?? '')
    const computed = Buffer.from(expected)

    const valid =
      provided.length === computed.length && crypto.timingSafeEqual(provided, computed)

    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return { valid: false, eventId: '', eventType: '', payload: {} }
    }

    return {
      valid,
      // Razorpay's x-razorpay-event-id header is preferred, but the payload
      // carries a stable identity too; either is enough to deduplicate.
      eventId: String(payload.id ?? `${payload.event}-${payload.created_at}`),
      eventType: String(payload.event ?? 'unknown'),
      payload,
    }
  }
}
