import clsx, { type ClassValue } from 'clsx'

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

export function formatPrice(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return inr.format(Number(value))
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value)
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** "3 days ago" — easier to scan than a timestamp in an activity list. */
export function relativeTime(value: string | Date): string {
  const date = new Date(value)
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ]

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  for (const [unit, secondsInUnit] of units) {
    if (Math.abs(seconds) >= secondsInUnit) {
      return formatter.format(-Math.round(seconds / secondsInUnit), unit)
    }
  }
  return 'just now'
}

export function toSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export function pluralise(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`)
}

/** Debounce for search inputs, so every keystroke is not a request. */
export function debounce<T extends (...args: never[]) => void>(fn: T, delay = 300): T {
  let timer: ReturnType<typeof setTimeout>
  return ((...args: Parameters<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }) as T
}

export const ORDER_STATUS_TONE: Record<string, string> = {
  PENDING: 'border-line-strong text-mocha',
  PLACED: 'border-line-strong text-mocha',
  CONFIRMED: 'border-gold/50 text-gold',
  PROCESSING: 'border-gold/50 text-gold',
  SHIPPED: 'border-gold/50 text-gold',
  DELIVERED: 'border-success/40 text-success',
  CANCELLED: 'border-burgundy/40 text-burgundy',
  RETURNED: 'border-burgundy/40 text-burgundy',
}

export const PAYMENT_STATUS_TONE: Record<string, string> = {
  CREATED: 'border-line-strong text-taupe',
  PENDING: 'border-line-strong text-mocha',
  AUTHORIZED: 'border-gold/50 text-gold',
  CAPTURED: 'border-success/40 text-success',
  FAILED: 'border-burgundy/40 text-burgundy',
  CANCELLED: 'border-line-strong text-taupe',
  REFUNDED: 'border-burgundy/40 text-burgundy',
  PARTIALLY_REFUNDED: 'border-burgundy/40 text-burgundy',
}

export const PRODUCT_STATUS_TONE: Record<string, string> = {
  DRAFT: 'border-line-strong text-taupe',
  PUBLISHED: 'border-success/40 text-success',
  ARCHIVED: 'border-burgundy/40 text-burgundy',
  SCHEDULED: 'border-gold/50 text-gold',
}
