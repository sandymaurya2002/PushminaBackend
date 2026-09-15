import crypto from 'node:crypto'

/**
 * Opaque tokens for refresh sessions, password resets and email verification.
 *
 * Only the SHA-256 hash is ever persisted. A database leak therefore yields no
 * usable token, exactly as with passwords.
 */

export function generateToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('hex')
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** Constant-time compare, to avoid leaking information through timing. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  if (bufferA.length !== bufferB.length) return false
  return crypto.timingSafeEqual(bufferA, bufferB)
}

export function addDuration(from: Date, duration: string): Date {
  const match = /^(\d+)([smhdw])$/.exec(duration.trim())
  if (!match) throw new Error(`Unsupported duration: ${duration}`)

  const amount = Number(match[1])
  const unitMs: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  }
  return new Date(from.getTime() + amount * unitMs[match[2]])
}

/** PSH-104287 — matches the format already shown on the storefront. */
export function generateOrderNumber(): string {
  const suffix = crypto.randomInt(100_000, 999_999)
  return `PSH-${suffix}`
}

export function generateInvoiceNumber(sequence: number): string {
  const year = new Date().getFullYear()
  return `INV-${year}-${String(sequence).padStart(6, '0')}`
}
