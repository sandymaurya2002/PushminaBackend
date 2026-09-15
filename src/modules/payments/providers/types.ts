/**
 * Payment provider contract.
 *
 * Everything the rest of the application knows about payments is expressed
 * here. Swapping Razorpay for another gateway, or adding a second one for
 * international orders, means writing one more implementation of this
 * interface — no changes to orders, refunds, notifications or the admin panel.
 */

export interface CreatePaymentOrderInput {
  /** Rupees. The adapter converts to the gateway's own unit. */
  amount: number
  currency: string
  /** Our order number, sent for reconciliation on the gateway dashboard. */
  receipt: string
  notes?: Record<string, string>
}

export interface CreatePaymentOrderResult {
  providerOrderId: string
  amount: number
  currency: string
  /** Public key the browser checkout widget needs. Never the secret. */
  publicKey: string
}

export interface VerifyPaymentInput {
  providerOrderId: string
  providerPaymentId: string
  signature: string
}

export interface VerifiedPayment {
  valid: boolean
  providerPaymentId: string
  method?: string
  amount?: number
  status?: string
  raw?: unknown
}

export interface RefundInput {
  providerPaymentId: string
  amount: number
  notes?: Record<string, string>
}

export interface RefundResult {
  providerRefundId: string
  status: string
  amount: number
  raw?: unknown
}

export interface WebhookVerification {
  valid: boolean
  eventId: string
  eventType: string
  payload: Record<string, unknown>
}

export interface PaymentProvider {
  readonly name: string
  readonly isLive: boolean
  createOrder(input: CreatePaymentOrderInput): Promise<CreatePaymentOrderResult>
  verifyPayment(input: VerifyPaymentInput): Promise<VerifiedPayment>
  fetchPayment(providerPaymentId: string): Promise<VerifiedPayment>
  refund(input: RefundInput): Promise<RefundResult>
  verifyWebhook(rawBody: string, signature: string): WebhookVerification
}
