import { paymentsLive } from '../../../config/env'
import { MockPaymentProvider } from './mock'
import { RazorpayProvider } from './razorpay'
import type { PaymentProvider } from './types'

let instance: PaymentProvider | null = null

/**
 * Resolves the active provider once, lazily.
 *
 * Razorpay when credentials are present, the offline mock otherwise — so a
 * fresh clone runs the whole checkout without any external account.
 */
export function getPaymentProvider(): PaymentProvider {
  if (!instance) {
    instance = paymentsLive ? new RazorpayProvider() : new MockPaymentProvider()
  }
  return instance
}

export function isMockProvider(): boolean {
  return !paymentsLive
}

export type { PaymentProvider } from './types'
