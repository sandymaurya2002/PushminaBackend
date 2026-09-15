import rateLimit, { type Options } from 'express-rate-limit'
import { env, isTest } from '../config/env'

/**
 * Rate limiting.
 *
 * The in-memory store is correct for a single local process. Behind more than
 * one instance, swap in a shared Redis store — the limiter definitions below do
 * not otherwise change.
 */

function build(options: Partial<Options>) {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Rate limits would make the test suite flaky and prove nothing.
    skip: () => isTest,
    handler: (_req, res, _next, opts) => {
      res.status(opts.statusCode).json({
        success: false,
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many requests. Please wait a moment and try again.',
        },
      })
    },
    ...options,
  })
}

/** Broad ceiling applied to the whole API. */
export const generalLimiter = build({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
})

/** Tight limit on credential endpoints to blunt password spraying. */
export const authLimiter = build({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
})

/** Payment initiation — generous enough for genuine retries, no more. */
export const paymentLimiter = build({
  windowMs: 60_000,
  limit: 20,
})

/** Public write endpoints open to anonymous visitors. */
export const publicWriteLimiter = build({
  windowMs: 60 * 60 * 1000,
  limit: 30,
})

export const uploadLimiter = build({
  windowMs: 60_000,
  limit: 60,
})

/** Instant-search fires on every keystroke after debounce. */
export const searchLimiter = build({
  windowMs: 60_000,
  limit: 240,
})
