import { Prisma } from '@prisma/client'

/**
 * Money helpers.
 *
 * The database stores rupees as Decimal(12,2). The API speaks rupees as plain
 * numbers, matching the storefront. Razorpay speaks paise as integers. The
 * conversion between the last two happens only here and in the payment
 * provider, never scattered through business logic.
 */

export type Money = Prisma.Decimal | number | string

export function toNumber(value: Money | null | undefined): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  return value.toNumber()
}

export function toDecimal(value: Money): Prisma.Decimal {
  return new Prisma.Decimal(typeof value === 'number' ? value.toFixed(2) : value)
}

/** Rupees → paise, for the payment gateway. */
export function toPaise(value: Money): number {
  return Math.round(toNumber(value) * 100)
}

/** Paise → rupees, when reading a gateway payload back. */
export function fromPaise(paise: number): number {
  return Math.round(paise) / 100
}

/** Rounds to 2dp, avoiding the classic 0.1 + 0.2 float artefacts. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function formatINR(value: Money): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(toNumber(value))
}

export function discountPercent(price: Money, compareAtPrice?: Money | null): number {
  const current = toNumber(price)
  const was = toNumber(compareAtPrice)
  if (!was || was <= current) return 0
  return Math.round(((was - current) / was) * 100)
}
