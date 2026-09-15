import crypto from 'node:crypto'
import { env } from '../../../config/env'
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
 * Offline payment provider.
 *
 * Active whenever Razorpay credentials are absent, which is the default for
 * local development. It implements the same interface with the same signature
 * arithmetic, so the entire order → payment → refund lifecycle — including
 * verification failures and webhook deduplication — is exercisable on a laptop
 * with no internet connection and no merchant account.
 *
 * It refuses to start if NODE_ENV is production: silently accepting fake
 * payments on a live store would be catastrophic.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock'
  readonly isLive = false

  private secret = 'mock_secret_do_not_use_in_production'

  constructor() {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'Refusing to start: the mock payment provider cannot run in production. ' +
          'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
      )
    }
    logger.warn(
      'Payments running in MOCK mode — no real money moves. ' +
        'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env to go live.',
    )
  }

  async createOrder(input: CreatePaymentOrderInput): Promise<CreatePaymentOrderResult> {
    return {
      providerOrderId: `mock_order_${crypto.randomBytes(10).toString('hex')}`,
      amount: input.amount,
      currency: input.currency,
      publicKey: 'mock_key_local_development',
    }
  }

  /** Same HMAC construction as Razorpay, so the client flow is identical. */
  async verifyPayment(input: VerifyPaymentInput): Promise<VerifiedPayment> {
    const expected = crypto
      .createHmac('sha256', this.secret)
      .update(`${input.providerOrderId}|${input.providerPaymentId}`)
      .digest('hex')

    const provided = Buffer.from(input.signature)
    const computed = Buffer.from(expected)
    const valid =
      provided.length === computed.length && crypto.timingSafeEqual(provided, computed)

    // No `method` is reported: offline there is no real gateway widget to
    // choose one, so the method the customer picked at checkout is preserved
    // rather than being overwritten with a guess.
    return {
      valid,
      providerPaymentId: input.providerPaymentId,
      status: valid ? 'captured' : 'failed',
    }
  }

  async fetchPayment(providerPaymentId: string): Promise<VerifiedPayment> {
    return { valid: true, providerPaymentId, status: 'captured' }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return {
      providerRefundId: `mock_rfnd_${crypto.randomBytes(8).toString('hex')}`,
      status: 'processed',
      amount: input.amount,
    }
  }

  verifyWebhook(rawBody: string): WebhookVerification {
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      return { valid: false, eventId: '', eventType: '', payload: {} }
    }
    return {
      valid: true,
      eventId: String(payload.id ?? crypto.randomUUID()),
      eventType: String(payload.event ?? 'unknown'),
      payload,
    }
  }

  /**
   * Test helper: produces the signature a real gateway would return, so the
   * checkout flow can be driven end to end from the storefront or a script.
   */
  signForTest(providerOrderId: string, providerPaymentId: string): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`${providerOrderId}|${providerPaymentId}`)
      .digest('hex')
  }
}
